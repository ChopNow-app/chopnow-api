import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';

/**
 * Auto-refuse expired vendor decisions.
 *
 * The vendor has `ACCEPTANCE_TTL_SECONDS` to accept or refuse a new order
 * (Order.acceptanceDeadlineAt). After that, the cron flips the order to
 * REFUSED with the synthetic reason EXPIRED_NO_VENDOR_RESPONSE — same
 * effect as a human Refuse but accounted separately for vendor
 * reliability metrics.
 *
 * Runs every 10s. The partial index orders_pending_deadline_idx makes the
 * scan ~O(expired-count) regardless of total order volume.
 */
@Injectable()
export class OrdersExpiryService {
  private readonly logger = new Logger(OrdersExpiryService.name);
  static readonly EXPIRED_REASON = 'EXPIRED_NO_VENDOR_RESPONSE';

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async sweepExpired(): Promise<void> {
    const now = new Date();
    const candidates = await this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
        acceptanceDeadlineAt: { lt: now },
      },
      select: { id: true, vendorId: true, paymentStatus: true },
      take: 50,
    });
    if (candidates.length === 0) return;

    for (const order of candidates) {
      try {
        // Conditional update — guards against the human Accept happening at
        // the exact same tick (status condition fails, updateMany returns 0).
        const res = await this.prisma.order.updateMany({
          where: {
            id: order.id,
            status: { in: [OrderStatus.PENDING, OrderStatus.CONFIRMED] },
          },
          data: {
            status: OrderStatus.REFUSED,
            refusedAt: now,
            refusalReason: OrdersExpiryService.EXPIRED_REASON,
          },
        });
        if (res.count === 0) continue;

        this.events.emit(DomainEvents.ORDER_REFUSED, {
          orderId: order.id,
          vendorId: order.vendorId,
          reason: OrdersExpiryService.EXPIRED_REASON,
          refusedAt: now,
        });
        if (order.paymentStatus === PaymentStatus.PAID) {
          this.logger.warn(`Order ${order.id} auto-expired while PAID — refund needed`);
        } else {
          this.logger.log(`Order ${order.id} auto-refused (vendor did not respond within TTL)`);
        }
      } catch (err) {
        this.logger.error(`Auto-refuse failed for order ${order.id}: ${(err as Error).message}`);
      }
    }
  }
}
