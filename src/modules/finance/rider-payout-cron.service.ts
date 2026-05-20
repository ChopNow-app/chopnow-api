import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LedgerAccount, LedgerEventType, OrderStatus, RiderStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { FinanceService } from './finance.service';
import { LedgerService } from './ledger.service';

// Per ADR-0005: riders get a daily 06:00 Douala batch — wake up to
// yesterday's earnings. Daily cadence balances "rider trusts the
// platform" against per-transfer Campay fees (which would dominate a
// per-delivery model). Minimum threshold: 1000 FCFA so transfers don't
// fire for under-active riders' rounding-noise balances.
const MIN_RIDER_PAYOUT_XAF = 1000;
const MAX_RIDERS_PER_RUN = 500;

@Injectable()
export class RiderPayoutCronService {
  constructor(
    @InjectPinoLogger(RiderPayoutCronService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly ledger: LedgerService,
  ) {}

  // Every day at 06:00 Africa/Douala. Format: `minute hour day-of-month month day-of-week`.
  @Cron('0 6 * * *', { timeZone: 'Africa/Douala' })
  async sweepDailyRiderPayouts(): Promise<void> {
    const startedAt = new Date();
    let scheduledCount = 0;
    let skippedBelowMin = 0;
    let skippedZero = 0;
    let skippedKycIncomplete = 0;
    let totalXAF = 0;
    let failedCount = 0;

    // We only schedule for ACTIVE riders. Suspended/rejected riders
    // need an admin manual settlement (rare; suspension freezes their
    // balance until resolved).
    const riders = await this.prisma.rider.findMany({
      where: { status: RiderStatus.ACTIVE },
      select: { id: true, momoPhone: true },
      take: MAX_RIDERS_PER_RUN,
    });

    for (const r of riders) {
      try {
        const result = await this.tryScheduleRiderPayout(r.id, r.momoPhone, startedAt);
        switch (result.outcome) {
          case 'scheduled':
            scheduledCount += 1;
            totalXAF += result.netXAF;
            break;
          case 'below_minimum':
            skippedBelowMin += 1;
            break;
          case 'no_activity':
            skippedZero += 1;
            break;
          case 'kyc_incomplete':
            skippedKycIncomplete += 1;
            break;
          case 'already_scheduled':
            // Idempotent re-run — no-op.
            break;
        }
      } catch (err) {
        failedCount += 1;
        this.logger.error(
          {
            event: 'rider_payout_cron_row_failed',
            riderId: r.id,
            error: err instanceof Error ? err.message : String(err),
          },
          'rider payout row failed — batch continues',
        );
      }
    }

    this.logger.info(
      {
        event: 'rider_payout_cron_completed',
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        candidates: riders.length,
        scheduled: scheduledCount,
        skippedBelowMin,
        skippedZero,
        skippedKycIncomplete,
        failed: failedCount,
        totalXAF,
      },
      'daily rider payout cron completed',
    );
  }

  async tryScheduleRiderPayout(
    riderId: string,
    momoPhone: string,
    scheduledFor: Date,
  ): Promise<
    | { outcome: 'scheduled'; payoutId: string; netXAF: number }
    | { outcome: 'below_minimum'; balanceXAF: number }
    | { outcome: 'no_activity'; balanceXAF: number }
    | { outcome: 'already_scheduled'; payoutId: string }
    | { outcome: 'kyc_incomplete'; missing: string[] }
  > {
    // KYC defense-in-depth (#213 review): RiderStatus.ACTIVE already
    // requires admin approval (and admin verifies KYC photos before
    // approving) but the cron should be its own backstop in case an
    // approval ever fires before KYC was actually completed. If either
    // identity photo is missing, refuse payout and flag the rider.
    const kyc = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: { idCardPhotoUrl: true, selfiePhotoUrl: true },
    });
    const missing: string[] = [];
    if (!kyc?.idCardPhotoUrl) missing.push('idCardPhotoUrl');
    if (!kyc?.selfiePhotoUrl) missing.push('selfiePhotoUrl');
    if (missing.length > 0) {
      this.logger.warn(
        {
          event: 'rider_payout_skipped',
          riderId,
          reason: 'kyc_incomplete',
          missing,
        },
        'rider payout refused — KYC photos missing despite ACTIVE status',
      );
      return { outcome: 'kyc_incomplete', missing };
    }

    const balance = await this.finance.getRiderBalance(riderId);

    if (balance.balanceXAF <= 0) {
      // No activity since last payout — the common case for riders who
      // didn't work that day. Silently skipped (info-level only).
      this.logger.info(
        {
          event: 'rider_payout_skipped',
          riderId,
          reason: 'no_activity',
          balanceXAF: balance.balanceXAF,
        },
        'rider payout skipped — no positive balance since last payout',
      );
      return { outcome: 'no_activity', balanceXAF: balance.balanceXAF };
    }

    if (balance.balanceXAF < MIN_RIDER_PAYOUT_XAF) {
      this.logger.info(
        {
          event: 'rider_payout_skipped',
          riderId,
          reason: 'below_minimum',
          balanceXAF: balance.balanceXAF,
          minimumXAF: MIN_RIDER_PAYOUT_XAF,
        },
        'rider payout skipped — below minimum threshold',
      );
      return { outcome: 'below_minimum', balanceXAF: balance.balanceXAF };
    }

    // Idempotency: derive periodStart consistently with how
    // getRiderBalance frames the cutoff.
    const lastPaidPayout = await this.prisma.riderPayout.findFirst({
      where: { riderId, status: { in: ['PAID', 'IN_FLIGHT'] } },
      orderBy: { periodEnd: 'desc' },
      select: { periodEnd: true },
    });
    const riderRow = await this.prisma.rider.findUnique({
      where: { id: riderId },
      select: { createdAt: true },
    });
    const periodStart = lastPaidPayout?.periodEnd ?? riderRow!.createdAt;
    const periodEnd = scheduledFor;

    const existing = await this.prisma.riderPayout.findUnique({
      where: { riderId_periodStart: { riderId, periodStart } },
      select: { id: true },
    });
    if (existing) {
      return { outcome: 'already_scheduled', payoutId: existing.id };
    }

    const payoutId = await this.prisma.$transaction(async (tx) => {
      const payout = await tx.riderPayout.create({
        data: {
          riderId,
          periodStart,
          periodEnd,
          grossXAF: balance.components.grossXAF,
          adjustmentsXAF: balance.components.adjustmentsXAF,
          netXAF: balance.balanceXAF,
          momoPhone,
          scheduledFor,
        },
      });
      await this.ledger.recordTransaction(
        {
          eventId: `rider_payout:${payout.id}`,
          eventType: LedgerEventType.RIDER_PAYOUT,
          entries: [
            {
              account: LedgerAccount.RIDER_PAYABLE,
              amountXAF: balance.balanceXAF,
              riderId,
              payoutId: payout.id,
              description: `Rider payout scheduled (period ${periodStart.toISOString()} → ${periodEnd.toISOString()})`,
            },
            {
              account: LedgerAccount.CAMPAY_FLOAT,
              amountXAF: -balance.balanceXAF,
              riderId,
              payoutId: payout.id,
              description: 'Funds leaving platform Campay float',
            },
          ],
        },
        tx,
      );
      // Tag every delivered order this rider completed in the period.
      await tx.order.updateMany({
        where: {
          riderId,
          status: OrderStatus.DELIVERED,
          deliveredAt: { gt: periodStart, lte: periodEnd },
          // Note: Order.payoutId is shared between vendor + rider
          // settlement reads. At pilot scope rider runs first per day,
          // vendor runs once per week — collisions are vanishingly
          // unlikely but if they happen the admin detail view shows the
          // last writer. Post-pilot: split into payoutVendorId +
          // payoutRiderId.
        },
        data: { payoutId: payout.id },
      });
      return payout.id;
    });

    this.logger.info(
      {
        event: 'rider_payout_scheduled',
        riderId,
        payoutId,
        periodStart,
        periodEnd,
        netXAF: balance.balanceXAF,
        grossXAF: balance.components.grossXAF,
      },
      'rider payout scheduled',
    );

    return { outcome: 'scheduled', payoutId, netXAF: balance.balanceXAF };
  }
}

export { MIN_RIDER_PAYOUT_XAF };
