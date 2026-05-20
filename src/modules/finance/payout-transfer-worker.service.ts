import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PayoutStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CampayService } from '../../infra/campay/campay.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

// Per ADR-0005 §S3 / chopnow-api#216. Drains PENDING VendorPayout +
// RiderPayout rows, fires the actual Campay outbound transfer, and
// transitions them to IN_FLIGHT. The webhook handler at
// POST /webhooks/campay/transfer flips IN_FLIGHT → PAID once Campay
// confirms.
//
// Behaviour under `CAMPAY_TRANSFERS_ENABLED=false` (default): the worker
// runs but skips the network call — rows stay PENDING for manual fire
// in the Campay UI. This is the pilot-scale operational mode until
// Campay Go-Live + RCCM lands (#181).

const MAX_PAYOUTS_PER_RUN = 25;

@Injectable()
export class PayoutTransferWorker {
  constructor(
    @InjectPinoLogger(PayoutTransferWorker.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly campay: CampayService,
    private readonly env: EnvService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepPendingTransfers(): Promise<void> {
    const startedAt = new Date();
    const transfersEnabled = this.env.campay.transfersEnabled === true;

    let attempted = 0;
    let initiated = 0;
    let skippedManualMode = 0;
    let failedCount = 0;
    let raceLostCount = 0;

    // Vendor payouts first (weekly cron volume), then rider payouts
    // (daily, lower per-run count).
    const vendorRows = await this.prisma.vendorPayout.findMany({
      where: { status: PayoutStatus.PENDING, scheduledFor: { lte: startedAt } },
      orderBy: { scheduledFor: 'asc' },
      take: MAX_PAYOUTS_PER_RUN,
      select: { id: true, momoPhone: true, netXAF: true },
    });
    for (const p of vendorRows) {
      attempted += 1;
      const outcome = await this.tryTransferVendor(p.id, p.momoPhone, p.netXAF, transfersEnabled);
      if (outcome === 'initiated') initiated += 1;
      else if (outcome === 'skipped_manual') skippedManualMode += 1;
      else if (outcome === 'failed') failedCount += 1;
      else if (outcome === 'race_lost') raceLostCount += 1;
    }

    const riderRows = await this.prisma.riderPayout.findMany({
      where: { status: PayoutStatus.PENDING, scheduledFor: { lte: startedAt } },
      orderBy: { scheduledFor: 'asc' },
      take: MAX_PAYOUTS_PER_RUN,
      select: { id: true, momoPhone: true, netXAF: true },
    });
    for (const p of riderRows) {
      attempted += 1;
      const outcome = await this.tryTransferRider(p.id, p.momoPhone, p.netXAF, transfersEnabled);
      if (outcome === 'initiated') initiated += 1;
      else if (outcome === 'skipped_manual') skippedManualMode += 1;
      else if (outcome === 'failed') failedCount += 1;
      else if (outcome === 'race_lost') raceLostCount += 1;
    }

    this.logger.info(
      {
        event: 'payout_transfer_worker_completed',
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        transfersEnabled,
        attempted,
        initiated,
        skippedManualMode,
        failed: failedCount,
        raceLost: raceLostCount,
      },
      'payout transfer worker completed',
    );
  }

  private async tryTransferVendor(
    payoutId: string,
    momoPhone: string,
    netXAF: number,
    transfersEnabled: boolean,
  ): Promise<'initiated' | 'skipped_manual' | 'failed' | 'race_lost'> {
    return this.tryTransfer({
      kind: 'vendor',
      payoutId,
      momoPhone,
      netXAF,
      transfersEnabled,
      description: `ChopNow vendor payout ${payoutId.slice(0, 8)}`,
      externalReference: `vendor_payout:${payoutId}`,
      lockRow: () =>
        this.prisma.vendorPayout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PENDING },
          data: { status: PayoutStatus.IN_FLIGHT, sentAt: new Date() },
        }),
      onReference: (ref) =>
        this.prisma.vendorPayout.update({ where: { id: payoutId }, data: { campayRef: ref } }),
      onFail: (reason) =>
        this.prisma.vendorPayout.update({
          where: { id: payoutId },
          data: { status: PayoutStatus.FAILED, failureReason: reason },
        }),
    });
  }

  private async tryTransferRider(
    payoutId: string,
    momoPhone: string,
    netXAF: number,
    transfersEnabled: boolean,
  ): Promise<'initiated' | 'skipped_manual' | 'failed' | 'race_lost'> {
    return this.tryTransfer({
      kind: 'rider',
      payoutId,
      momoPhone,
      netXAF,
      transfersEnabled,
      description: `ChopNow rider payout ${payoutId.slice(0, 8)}`,
      externalReference: `rider_payout:${payoutId}`,
      lockRow: () =>
        this.prisma.riderPayout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PENDING },
          data: { status: PayoutStatus.IN_FLIGHT, sentAt: new Date() },
        }),
      onReference: (ref) =>
        this.prisma.riderPayout.update({ where: { id: payoutId }, data: { campayRef: ref } }),
      onFail: (reason) =>
        this.prisma.riderPayout.update({
          where: { id: payoutId },
          data: { status: PayoutStatus.FAILED, failureReason: reason },
        }),
    });
  }

  private async tryTransfer(args: {
    kind: 'vendor' | 'rider';
    payoutId: string;
    momoPhone: string;
    netXAF: number;
    transfersEnabled: boolean;
    description: string;
    externalReference: string;
    lockRow: () => Promise<{ count: number }>;
    onReference: (ref: string) => Promise<unknown>;
    onFail: (reason: string) => Promise<unknown>;
  }): Promise<'initiated' | 'skipped_manual' | 'failed' | 'race_lost'> {
    if (!args.transfersEnabled) {
      // Skip without locking — leave the row PENDING for manual fire
      // in the Campay UI. Admin then flips it via the admin endpoint.
      // (Logged once per worker tick; this is the operational signal
      // that the worker is awake but in manual mode.)
      this.logger.info(
        {
          event: 'payout_transfer_skipped_manual',
          kind: args.kind,
          payoutId: args.payoutId,
          netXAF: args.netXAF,
        },
        'payout transfer skipped — CAMPAY_TRANSFERS_ENABLED=false (manual fire mode)',
      );
      return 'skipped_manual';
    }

    // Status-guarded lock: only one worker (or one cron tick) flips
    // PENDING → IN_FLIGHT. count===0 means another path won.
    const locked = await args.lockRow();
    if (locked.count === 0) {
      return 'race_lost';
    }

    try {
      const result = await this.campay.initiateTransfer({
        amountXAF: args.netXAF,
        toPhone: args.momoPhone,
        description: args.description,
        externalReference: args.externalReference,
      });
      await args.onReference(result.reference);
      this.logger.info(
        {
          event: 'payout_transfer_initiated',
          kind: args.kind,
          payoutId: args.payoutId,
          netXAF: args.netXAF,
          campayRef: result.reference,
        },
        'payout transfer initiated — IN_FLIGHT, awaiting webhook',
      );
      return 'initiated';
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await args.onFail(reason).catch(() => {
        // If the row update itself fails, we still want to log the
        // original Campay failure — better to leave the row in
        // IN_FLIGHT than to throw the wrong error here.
      });
      this.logger.error(
        {
          event: 'payout_transfer_failed',
          kind: args.kind,
          payoutId: args.payoutId,
          netXAF: args.netXAF,
          reason,
        },
        'payout transfer failed — escalating to FAILED status',
      );
      return 'failed';
    }
  }
}
