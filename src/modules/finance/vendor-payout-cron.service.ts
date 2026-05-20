import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  LedgerAccount,
  LedgerEventType,
  OrderStatus,
  PaymentStatus,
  VendorStatus,
  VendorType,
} from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { FinanceService } from './finance.service';
import { LedgerService } from './ledger.service';

// Per ADR-0005: SEMI_FORMAL + RESTAURANT vendors get a weekly batch at
// Sunday 02:00 Africa/Douala (off-peak; avoids any risk of competing with
// the live dinner traffic). INFORMAL vendors get on-demand via 7.2b.
//
// Minimum payout amount: avoids per-vendor Campay fees for sub-trivial
// balances. Carries over to next week's run.
const MIN_VENDOR_PAYOUT_XAF = 500;
const MAX_VENDORS_PER_RUN = 500;

@Injectable()
export class VendorPayoutCronService {
  constructor(
    @InjectPinoLogger(VendorPayoutCronService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly ledger: LedgerService,
  ) {}

  // Sunday 02:00 Africa/Douala. Format: `minute hour day-of-month month day-of-week`
  // — 0 = Sunday.
  @Cron('0 2 * * 0', { timeZone: 'Africa/Douala' })
  async sweepWeeklyVendorPayouts(): Promise<void> {
    const startedAt = new Date();
    let scheduledCount = 0;
    let skippedBelowMin = 0;
    let skippedOpenDisputes = 0;
    let skippedNegative = 0;
    let totalXAF = 0;
    let failedCount = 0;

    const vendors = await this.prisma.vendor.findMany({
      where: {
        status: VendorStatus.ACTIVE,
        type: { in: [VendorType.SEMI_FORMAL, VendorType.RESTAURANT] },
      },
      select: { id: true, momoPhone: true, name: true },
      take: MAX_VENDORS_PER_RUN,
    });

    for (const v of vendors) {
      try {
        const result = await this.tryScheduleVendorPayout(v.id, v.momoPhone, startedAt);
        switch (result.outcome) {
          case 'scheduled':
            scheduledCount += 1;
            totalXAF += result.netXAF;
            break;
          case 'below_minimum':
            skippedBelowMin += 1;
            break;
          case 'open_disputes':
            skippedOpenDisputes += 1;
            break;
          case 'negative_or_zero_balance':
            skippedNegative += 1;
            break;
          case 'already_scheduled':
            // Idempotent re-run — no-op, not counted as skip.
            break;
        }
      } catch (err) {
        failedCount += 1;
        this.logger.error(
          {
            event: 'vendor_payout_cron_row_failed',
            vendorId: v.id,
            error: err instanceof Error ? err.message : String(err),
          },
          'vendor payout row failed — batch continues',
        );
      }
    }

    this.logger.info(
      {
        event: 'vendor_payout_cron_completed',
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        candidates: vendors.length,
        scheduled: scheduledCount,
        skippedBelowMin,
        skippedOpenDisputes,
        skippedNegative,
        failed: failedCount,
        totalXAF,
      },
      'weekly vendor payout cron completed',
    );
  }

  // Exposed for tests; the cron just iterates and accumulates outcomes.
  async tryScheduleVendorPayout(
    vendorId: string,
    momoPhone: string,
    scheduledFor: Date,
  ): Promise<
    | { outcome: 'scheduled'; payoutId: string; netXAF: number }
    | { outcome: 'below_minimum'; balanceXAF: number }
    | { outcome: 'open_disputes' }
    | { outcome: 'negative_or_zero_balance'; balanceXAF: number }
    | { outcome: 'already_scheduled'; payoutId: string }
  > {
    const balance = await this.finance.getVendorBalance(vendorId);

    if (balance.balanceXAF <= 0) {
      this.logger.info(
        {
          event: 'vendor_payout_skipped',
          vendorId,
          reason: 'negative_or_zero_balance',
          balanceXAF: balance.balanceXAF,
        },
        'vendor payout skipped — non-positive balance',
      );
      return { outcome: 'negative_or_zero_balance', balanceXAF: balance.balanceXAF };
    }

    if (balance.balanceXAF < MIN_VENDOR_PAYOUT_XAF) {
      this.logger.info(
        {
          event: 'vendor_payout_skipped',
          vendorId,
          reason: 'below_minimum',
          balanceXAF: balance.balanceXAF,
          minimumXAF: MIN_VENDOR_PAYOUT_XAF,
        },
        'vendor payout skipped — below minimum threshold',
      );
      return { outcome: 'below_minimum', balanceXAF: balance.balanceXAF };
    }

    // Negative-balance refusal (#205): never schedule a payout while a
    // refund is still queued or a dispute is open. The unpaid refund
    // would otherwise leave platform on the hook for both legs.
    const openDisputes = await this.prisma.order.count({
      where: { vendorId, paymentStatus: PaymentStatus.REFUND_PENDING },
    });
    if (openDisputes > 0) {
      this.logger.warn(
        {
          event: 'vendor_payout_skipped',
          vendorId,
          reason: 'open_disputes',
          openDisputes,
        },
        'vendor payout skipped — open refund/dispute pending',
      );
      return { outcome: 'open_disputes' };
    }

    // Idempotency: a previous run for this period must not double-pay.
    // periodStart = the lastPayout cutoff (exclusive) or vendor creation.
    // Same value getVendorBalance uses internally — we recompute from the
    // last paid VendorPayout to keep behavior aligned even if balance
    // narrowed since the read.
    const lastPaidPayout = await this.prisma.vendorPayout.findFirst({
      where: { vendorId, status: { in: ['PAID', 'IN_FLIGHT'] } },
      orderBy: { periodEnd: 'desc' },
      select: { periodEnd: true },
    });
    const vendorRow = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { createdAt: true },
    });
    const periodStart = lastPaidPayout?.periodEnd ?? vendorRow!.createdAt;
    const periodEnd = scheduledFor;

    const existing = await this.prisma.vendorPayout.findUnique({
      where: { vendorId_periodStart: { vendorId, periodStart } },
      select: { id: true },
    });
    if (existing) {
      return { outcome: 'already_scheduled', payoutId: existing.id };
    }

    // Atomic: VendorPayout row + paired ledger entries + Order.payoutId
    // update for the orders included in this period. If any step fails
    // the whole transaction rolls back; the cron continues to the next
    // vendor.
    const payoutId = await this.prisma.$transaction(async (tx) => {
      const payout = await tx.vendorPayout.create({
        data: {
          vendorId,
          periodStart,
          periodEnd,
          grossXAF: balance.components.grossXAF,
          commissionXAF: balance.components.commissionXAF,
          penaltyXAF: balance.components.penaltyXAF,
          adjustmentsXAF: balance.components.adjustmentsXAF,
          netXAF: balance.balanceXAF,
          momoPhone,
          scheduledFor,
          // PENDING — Campay transfer initiation is a follow-up issue.
          // Operationally the admin dashboard surfaces PENDING rows for
          // manual fire until that's wired.
        },
      });
      await this.ledger.recordTransaction(
        {
          eventId: `vendor_payout:${payout.id}`,
          eventType: LedgerEventType.VENDOR_PAYOUT,
          entries: [
            {
              account: LedgerAccount.VENDOR_PAYABLE,
              amountXAF: balance.balanceXAF,
              vendorId,
              payoutId: payout.id,
              description: `Vendor payout scheduled (period ${periodStart.toISOString()} → ${periodEnd.toISOString()})`,
            },
            {
              account: LedgerAccount.CAMPAY_FLOAT,
              amountXAF: -balance.balanceXAF,
              vendorId,
              payoutId: payout.id,
              description: 'Funds leaving platform Campay float',
            },
          ],
        },
        tx,
      );
      // Tag every delivered order in this period as belonging to the new
      // payout so the admin detail view can list the source orders.
      await tx.order.updateMany({
        where: {
          vendorId,
          status: OrderStatus.DELIVERED,
          deliveredAt: { gt: periodStart, lte: periodEnd },
          payoutId: null,
        },
        data: { payoutId: payout.id },
      });
      return payout.id;
    });

    this.logger.info(
      {
        event: 'vendor_payout_scheduled',
        vendorId,
        payoutId,
        periodStart,
        periodEnd,
        netXAF: balance.balanceXAF,
        grossXAF: balance.components.grossXAF,
        commissionXAF: balance.components.commissionXAF,
        penaltyXAF: balance.components.penaltyXAF,
      },
      'vendor payout scheduled',
    );

    return { outcome: 'scheduled', payoutId, netXAF: balance.balanceXAF };
  }
}

// Exported for tests + other crons that want the same threshold.
export { MIN_VENDOR_PAYOUT_XAF };
