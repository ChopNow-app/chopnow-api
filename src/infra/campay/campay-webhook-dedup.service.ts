import { Injectable } from '@nestjs/common';
import { CampayWebhookEventType, Prisma } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';

// Per ADR-0005 S3 / chopnow-api#88. Persistence-layer idempotency for
// Campay webhooks. INSERT-first pattern: the (eventType, reference)
// unique constraint on `campay_webhook_events` causes the second
// webhook for the same Campay reference to fail with Prisma error
// P2002. We catch that and convert it into `{ isFirst: false }`, so the
// caller skips its state-mutating logic.
//
// This complements the existing status-guarded `updateMany` defense
// (used by PaymentsService.handleWebhook + FinanceService.handleTransferWebhook).
// Both layers must hold: the dedup table prevents redundant work + audit
// records; the status guard prevents the rare case where two webhooks
// arrive within the same millisecond and both win the dedup insert race.

const PRISMA_UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class CampayWebhookDedupService {
  constructor(
    @InjectPinoLogger(CampayWebhookDedupService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {}

  // Records the webhook in the dedup table. Returns isFirst=true if we
  // won the insert race (caller should run state-mutating logic) or
  // isFirst=false if a previous webhook for this (eventType, reference)
  // was already processed.
  async markProcessed(args: {
    eventType: CampayWebhookEventType;
    reference: string;
    payload: unknown;
  }): Promise<{ isFirst: boolean; existingResult: string | null }> {
    try {
      await this.prisma.campayWebhookEvent.create({
        data: {
          eventType: args.eventType,
          reference: args.reference,
          payload: args.payload as Prisma.InputJsonValue,
        },
      });
      return { isFirst: true, existingResult: null };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === PRISMA_UNIQUE_VIOLATION
      ) {
        // Look up the prior row's `result` so the caller can log what
        // the original processing did (handy for ops triage of dup
        // floods). Single read on a unique index.
        const existing = await this.prisma.campayWebhookEvent.findUnique({
          where: { eventType_reference: { eventType: args.eventType, reference: args.reference } },
          select: { result: true, processedAt: true },
        });
        this.logger.info(
          {
            event: 'campay_webhook_dedup_hit',
            eventType: args.eventType,
            reference: args.reference,
            originalResult: existing?.result ?? null,
            originalProcessedAt: existing?.processedAt ?? null,
          },
          'Campay webhook duplicate — dedup hit, no state mutation',
        );
        return { isFirst: false, existingResult: existing?.result ?? null };
      }
      throw err;
    }
  }

  // Records what the first webhook actually did. Cheap audit + makes
  // dedup-hit logs more useful ("the original payload set status to PAID").
  // Called by the caller after the state-mutating logic settles. Not
  // critical-path: best-effort, log on failure.
  async recordResult(args: {
    eventType: CampayWebhookEventType;
    reference: string;
    result: string;
  }): Promise<void> {
    try {
      await this.prisma.campayWebhookEvent.updateMany({
        where: { eventType: args.eventType, reference: args.reference, result: null },
        data: { result: args.result },
      });
    } catch (err) {
      this.logger.warn(
        {
          event: 'campay_webhook_result_record_failed',
          eventType: args.eventType,
          reference: args.reference,
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to record dedup result — non-critical',
      );
    }
  }
}
