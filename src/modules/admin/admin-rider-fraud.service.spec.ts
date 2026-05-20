import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { LedgerService } from '../finance/ledger.service';
import { JwtRevocationService } from '../auth/jwt-revocation.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { AdminRiderFraudService } from './admin-rider-fraud.service';

describe('AdminRiderFraudService', () => {
  let service: AdminRiderFraudService;
  let prisma: {
    order: { findUnique: jest.Mock; updateMany: jest.Mock };
    rider: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let ledger: { recordTransaction: jest.Mock };
  let jwtRevocation: { revokeUser: jest.Mock };

  beforeEach(async () => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      rider: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };
    ledger = { recordTransaction: jest.fn().mockResolvedValue(undefined) };
    jwtRevocation = { revokeUser: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        AdminRiderFraudService,
        { provide: PrismaService, useValue: prisma },
        { provide: LedgerService, useValue: ledger },
        { provide: JwtRevocationService, useValue: jwtRevocation },
        pinoLoggerProvider(AdminRiderFraudService.name),
      ],
    }).compile();

    service = module.get(AdminRiderFraudService);
  });

  function pickedUpOrder(overrides: Record<string, unknown> = {}) {
    prisma.order.findUnique.mockResolvedValue({
      id: 'o-1',
      code: 'TC-1',
      status: OrderStatus.PICKED_UP,
      vendorId: 'v-1',
      riderId: 'r-1',
      userId: 'u-1',
      subtotalXAF: 4500,
      commissionXAF: 270,
      totalXAF: 4900,
      paymentStatus: PaymentStatus.PAID,
      ...overrides,
    });
  }

  describe('resolveRiderFraud', () => {
    it('happy path: refund queued + vendor compensated + rider suspended', async () => {
      pickedUpOrder();
      prisma.rider.findUnique.mockResolvedValue({ userId: 'rider-user-1' });

      const result = await service.resolveRiderFraud('o-1', 'admin-1', {
        riderAction: 'SUSPEND',
        vendorCompensation: true,
        consumerRefund: true,
        note: 'Rider unreachable after pickup, food disappeared',
      });

      // Order cancelled + paymentStatus → REFUND_PENDING
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'o-1', status: OrderStatus.PICKED_UP },
        data: expect.objectContaining({
          status: OrderStatus.CANCELLED,
          paymentStatus: PaymentStatus.REFUND_PENDING,
          refusalReason: expect.stringContaining('RIDER_FRAUD'),
        }),
      });

      // Vendor compensation ledger entry (4500 - 270 = 4230)
      expect(ledger.recordTransaction).toHaveBeenCalledTimes(1);
      const [input] = ledger.recordTransaction.mock.calls[0];
      expect(input.eventType).toBe('ADJUSTMENT');
      expect(input.entries).toEqual([
        expect.objectContaining({ account: 'PLATFORM_REVENUE', amountXAF: 4230 }),
        expect.objectContaining({ account: 'VENDOR_PAYABLE', amountXAF: -4230 }),
      ]);

      // Rider suspended + JWT revoked
      expect(prisma.rider.update).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: { status: 'SUSPENDED' },
      });
      expect(jwtRevocation.revokeUser).toHaveBeenCalledWith('rider-user-1');

      expect(result).toMatchObject({
        orderStatus: 'CANCELLED',
        consumerRefundQueued: true,
        vendorCompensationXAF: 4230,
        riderSuspended: true,
      });
    });

    it('WARN action decrements reliabilityScore instead of suspending', async () => {
      pickedUpOrder();

      await service.resolveRiderFraud('o-1', 'admin-1', {
        riderAction: 'WARN',
        vendorCompensation: false,
        consumerRefund: false,
        note: 'Late delivery, no fraud',
      });

      expect(prisma.rider.update).not.toHaveBeenCalled();
      expect(jwtRevocation.revokeUser).not.toHaveBeenCalled();
      expect(prisma.rider.updateMany).toHaveBeenCalledWith({
        where: { id: 'r-1' },
        data: { reliabilityScore: { decrement: 20 } },
      });
      // No ledger entry without compensation
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });

    it('skips refund queuing when consumerRefund=false', async () => {
      pickedUpOrder();
      await service.resolveRiderFraud('o-1', 'admin-1', {
        riderAction: 'WARN',
        vendorCompensation: false,
        consumerRefund: false,
        note: 'GPS glitch, no harm',
      });
      const data = prisma.order.updateMany.mock.calls[0][0].data;
      expect(data.paymentStatus).toBeUndefined();
    });

    it('skips vendor compensation when vendorCompensation=false', async () => {
      pickedUpOrder();
      await service.resolveRiderFraud('o-1', 'admin-1', {
        riderAction: 'WARN',
        vendorCompensation: false,
        consumerRefund: true,
        note: 'note',
      });
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });

    it('throws 404 when order does not exist', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(
        service.resolveRiderFraud('o-missing', 'admin-1', {
          riderAction: 'WARN',
          vendorCompensation: false,
          consumerRefund: false,
          note: 'note',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws 409 when order is not in PICKED_UP', async () => {
      pickedUpOrder({ status: OrderStatus.DELIVERED });
      await expect(
        service.resolveRiderFraud('o-1', 'admin-1', {
          riderAction: 'WARN',
          vendorCompensation: false,
          consumerRefund: false,
          note: 'note',
        }),
      ).rejects.toMatchObject({ response: { code: 'order_not_in_pickup' } });
    });

    it('throws 409 when order has no rider assigned', async () => {
      pickedUpOrder({ riderId: null });
      await expect(
        service.resolveRiderFraud('o-1', 'admin-1', {
          riderAction: 'SUSPEND',
          vendorCompensation: false,
          consumerRefund: false,
          note: 'note',
        }),
      ).rejects.toMatchObject({ response: { code: 'order_has_no_rider' } });
    });

    it('throws 409 when vendorCompensation requested but commissionXAF is null (legacy order)', async () => {
      pickedUpOrder({ commissionXAF: null });
      await expect(
        service.resolveRiderFraud('o-1', 'admin-1', {
          riderAction: 'WARN',
          vendorCompensation: true,
          consumerRefund: false,
          note: 'note',
        }),
      ).rejects.toMatchObject({ response: { code: 'order_missing_finance_snapshot' } });
    });

    it('lost-race short-circuit: updateMany count=0 → 409, no rider/ledger writes', async () => {
      pickedUpOrder();
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.resolveRiderFraud('o-1', 'admin-1', {
          riderAction: 'SUSPEND',
          vendorCompensation: true,
          consumerRefund: true,
          note: 'note',
        }),
      ).rejects.toMatchObject({ response: { code: 'order_state_changed' } });
    });
  });
});
