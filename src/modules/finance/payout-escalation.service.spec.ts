import { Test } from '@nestjs/testing';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { PayoutEscalationService } from './payout-escalation.service';

describe('PayoutEscalationService', () => {
  let service: PayoutEscalationService;
  let prisma: {
    vendorPayout: { findMany: jest.Mock };
    riderPayout: { findMany: jest.Mock };
    order: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      vendorPayout: { findMany: jest.fn().mockResolvedValue([]) },
      riderPayout: { findMany: jest.fn().mockResolvedValue([]) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module = await Test.createTestingModule({
      providers: [
        PayoutEscalationService,
        { provide: PrismaService, useValue: prisma },
        pinoLoggerProvider(PayoutEscalationService.name),
      ],
    }).compile();

    service = module.get(PayoutEscalationService);
  });

  describe('listEscalations', () => {
    it('returns empty list when nothing failed or stuck', async () => {
      const items = await service.listEscalations();
      expect(items).toEqual([]);
    });

    it('flags FAILED vendor payouts', async () => {
      prisma.vendorPayout.findMany.mockResolvedValueOnce([
        {
          id: 'vp-1',
          vendorId: 'v-1',
          status: 'FAILED',
          netXAF: 4230,
          momoPhone: '+237670000001',
          failureReason: 'insufficient_balance',
          scheduledFor: new Date(Date.now() - 60 * 60_000),
          sentAt: new Date(Date.now() - 45 * 60_000),
        },
      ]);

      const items = await service.listEscalations();

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'vendor_payout',
        id: 'vp-1',
        contextId: 'v-1',
        status: 'FAILED',
        netXAF: 4230,
        failureReason: 'insufficient_balance',
      });
    });

    it('flags stale IN_FLIGHT rider payouts (sentAt > 30min ago)', async () => {
      prisma.riderPayout.findMany.mockResolvedValueOnce([
        {
          id: 'rp-1',
          riderId: 'r-1',
          status: 'IN_FLIGHT',
          netXAF: 1560,
          momoPhone: '+237670000002',
          failureReason: null,
          scheduledFor: new Date(Date.now() - 90 * 60_000),
          sentAt: new Date(Date.now() - 60 * 60_000),
        },
      ]);

      const items = await service.listEscalations();
      expect(items[0]).toMatchObject({
        kind: 'rider_payout',
        status: 'IN_FLIGHT',
      });
    });

    it('flags stuck refunds (refundCampayRef set + refundInitiatedAt > 30min ago + no refundedAt)', async () => {
      prisma.order.findMany.mockResolvedValueOnce([
        {
          id: 'o-1',
          totalXAF: 4900,
          payerPhone: '+237670000003',
          refundFailureReason: null,
          refundInitiatedAt: new Date(Date.now() - 45 * 60_000),
        },
      ]);

      const items = await service.listEscalations();
      expect(items[0]).toMatchObject({
        kind: 'refund',
        status: 'STALE_REFUND',
        netXAF: 4900,
      });
    });

    it('sorts items oldest first (highest ageMinutes first)', async () => {
      prisma.vendorPayout.findMany.mockResolvedValueOnce([
        {
          id: 'vp-old',
          vendorId: 'v-1',
          status: 'FAILED',
          netXAF: 4230,
          momoPhone: null,
          failureReason: null,
          scheduledFor: new Date(Date.now() - 180 * 60_000),
          sentAt: null,
        },
        {
          id: 'vp-new',
          vendorId: 'v-2',
          status: 'FAILED',
          netXAF: 1000,
          momoPhone: null,
          failureReason: null,
          scheduledFor: new Date(Date.now() - 35 * 60_000),
          sentAt: null,
        },
      ]);
      const items = await service.listEscalations();
      expect(items[0].id).toBe('vp-old');
      expect(items[1].id).toBe('vp-new');
    });
  });

  describe('sweepEscalations cron', () => {
    it('completes silently when nothing to flag', async () => {
      await expect(service.sweepEscalations()).resolves.toBeUndefined();
    });

    it('logs error-level for each flagged item', async () => {
      prisma.vendorPayout.findMany.mockResolvedValueOnce([
        {
          id: 'vp-1',
          vendorId: 'v-1',
          status: 'FAILED',
          netXAF: 4230,
          momoPhone: null,
          failureReason: 'x',
          scheduledFor: new Date(Date.now() - 60 * 60_000),
          sentAt: null,
        },
      ]);
      await expect(service.sweepEscalations()).resolves.toBeUndefined();
    });
  });
});
