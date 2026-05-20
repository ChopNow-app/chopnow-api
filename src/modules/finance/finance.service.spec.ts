import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { VendorType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { FinanceService } from './finance.service';

describe('FinanceService', () => {
  let service: FinanceService;
  let prisma: {
    vendor: { findUnique: jest.Mock };
    vendorPayout: { findFirst: jest.Mock };
    ledgerEntry: { aggregate: jest.Mock; groupBy: jest.Mock };
    order: { count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      vendor: { findUnique: jest.fn() },
      vendorPayout: { findFirst: jest.fn().mockResolvedValue(null) },
      ledgerEntry: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amountXAF: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      order: { count: jest.fn().mockResolvedValue(0) },
    };

    const module = await Test.createTestingModule({
      providers: [
        FinanceService,
        { provide: PrismaService, useValue: prisma },
        pinoLoggerProvider(FinanceService.name),
      ],
    }).compile();
    service = module.get(FinanceService);
  });

  describe('getVendorBalance', () => {
    it('throws NotFoundException with code vendor_not_found when the vendor does not exist', async () => {
      prisma.vendor.findUnique.mockResolvedValue(null);
      await expect(service.getVendorBalance('v-nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a zero balance for a fresh vendor (no ledger activity)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        name: 'Chez Maman',
        type: VendorType.INFORMAL,
        createdAt: new Date('2026-05-01'),
      });

      const result = await service.getVendorBalance('v-1');

      expect(result).toMatchObject({
        vendorId: 'v-1',
        balanceXAF: 0,
        components: { grossXAF: 0, commissionXAF: 0, penaltyXAF: 0, adjustmentsXAF: 0 },
        lastPayoutAt: null,
        lastPayoutId: null,
        isTrusted: false,
      });
    });

    it('computes balance from VENDOR_PAYABLE sum (inverted for vendor-friendly sign)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        name: 'Chez Maman',
        type: VendorType.INFORMAL,
        createdAt: new Date('2026-04-01'),
      });
      // Vendor delivered an order: VENDOR_PAYABLE got -4230 (we owe them 4230).
      prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountXAF: -4230 } });
      // Commission attributed to this vendor on ORDER_DELIVERED: -270.
      prisma.ledgerEntry.groupBy.mockResolvedValue([
        { eventType: 'ORDER_DELIVERED', _sum: { amountXAF: -270 } },
      ]);

      const result = await service.getVendorBalance('v-1');

      expect(result.balanceXAF).toBe(4230);
      expect(result.components.commissionXAF).toBe(270);
      // grossXAF = balance + commission − adjustments = 4230 + 270 = 4500
      expect(result.components.grossXAF).toBe(4500);
    });

    it('surfaces penalty separately from commission', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        name: 'Vendor',
        type: VendorType.INFORMAL,
        createdAt: new Date('2026-04-01'),
      });
      // Penalty applied: VENDOR_PAYABLE +450 (reduces what we owe).
      // Plus a delivered order: VENDOR_PAYABLE -4230. Net: -3780.
      prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountXAF: -3780 } });
      prisma.ledgerEntry.groupBy.mockResolvedValue([
        { eventType: 'ORDER_DELIVERED', _sum: { amountXAF: -270 } },
        { eventType: 'PENALTY_APPLIED', _sum: { amountXAF: -450 } },
      ]);

      const result = await service.getVendorBalance('v-1');

      expect(result.balanceXAF).toBe(3780);
      expect(result.components.commissionXAF).toBe(270);
      expect(result.components.penaltyXAF).toBe(450);
    });

    it('flags as trusted when completed >= 10 + age >= 7 days + no open disputes', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        name: 'Vendor',
        type: VendorType.INFORMAL,
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days old
      });
      // First call to count is for completedOrders (DELIVERED); second is for openDisputes.
      prisma.order.count.mockResolvedValueOnce(15).mockResolvedValueOnce(0);

      const result = await service.getVendorBalance('v-1');
      expect(result.isTrusted).toBe(true);
    });

    it('refuses trusted status when there are open disputes (paymentStatus = REFUND_PENDING)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        name: 'Vendor',
        type: VendorType.INFORMAL,
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });
      prisma.order.count.mockResolvedValueOnce(15).mockResolvedValueOnce(1);

      const result = await service.getVendorBalance('v-1');
      expect(result.isTrusted).toBe(false);
    });

    it('refuses trusted status when account is too young (< 7 days)', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        name: 'Vendor',
        type: VendorType.INFORMAL,
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      });
      prisma.order.count.mockResolvedValueOnce(15).mockResolvedValueOnce(0);

      const result = await service.getVendorBalance('v-1');
      expect(result.isTrusted).toBe(false);
    });

    it('uses last paid VendorPayout periodEnd as the ledger-history cutoff', async () => {
      prisma.vendor.findUnique.mockResolvedValue({
        id: 'v-1',
        name: 'Vendor',
        type: VendorType.INFORMAL,
        createdAt: new Date('2026-04-01'),
      });
      const lastPayout = {
        id: 'payout-1',
        paidAt: new Date('2026-05-12T02:00:00Z'),
        sentAt: new Date('2026-05-12T02:00:00Z'),
        periodEnd: new Date('2026-05-11T23:59:59Z'),
      };
      prisma.vendorPayout.findFirst.mockResolvedValue(lastPayout);

      const result = await service.getVendorBalance('v-1');

      expect(result.lastPayoutAt).toEqual(lastPayout.paidAt);
      expect(result.lastPayoutId).toBe('payout-1');
      // aggregate was called with createdAt > periodEnd
      const aggregateArgs = prisma.ledgerEntry.aggregate.mock.calls[0][0];
      expect(aggregateArgs.where.createdAt.gt).toEqual(lastPayout.periodEnd);
    });
  });
});
