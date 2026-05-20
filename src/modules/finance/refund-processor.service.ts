import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LedgerAccount, LedgerEventType, PaymentStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CampayService } from '../../infra/campay/campay.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { LedgerService } from './ledger.service';

// Per ADR-0005 §S3 / chopnow-api#90. Drains Order rows in REFUND_PENDING
// by initiating outbound MoMo transfers back to the consumer.
//
// Two-phase lifecycle on Order:
//   1. RefundProcessor sees paymentStatus=REFUND_PENDING with refundInitiatedAt
//      null → status-guarded updateMany locks refundInitiatedAt=now.
//   2. Calls Campay /withdraw/. On success persists refundCampayRef and
//      writes the "release escrow" ledger pair. On failure clears
//      refundInitiatedAt so the next sweep retries (with a 5-min cooldown
//      via refundFailureReason being set).
//   3. Campay webhook later flips paymentStatus → REFUNDED and writes the
//      "settle the refund" ledger pair (handled in FinanceService.handleRefundWebhook).
//
// Ledger pairs:
//   On initiation (refund accepted by Campay):
//     CUSTOMER_ESCROW + totalXAF   (release the held customer money)
//     REFUND_PAYABLE  - totalXAF   (platform owes customer)
//   On webhook confirmation (refund settled):
//     REFUND_PAYABLE  + totalXAF
//     CAMPAY_FLOAT    - totalXAF   (money actually left Campay)

const MAX_REFUNDS_PER_RUN = 25;

@Injectable()
export class RefundProcessorService {
  constructor(
    @InjectPinoLogger(RefundProcessorService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly campay: CampayService,
    private readonly ledger: LedgerService,
    private readonly env: EnvService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepPendingRefunds(): Promise<void> {
    const startedAt = new Date();
    const refundsEnabled = this.env.campay.refundsEnabled === true;

    let attempted = 0;
    let initiated = 0;
    let skippedManualMode = 0;
    let skippedMissingPayerPhone = 0;
    let failedCount = 0;

    const candidates = await this.prisma.order.findMany({
      where: {
        paymentStatus: PaymentStatus.REFUND_PENDING,
        refundInitiatedAt: null,
      },
      orderBy: { cancelledAt: 'asc' },
      take: MAX_REFUNDS_PER_RUN,
      select: { id: true, code: true, totalXAF: true, payerPhone: true },
    });

    for (const o of candidates) {
      attempted += 1;
      if (!o.payerPhone) {
        // Without payerPhone we can't refund — escalate to admin.
        skippedMissingPayerPhone += 1;
        await this.prisma.order
          .update({
            where: { id: o.id },
            data: { refundFailureReason: 'missing_payer_phone' },
          })
          .catch(() => undefined);
        this.logger.warn(
          {
            event: 'refund_skipped_missing_phone',
            orderId: o.id,
          },
          'Refund skipped — order has no payerPhone, manual admin action required',
        );
        continue;
      }
      const outcome = await this.tryRefund({
        orderId: o.id,
        orderCode: o.code,
        totalXAF: o.totalXAF,
        payerPhone: o.payerPhone,
        refundsEnabled,
      });
      if (outcome === 'initiated') initiated += 1;
      else if (outcome === 'skipped_manual') skippedManualMode += 1;
      else if (outcome === 'failed') failedCount += 1;
    }

    this.logger.info(
      {
        event: 'refund_processor_completed',
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        refundsEnabled,
        attempted,
        initiated,
        skippedManualMode,
        skippedMissingPayerPhone,
        failed: failedCount,
      },
      'refund processor completed',
    );
  }

  private async tryRefund(args: {
    orderId: string;
    orderCode: string;
    totalXAF: number;
    payerPhone: string;
    refundsEnabled: boolean;
  }): Promise<'initiated' | 'skipped_manual' | 'failed' | 'race_lost'> {
    if (!args.refundsEnabled) {
      this.logger.info(
        {
          event: 'refund_skipped_manual_mode',
          orderId: args.orderId,
          totalXAF: args.totalXAF,
        },
        'Refund skipped — CAMPAY_REFUNDS_ENABLED=false (manual fire mode)',
      );
      return 'skipped_manual';
    }

    // Status-guarded lock: claim the row by stamping refundInitiatedAt.
    // count===0 means another worker tick (or an admin manual flip)
    // got here first.
    const locked = await this.prisma.order.updateMany({
      where: {
        id: args.orderId,
        paymentStatus: PaymentStatus.REFUND_PENDING,
        refundInitiatedAt: null,
      },
      data: { refundInitiatedAt: new Date(), refundFailureReason: null },
    });
    if (locked.count === 0) {
      return 'race_lost';
    }

    try {
      const result = await this.campay.initiateRefund({
        amountXAF: args.totalXAF,
        toPhone: args.payerPhone,
        description: `Remboursement ChopNow ${args.orderCode}`,
        externalReference: `refund:${args.orderId}`,
      });

      // Persist Campay ref + write the "release escrow" ledger pair
      // atomically. If either fails the whole thing rolls back — next
      // sweep will see refundInitiatedAt set but no campayRef and the
      // status guard prevents double-fire.
      await this.prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: args.orderId },
          data: { refundCampayRef: result.reference },
        });
        await this.ledger.recordTransaction(
          {
            eventId: `refund_initiated:${args.orderId}`,
            eventType: LedgerEventType.REFUND_ISSUED,
            entries: [
              {
                account: LedgerAccount.CUSTOMER_ESCROW,
                amountXAF: args.totalXAF,
                orderId: args.orderId,
                description: `Refund initiated — escrow released for order ${args.orderCode}`,
              },
              {
                account: LedgerAccount.REFUND_PAYABLE,
                amountXAF: -args.totalXAF,
                orderId: args.orderId,
                description: `Refund owed to customer (order ${args.orderCode})`,
              },
            ],
          },
          tx,
        );
      });

      this.logger.info(
        {
          event: 'refund_initiated',
          orderId: args.orderId,
          totalXAF: args.totalXAF,
          campayRef: result.reference,
        },
        'refund initiated — escrow released, awaiting Campay settlement webhook',
      );
      return 'initiated';
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Roll back the lock so the next sweep retries — but capture the
      // failure reason so admin can see the row keeps bouncing.
      await this.prisma.order
        .update({
          where: { id: args.orderId },
          data: { refundInitiatedAt: null, refundFailureReason: reason },
        })
        .catch(() => undefined);
      this.logger.error(
        {
          event: 'refund_failed',
          orderId: args.orderId,
          totalXAF: args.totalXAF,
          reason,
        },
        'Campay refund call failed — row reset for retry',
      );
      return 'failed';
    }
  }
}
