import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';
import { ACCEPTANCE_TTL_SECONDS, PRE_ORDER_NOTIFICATION_LEAD_MINUTES } from './orders.service';

/**
 * Pre-order promotion cron (#187 — v1).
 *
 * Runs every minute. Finds pre-orders where:
 *   - paymentStatus is PAID (consumer paid, order is locked in)
 *   - status is CONFIRMED (vendor hasn't accepted yet)
 *   - scheduledFor - PRE_ORDER_NOTIFICATION_LEAD_MINUTES is now or past
 *   - acceptanceDeadlineAt is still null (not yet promoted)
 *
 * For each, status-guarded updateMany sets `acceptanceDeadlineAt` and
 * emits `ORDER_CREATED` — same shape as the immediate flow's onPaymentSucceeded
 * emit, so the existing vendor push + WhatsApp fallback listener fires without
 * needing to know this was a pre-order.
 *
 * Status guard is on `acceptanceDeadlineAt: null` so a double-tick of the cron
 * (or a concurrent admin force-promote) matches zero rows on the second pass —
 * no double notification.
 */
@Injectable()
export class PreOrderPromotionService {
  constructor(
    @InjectPinoLogger(PreOrderPromotionService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    const now = new Date();
    const promoteCutoff = new Date(now.getTime() + PRE_ORDER_NOTIFICATION_LEAD_MINUTES * 60_000);

    const candidates = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        scheduledFor: { not: null, lte: promoteCutoff },
        acceptanceDeadlineAt: null,
      },
      select: {
        id: true,
        code: true,
        vendorId: true,
        userId: true,
        paymentMethod: true,
        scheduledFor: true,
      },
      take: 50,
    });
    if (candidates.length === 0) return;

    for (const order of candidates) {
      try {
        // Status-guarded — acceptanceDeadlineAt: null at the WHERE level
        // catches the rare cron-vs-admin race + a concurrent double-tick.
        const res = await this.prisma.order.updateMany({
          where: { id: order.id, acceptanceDeadlineAt: null },
          data: {
            acceptanceDeadlineAt: new Date(now.getTime() + ACCEPTANCE_TTL_SECONDS * 1000),
          },
        });
        if (res.count === 0) continue; // someone else promoted this row first

        this.events.emit(DomainEvents.ORDER_CREATED, {
          orderId: order.id,
          code: order.code,
          vendorId: order.vendorId,
          userId: order.userId,
          paymentMethod: order.paymentMethod,
        });

        this.logger.info(
          {
            event: 'pre_order_promoted',
            orderId: order.id,
            vendorId: order.vendorId,
            scheduledFor: order.scheduledFor,
          },
          'Pre-order promoted to vendor decision queue',
        );
      } catch (err) {
        this.logger.error(
          {
            event: 'pre_order_promotion_failed',
            orderId: order.id,
            error: (err as Error).message,
          },
          'Pre-order promotion failed',
        );
      }
    }
  }
}
