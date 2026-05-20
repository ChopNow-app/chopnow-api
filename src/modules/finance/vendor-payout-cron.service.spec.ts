import { Test } from '@nestjs/testing';
import { VendorType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { FinanceService, type VendorBalance } from './finance.service';
import { LedgerService } from './ledger.service';
import { VendorPayoutCronService } from './vendor-payout-cron.service';

function balance(over: Partial<VendorBalance> = {}): VendorBalance {
  return {
    vendorId: 'v-1',
    name: 'Vendor 1',
    type: VendorType.RESTAURANT,
    balanceXAF: 0,
    components: { grossXAF: 0, commissionXAF: 0, penaltyXAF: 0, adjustmentsXAF: 0 },
    lastPayoutAt: null,
    lastPayoutId: null,
    isTrusted: false,
    ...over,
  };
}

describe('VendorPayoutCronService', () => {
  let service: VendorPayoutCronService;
  let prisma: {
    vendor: { findMany: jest.Mock; findUnique: jest.Mock };
    vendorPayout: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
    order: { count: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let finance: { getVendorBalance: jest.Mock };
  let ledger: { recordTransaction: jest.Mock };

  beforeEach(async () => {
    prisma = {
      vendor: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ createdAt: new Date('2026-04-01') }),
      },
      vendorPayout: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'payout-1', ...data })),
      },
      order: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };
    finance = { getVendorBalance: jest.fn() };
    ledger = { recordTransaction: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        VendorPayoutCronService,
        { provide: PrismaService, useValue: prisma },
        { provide: FinanceService, useValue: finance },
        { provide: LedgerService, useValue: ledger },
        pinoLoggerProvider(VendorPayoutCronService.name),
      ],
    }).compile();

    service = module.get(VendorPayoutCronService);
  });

  describe('tryScheduleVendorPayout', () => {
    const scheduledFor = new Date('2026-05-24T02:00:00Z');

    it('schedules a payout + writes paired ledger entries + tags orders, when balance >= minimum', async () => {
      finance.getVendorBalance.mockResolvedValue(
        balance({
          balanceXAF: 4230,
          components: { grossXAF: 4500, commissionXAF: 270, penaltyXAF: 0, adjustmentsXAF: 0 },
        }),
      );

      const result = await service.tryScheduleVendorPayout('v-1', '+237670000111', scheduledFor);

      expect(result).toMatchObject({ outcome: 'scheduled', netXAF: 4230 });

      expect(prisma.vendorPayout.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          vendorId: 'v-1',
          netXAF: 4230,
          grossXAF: 4500,
          commissionXAF: 270,
          momoPhone: '+237670000111',
          scheduledFor,
        }),
      });

      // Paired ledger entries
      expect(ledger.recordTransaction).toHaveBeenCalledTimes(1);
      const [input, tx] = ledger.recordTransaction.mock.calls[0];
      expect(input.eventId).toBe('vendor_payout:payout-1');
      expect(input.eventType).toBe('VENDOR_PAYOUT');
      expect(input.entries).toEqual([
        expect.objectContaining({
          account: 'VENDOR_PAYABLE',
          amountXAF: 4230,
          vendorId: 'v-1',
          payoutId: 'payout-1',
        }),
        expect.objectContaining({
          account: 'CAMPAY_FLOAT',
          amountXAF: -4230,
          vendorId: 'v-1',
          payoutId: 'payout-1',
        }),
      ]);
      expect(tx).toBe(prisma); // inside the same Prisma transaction

      // Orders in the period get tagged with the new payoutId
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            vendorId: 'v-1',
            payoutId: null,
          }),
          data: { payoutId: 'payout-1' },
        }),
      );
    });

    it('skips below_minimum when balance < 500 FCFA', async () => {
      finance.getVendorBalance.mockResolvedValue(balance({ balanceXAF: 200 }));
      const result = await service.tryScheduleVendorPayout('v-1', '+237670000111', scheduledFor);
      expect(result).toMatchObject({ outcome: 'below_minimum', balanceXAF: 200 });
      expect(prisma.vendorPayout.create).not.toHaveBeenCalled();
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });

    it('skips negative_or_zero_balance when balance <= 0 (e.g. unsettled penalty)', async () => {
      finance.getVendorBalance.mockResolvedValue(balance({ balanceXAF: -200 }));
      const result = await service.tryScheduleVendorPayout('v-1', '+237670000111', scheduledFor);
      expect(result).toMatchObject({ outcome: 'negative_or_zero_balance', balanceXAF: -200 });
      expect(prisma.vendorPayout.create).not.toHaveBeenCalled();
    });

    it('skips open_disputes when the vendor has any REFUND_PENDING order (#205)', async () => {
      finance.getVendorBalance.mockResolvedValue(balance({ balanceXAF: 4230 }));
      prisma.order.count.mockResolvedValue(1);
      const result = await service.tryScheduleVendorPayout('v-1', '+237670000111', scheduledFor);
      expect(result).toMatchObject({ outcome: 'open_disputes' });
      expect(prisma.vendorPayout.create).not.toHaveBeenCalled();
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });

    it('returns already_scheduled when a payout for (vendorId, periodStart) already exists (idempotent re-run)', async () => {
      finance.getVendorBalance.mockResolvedValue(balance({ balanceXAF: 4230 }));
      prisma.vendorPayout.findUnique.mockResolvedValue({ id: 'payout-existing' });
      const result = await service.tryScheduleVendorPayout('v-1', '+237670000111', scheduledFor);
      expect(result).toMatchObject({ outcome: 'already_scheduled', payoutId: 'payout-existing' });
      expect(prisma.vendorPayout.create).not.toHaveBeenCalled();
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });
  });

  describe('sweepWeeklyVendorPayouts', () => {
    it('iterates over SEMI_FORMAL + RESTAURANT vendors and accumulates outcomes', async () => {
      prisma.vendor.findMany.mockResolvedValue([
        { id: 'v-1', momoPhone: '+237670000001', name: 'Vendor 1' },
        { id: 'v-2', momoPhone: '+237670000002', name: 'Vendor 2' },
        { id: 'v-3', momoPhone: '+237670000003', name: 'Vendor 3' },
      ]);
      finance.getVendorBalance
        .mockResolvedValueOnce(balance({ vendorId: 'v-1', balanceXAF: 4230 })) // scheduled
        .mockResolvedValueOnce(balance({ vendorId: 'v-2', balanceXAF: 200 })) // below min
        .mockResolvedValueOnce(balance({ vendorId: 'v-3', balanceXAF: 8000 })); // scheduled
      // Vendor-row lookups for periodStart
      prisma.vendor.findUnique.mockResolvedValue({ createdAt: new Date('2026-04-01') });

      await service.sweepWeeklyVendorPayouts();

      // Two payouts created (v-1, v-3), one ledger transaction each.
      expect(prisma.vendorPayout.create).toHaveBeenCalledTimes(2);
      expect(ledger.recordTransaction).toHaveBeenCalledTimes(2);

      // findMany was called with the right filter
      expect(prisma.vendor.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ACTIVE',
            type: { in: ['SEMI_FORMAL', 'RESTAURANT'] },
          }),
        }),
      );
    });

    it('one vendor failing does not break the batch', async () => {
      prisma.vendor.findMany.mockResolvedValue([
        { id: 'v-1', momoPhone: '+237670000001', name: 'Vendor 1' },
        { id: 'v-2', momoPhone: '+237670000002', name: 'Vendor 2' },
      ]);
      finance.getVendorBalance
        .mockRejectedValueOnce(new Error('database boom')) // v-1 throws
        .mockResolvedValueOnce(balance({ vendorId: 'v-2', balanceXAF: 4230 })); // v-2 succeeds
      prisma.vendor.findUnique.mockResolvedValue({ createdAt: new Date('2026-04-01') });

      await expect(service.sweepWeeklyVendorPayouts()).resolves.toBeUndefined();
      // v-2 still got scheduled
      expect(prisma.vendorPayout.create).toHaveBeenCalledTimes(1);
    });
  });
});
