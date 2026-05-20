import { Test } from '@nestjs/testing';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import { FinanceService, type RiderBalance } from './finance.service';
import { LedgerService } from './ledger.service';
import { RiderPayoutCronService } from './rider-payout-cron.service';

function riderBalance(over: Partial<RiderBalance> = {}): RiderBalance {
  return {
    riderId: 'r-1',
    name: 'Jean',
    balanceXAF: 0,
    components: { grossXAF: 0, adjustmentsXAF: 0 },
    lastPayoutAt: null,
    lastPayoutId: null,
    ...over,
  };
}

describe('RiderPayoutCronService', () => {
  let service: RiderPayoutCronService;
  let prisma: {
    rider: { findMany: jest.Mock; findUnique: jest.Mock };
    riderPayout: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
    order: { updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let finance: { getRiderBalance: jest.Mock };
  let ledger: { recordTransaction: jest.Mock };

  beforeEach(async () => {
    prisma = {
      rider: {
        findMany: jest.fn().mockResolvedValue([]),
        // Both findUnique callers (KYC photos + createdAt) share this mock —
        // return everything; Prisma in prod would honour the select.
        findUnique: jest.fn().mockResolvedValue({
          createdAt: new Date('2026-04-01'),
          idCardPhotoUrl: 'rider-kyc/id-1.webp',
          selfiePhotoUrl: 'rider-kyc/selfie-1.webp',
        }),
      },
      riderPayout: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'rp-1', ...data })),
      },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };
    finance = { getRiderBalance: jest.fn() };
    ledger = { recordTransaction: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        RiderPayoutCronService,
        { provide: PrismaService, useValue: prisma },
        { provide: FinanceService, useValue: finance },
        { provide: LedgerService, useValue: ledger },
        pinoLoggerProvider(RiderPayoutCronService.name),
      ],
    }).compile();

    service = module.get(RiderPayoutCronService);
  });

  describe('tryScheduleRiderPayout', () => {
    const scheduledFor = new Date('2026-05-20T06:00:00Z');

    it('schedules a rider payout + writes paired ledger entries when balance >= 1000', async () => {
      finance.getRiderBalance.mockResolvedValue(
        riderBalance({
          balanceXAF: 1560, // 6 deliveries × 260 FCFA
          components: { grossXAF: 1560, adjustmentsXAF: 0 },
        }),
      );

      const result = await service.tryScheduleRiderPayout('r-1', '+237670000020', scheduledFor);

      expect(result).toMatchObject({ outcome: 'scheduled', netXAF: 1560 });

      expect(prisma.riderPayout.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          riderId: 'r-1',
          netXAF: 1560,
          grossXAF: 1560,
          momoPhone: '+237670000020',
          scheduledFor,
        }),
      });

      expect(ledger.recordTransaction).toHaveBeenCalledTimes(1);
      const [input, tx] = ledger.recordTransaction.mock.calls[0];
      expect(input.eventId).toBe('rider_payout:rp-1');
      expect(input.eventType).toBe('RIDER_PAYOUT');
      expect(input.entries).toEqual([
        expect.objectContaining({
          account: 'RIDER_PAYABLE',
          amountXAF: 1560,
          riderId: 'r-1',
          payoutId: 'rp-1',
        }),
        expect.objectContaining({
          account: 'CAMPAY_FLOAT',
          amountXAF: -1560,
          riderId: 'r-1',
          payoutId: 'rp-1',
        }),
      ]);
      expect(tx).toBe(prisma);

      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ riderId: 'r-1' }),
          data: { payoutId: 'rp-1' },
        }),
      );
    });

    it('skips below_minimum when balance < 1000 FCFA', async () => {
      finance.getRiderBalance.mockResolvedValue(riderBalance({ balanceXAF: 780 }));
      const result = await service.tryScheduleRiderPayout('r-1', '+237670000020', scheduledFor);
      expect(result).toMatchObject({ outcome: 'below_minimum', balanceXAF: 780 });
      expect(prisma.riderPayout.create).not.toHaveBeenCalled();
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });

    it('skips no_activity when balance is 0 (no deliveries since last payout)', async () => {
      finance.getRiderBalance.mockResolvedValue(riderBalance({ balanceXAF: 0 }));
      const result = await service.tryScheduleRiderPayout('r-1', '+237670000020', scheduledFor);
      expect(result).toMatchObject({ outcome: 'no_activity', balanceXAF: 0 });
      expect(prisma.riderPayout.create).not.toHaveBeenCalled();
    });

    it('refuses payout with kyc_incomplete when idCardPhotoUrl is missing (defense-in-depth — #213)', async () => {
      prisma.rider.findUnique.mockResolvedValue({
        createdAt: new Date('2026-04-01'),
        idCardPhotoUrl: null,
        selfiePhotoUrl: 'rider-kyc/selfie-1.webp',
      });
      finance.getRiderBalance.mockResolvedValue(riderBalance({ balanceXAF: 1560 }));

      const result = await service.tryScheduleRiderPayout('r-1', '+237670000020', scheduledFor);

      expect(result).toMatchObject({
        outcome: 'kyc_incomplete',
        missing: ['idCardPhotoUrl'],
      });
      expect(finance.getRiderBalance).not.toHaveBeenCalled();
      expect(prisma.riderPayout.create).not.toHaveBeenCalled();
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });

    it('refuses payout when both KYC photos missing — surfaces both', async () => {
      prisma.rider.findUnique.mockResolvedValue({
        createdAt: new Date('2026-04-01'),
        idCardPhotoUrl: null,
        selfiePhotoUrl: null,
      });

      const result = await service.tryScheduleRiderPayout('r-1', '+237670000020', scheduledFor);

      expect(result).toMatchObject({
        outcome: 'kyc_incomplete',
        missing: ['idCardPhotoUrl', 'selfiePhotoUrl'],
      });
    });

    it('returns already_scheduled when a payout for (riderId, periodStart) already exists (idempotent re-run)', async () => {
      finance.getRiderBalance.mockResolvedValue(riderBalance({ balanceXAF: 1560 }));
      prisma.riderPayout.findUnique.mockResolvedValue({ id: 'rp-existing' });
      const result = await service.tryScheduleRiderPayout('r-1', '+237670000020', scheduledFor);
      expect(result).toMatchObject({ outcome: 'already_scheduled', payoutId: 'rp-existing' });
      expect(prisma.riderPayout.create).not.toHaveBeenCalled();
      expect(ledger.recordTransaction).not.toHaveBeenCalled();
    });
  });

  describe('sweepDailyRiderPayouts', () => {
    it('iterates over ACTIVE riders, accumulates outcomes, and emits cron_completed', async () => {
      prisma.rider.findMany.mockResolvedValue([
        { id: 'r-1', momoPhone: '+237670000001' },
        { id: 'r-2', momoPhone: '+237670000002' },
        { id: 'r-3', momoPhone: '+237670000003' },
      ]);
      finance.getRiderBalance
        .mockResolvedValueOnce(riderBalance({ riderId: 'r-1', balanceXAF: 1560 })) // scheduled
        .mockResolvedValueOnce(riderBalance({ riderId: 'r-2', balanceXAF: 780 })) // below min
        .mockResolvedValueOnce(riderBalance({ riderId: 'r-3', balanceXAF: 0 })); // no_activity

      await service.sweepDailyRiderPayouts();

      // Only r-1 generates writes.
      expect(prisma.riderPayout.create).toHaveBeenCalledTimes(1);
      expect(ledger.recordTransaction).toHaveBeenCalledTimes(1);
      // Confirms the rider findMany ACTIVE-status filter
      expect(prisma.rider.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }),
      );
    });

    it('one rider failing does not break the batch', async () => {
      prisma.rider.findMany.mockResolvedValue([
        { id: 'r-1', momoPhone: '+237670000001' },
        { id: 'r-2', momoPhone: '+237670000002' },
      ]);
      finance.getRiderBalance
        .mockRejectedValueOnce(new Error('database boom'))
        .mockResolvedValueOnce(riderBalance({ riderId: 'r-2', balanceXAF: 1560 }));

      await expect(service.sweepDailyRiderPayouts()).resolves.toBeUndefined();
      expect(prisma.riderPayout.create).toHaveBeenCalledTimes(1);
    });
  });
});
