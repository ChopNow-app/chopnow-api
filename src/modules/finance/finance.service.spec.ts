import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { RiderVehicleType, VendorStatus, VendorType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { FinanceService } from './finance.service';

describe('FinanceService', () => {
  let service: FinanceService;
  let prisma: {
    vendor: { findUnique: jest.Mock; findMany: jest.Mock };
    rider: { findUnique: jest.Mock; findMany: jest.Mock };
    vendorPayout: { findFirst: jest.Mock };
    riderPayout: { findFirst: jest.Mock };
    ledgerEntry: { aggregate: jest.Mock; groupBy: jest.Mock };
    order: { count: jest.Mock; findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      vendor: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      rider: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
      vendorPayout: { findFirst: jest.fn().mockResolvedValue(null) },
      riderPayout: { findFirst: jest.fn().mockResolvedValue(null) },
      ledgerEntry: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amountXAF: 0 } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      order: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
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

  describe('getRiderBalance', () => {
    it('throws NotFoundException with code rider_not_found when the rider does not exist', async () => {
      prisma.rider.findUnique.mockResolvedValue(null);
      await expect(service.getRiderBalance('r-nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns a zero balance for a fresh rider (no ledger activity)', async () => {
      prisma.rider.findUnique.mockResolvedValue({
        id: 'r-1',
        user: { displayName: 'Jean Mboué' },
      });

      const result = await service.getRiderBalance('r-1');

      expect(result).toMatchObject({
        riderId: 'r-1',
        name: 'Jean Mboué',
        balanceXAF: 0,
        components: { grossXAF: 0, adjustmentsXAF: 0 },
        lastPayoutAt: null,
        lastPayoutId: null,
      });
    });

    it('computes balance from RIDER_PAYABLE sum (inverted for rider-friendly sign)', async () => {
      prisma.rider.findUnique.mockResolvedValue({
        id: 'r-1',
        user: { displayName: 'Jean' },
      });
      // Three delivered orders × 260 = -780 in RIDER_PAYABLE.
      prisma.ledgerEntry.aggregate.mockResolvedValueOnce({ _sum: { amountXAF: -780 } });
      // No adjustments.
      prisma.ledgerEntry.aggregate.mockResolvedValueOnce({ _sum: { amountXAF: 0 } });

      const result = await service.getRiderBalance('r-1');

      expect(result.balanceXAF).toBe(780);
      expect(result.components.grossXAF).toBe(780);
      expect(result.components.adjustmentsXAF).toBe(0);
    });

    it('separates admin adjustments from gross delivery earnings', async () => {
      prisma.rider.findUnique.mockResolvedValue({
        id: 'r-1',
        user: { displayName: null },
      });
      // -780 RIDER_PAYABLE (balance 780). Adjustments leg of an ADJUSTMENT
      // event: PLATFORM_REVENUE entry of -100 means the platform recognised
      // -100 of revenue (gave the rider a 100 bonus); rider's payable
      // contribution from that event also reflects the +100.
      prisma.ledgerEntry.aggregate.mockResolvedValueOnce({ _sum: { amountXAF: -880 } });
      prisma.ledgerEntry.aggregate.mockResolvedValueOnce({ _sum: { amountXAF: -100 } });

      const result = await service.getRiderBalance('r-1');

      expect(result.balanceXAF).toBe(880);
      expect(result.components.adjustmentsXAF).toBe(100);
      expect(result.components.grossXAF).toBe(780);
      expect(result.name).toBeNull();
    });

    it('uses last paid RiderPayout periodEnd as the ledger-history cutoff', async () => {
      prisma.rider.findUnique.mockResolvedValue({
        id: 'r-1',
        user: { displayName: 'Jean' },
      });
      const lastPayout = {
        id: 'rider-payout-1',
        paidAt: new Date('2026-05-18T06:00:00Z'),
        sentAt: new Date('2026-05-18T06:00:00Z'),
        periodEnd: new Date('2026-05-17T23:59:59Z'),
      };
      prisma.riderPayout.findFirst.mockResolvedValue(lastPayout);

      const result = await service.getRiderBalance('r-1');

      expect(result.lastPayoutAt).toEqual(lastPayout.paidAt);
      expect(result.lastPayoutId).toBe('rider-payout-1');
      const aggregateArgs = prisma.ledgerEntry.aggregate.mock.calls[0][0];
      expect(aggregateArgs.where.createdAt.gt).toEqual(lastPayout.periodEnd);
    });
  });

  describe('listVendorBalances', () => {
    function seedThreeVendors() {
      // First findMany: list of vendor IDs. Second findMany: status map.
      // Both return the same 3 vendors but with different selects.
      prisma.vendor.findMany
        .mockResolvedValueOnce([{ id: 'v-1' }, { id: 'v-2' }, { id: 'v-3' }])
        .mockResolvedValueOnce([
          { id: 'v-1', status: VendorStatus.ACTIVE },
          { id: 'v-2', status: VendorStatus.ACTIVE },
          { id: 'v-3', status: VendorStatus.PENDING_REVIEW },
        ]);
      const vendorMap: Record<
        string,
        { id: string; name: string; type: VendorType; createdAt: Date }
      > = {
        'v-1': {
          id: 'v-1',
          name: 'Vendor 1',
          type: VendorType.INFORMAL,
          createdAt: new Date('2026-04-01'),
        },
        'v-2': {
          id: 'v-2',
          name: 'Vendor 2',
          type: VendorType.RESTAURANT,
          createdAt: new Date('2026-04-01'),
        },
        'v-3': {
          id: 'v-3',
          name: 'Vendor 3',
          type: VendorType.SEMI_FORMAL,
          createdAt: new Date('2026-04-01'),
        },
      };
      prisma.vendor.findUnique.mockImplementation(({ where }) =>
        Promise.resolve(vendorMap[where.id]),
      );
      // Per-vendor balance based on the where.vendorId.
      prisma.ledgerEntry.aggregate.mockImplementation(({ where }) => {
        const balances: Record<string, number> = {
          'v-1': -1000, // balance 1000
          'v-2': -5000, // balance 5000
          'v-3': 0,
        };
        return Promise.resolve({ _sum: { amountXAF: balances[where.vendorId] ?? 0 } });
      });
    }

    it('returns vendors sorted by balance DESC', async () => {
      seedThreeVendors();
      const result = await service.listVendorBalances({});
      expect(result.total).toBe(3);
      expect(result.rows.map((r) => r.vendorId)).toEqual(['v-2', 'v-1', 'v-3']);
      expect(result.rows[0].balanceXAF).toBe(5000);
    });

    it('respects minBalanceXAF filter', async () => {
      seedThreeVendors();
      const result = await service.listVendorBalances({ minBalanceXAF: 2000 });
      expect(result.total).toBe(1);
      expect(result.rows[0].vendorId).toBe('v-2');
    });

    it('attaches vendor status from the batch query (not the per-row read)', async () => {
      seedThreeVendors();
      const result = await service.listVendorBalances({});
      const v3 = result.rows.find((r) => r.vendorId === 'v-3');
      expect(v3?.status).toBe(VendorStatus.PENDING_REVIEW);
    });

    it('paginates via offset + limit', async () => {
      seedThreeVendors();
      const result = await service.listVendorBalances({ limit: 1, offset: 1 });
      expect(result.total).toBe(3);
      expect(result.rows).toHaveLength(1);
      // Second-highest balance: v-1 (1000)
      expect(result.rows[0].vendorId).toBe('v-1');
    });
  });

  describe('listRiderBalances', () => {
    it('returns riders sorted by balance DESC + supports vehicleType filter', async () => {
      prisma.rider.findMany.mockResolvedValueOnce([
        { id: 'r-1', vehicleType: RiderVehicleType.MOTO, user: { displayName: 'Jean' } },
        { id: 'r-2', vehicleType: RiderVehicleType.MOTO, user: { displayName: 'Paul' } },
      ]);
      // Per-rider findUnique returns the right rider regardless of call order.
      prisma.rider.findUnique.mockImplementation(({ where }) => {
        const map: Record<string, { id: string; user: { displayName: string } }> = {
          'r-1': { id: 'r-1', user: { displayName: 'Jean' } },
          'r-2': { id: 'r-2', user: { displayName: 'Paul' } },
        };
        return Promise.resolve(map[where.id]);
      });
      // Per-rider aggregate returns balance based on the riderId in the where.
      // r-1 → 260 payable / 0 adjustments. r-2 → 780 payable / 0 adjustments.
      prisma.ledgerEntry.aggregate.mockImplementation(({ where }) => {
        if (where.account === 'RIDER_PAYABLE') {
          return Promise.resolve({
            _sum: { amountXAF: where.riderId === 'r-1' ? -260 : -780 },
          });
        }
        return Promise.resolve({ _sum: { amountXAF: 0 } });
      });

      const result = await service.listRiderBalances({ vehicleType: RiderVehicleType.MOTO });

      expect(result.total).toBe(2);
      expect(result.rows[0]).toMatchObject({ riderId: 'r-2', balanceXAF: 780, name: 'Paul' });
      expect(result.rows[1]).toMatchObject({ riderId: 'r-1', balanceXAF: 260 });
    });
  });

  describe('listRefundQueue', () => {
    it('returns REFUND_PENDING orders oldest-first with ageDays computed from cancelledAt', async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      prisma.order.count.mockResolvedValueOnce(2);
      prisma.order.findMany.mockResolvedValueOnce([
        {
          id: 'o-old',
          code: 'TC-OLD',
          vendorId: 'v-1',
          userId: 'u-1',
          totalXAF: 4900,
          cancelledAt: fiveDaysAgo,
          placedAt: fiveDaysAgo,
          vendor: { name: 'Vendor 1' },
        },
        {
          id: 'o-new',
          code: 'TC-NEW',
          vendorId: 'v-2',
          userId: 'u-2',
          totalXAF: 3500,
          cancelledAt: oneDayAgo,
          placedAt: oneDayAgo,
          vendor: { name: 'Vendor 2' },
        },
      ]);

      const result = await service.listRefundQueue({});

      expect(result.total).toBe(2);
      expect(result.rows[0]).toMatchObject({
        orderId: 'o-old',
        ageDays: 5,
        vendorName: 'Vendor 1',
      });
      expect(result.rows[1]).toMatchObject({
        orderId: 'o-new',
        ageDays: 1,
        vendorName: 'Vendor 2',
      });
    });

    it('uses placedAt as ageDays anchor when cancelledAt is null (legacy rows)', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      prisma.order.count.mockResolvedValueOnce(1);
      prisma.order.findMany.mockResolvedValueOnce([
        {
          id: 'o-1',
          code: 'TC-1',
          vendorId: 'v-1',
          userId: 'u-1',
          totalXAF: 4900,
          cancelledAt: null,
          placedAt: twoDaysAgo,
          vendor: { name: 'Vendor 1' },
        },
      ]);

      const result = await service.listRefundQueue({});
      expect(result.rows[0].ageDays).toBe(2);
      expect(result.rows[0].cancelledAt).toBeNull();
    });
  });
});
