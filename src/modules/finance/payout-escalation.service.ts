import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PayoutStatus, PaymentStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';

// Per ADR-0005 §S3 / chopnow-api#85. Surfaces failed and stuck money
// movements so admin can act before customers / vendors / riders
// notice. No state mutation — purely observability + a queryable list
// for the admin dashboard. Admin remediation endpoints live in
// AdminFinanceController (manual-mark-paid, retry).
//
// Stale thresholds:
//   - VendorPayout / RiderPayout IN_FLIGHT for > 30 minutes →
//     Campay's webhook is overdue. Either lost the callback or Campay
//     is in a bad state. Escalate.
//   - Order in REFUND_PENDING with refundInitiatedAt set + refundCampayRef
//     also set but no refundedAt for > 30 minutes → same shape.

const STALE_IN_FLIGHT_MINUTES = 30;

export interface EscalationItem {
  kind: 'vendor_payout' | 'rider_payout' | 'refund';
  id: string;
  status: PayoutStatus | 'STALE_REFUND';
  netXAF: number;
  momoPhone: string | null;
  failureReason: string | null;
  scheduledFor: Date | null;
  sentAt: Date | null;
  ageMinutes: number;
  // Vendor + rider payouts carry a vendorId / riderId; refunds carry
  // an orderId. UI uses this to deep-link to the right detail view.
  contextId: string;
}

@Injectable()
export class PayoutEscalationService {
  constructor(
    @InjectPinoLogger(PayoutEscalationService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweepEscalations(): Promise<void> {
    const items = await this.listEscalations();
    if (items.length === 0) {
      this.logger.info(
        { event: 'payout_escalation_completed', flagged: 0 },
        'payout escalation sweep completed — nothing to surface',
      );
      return;
    }
    for (const item of items) {
      this.logger.error(
        {
          event: 'payout_needs_escalation',
          kind: item.kind,
          id: item.id,
          contextId: item.contextId,
          status: item.status,
          netXAF: item.netXAF,
          failureReason: item.failureReason,
          ageMinutes: item.ageMinutes,
        },
        'payout / refund needs admin attention',
      );
    }
    this.logger.warn(
      { event: 'payout_escalation_completed', flagged: items.length },
      'payout escalation sweep completed',
    );
  }

  // Used by GET /admin/finance/escalations. Returns the current list of
  // things that need admin attention. Cheap at pilot scope — three
  // queries over small filtered subsets.
  async listEscalations(): Promise<EscalationItem[]> {
    const now = Date.now();
    const staleThreshold = new Date(now - STALE_IN_FLIGHT_MINUTES * 60_000);

    const vendorFailed = await this.prisma.vendorPayout.findMany({
      where: {
        OR: [
          { status: PayoutStatus.FAILED },
          { status: PayoutStatus.IN_FLIGHT, sentAt: { lt: staleThreshold } },
        ],
      },
      select: {
        id: true,
        vendorId: true,
        status: true,
        netXAF: true,
        momoPhone: true,
        failureReason: true,
        scheduledFor: true,
        sentAt: true,
      },
      orderBy: { scheduledFor: 'asc' },
    });

    const riderFailed = await this.prisma.riderPayout.findMany({
      where: {
        OR: [
          { status: PayoutStatus.FAILED },
          { status: PayoutStatus.IN_FLIGHT, sentAt: { lt: staleThreshold } },
        ],
      },
      select: {
        id: true,
        riderId: true,
        status: true,
        netXAF: true,
        momoPhone: true,
        failureReason: true,
        scheduledFor: true,
        sentAt: true,
      },
      orderBy: { scheduledFor: 'asc' },
    });

    const staleRefunds = await this.prisma.order.findMany({
      where: {
        paymentStatus: PaymentStatus.REFUND_PENDING,
        refundCampayRef: { not: null },
        refundInitiatedAt: { lt: staleThreshold },
        refundedAt: null,
      },
      select: {
        id: true,
        totalXAF: true,
        payerPhone: true,
        refundFailureReason: true,
        refundInitiatedAt: true,
      },
      orderBy: { refundInitiatedAt: 'asc' },
    });

    const items: EscalationItem[] = [];
    for (const p of vendorFailed) {
      items.push({
        kind: 'vendor_payout',
        id: p.id,
        contextId: p.vendorId,
        status: p.status,
        netXAF: p.netXAF,
        momoPhone: p.momoPhone,
        failureReason: p.failureReason,
        scheduledFor: p.scheduledFor,
        sentAt: p.sentAt,
        ageMinutes: Math.floor((now - (p.sentAt ?? p.scheduledFor).getTime()) / 60_000),
      });
    }
    for (const p of riderFailed) {
      items.push({
        kind: 'rider_payout',
        id: p.id,
        contextId: p.riderId,
        status: p.status,
        netXAF: p.netXAF,
        momoPhone: p.momoPhone,
        failureReason: p.failureReason,
        scheduledFor: p.scheduledFor,
        sentAt: p.sentAt,
        ageMinutes: Math.floor((now - (p.sentAt ?? p.scheduledFor).getTime()) / 60_000),
      });
    }
    for (const o of staleRefunds) {
      items.push({
        kind: 'refund',
        id: o.id,
        contextId: o.id,
        status: 'STALE_REFUND',
        netXAF: o.totalXAF,
        momoPhone: o.payerPhone,
        failureReason: o.refundFailureReason,
        scheduledFor: o.refundInitiatedAt,
        sentAt: o.refundInitiatedAt,
        ageMinutes: o.refundInitiatedAt
          ? Math.floor((now - o.refundInitiatedAt.getTime()) / 60_000)
          : 0,
      });
    }

    // Sort oldest first — admin works the top of the queue.
    items.sort((a, b) => b.ageMinutes - a.ageMinutes);
    return items;
  }
}
