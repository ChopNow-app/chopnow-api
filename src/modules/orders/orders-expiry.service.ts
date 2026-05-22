import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';

/**
 * Auto-refuse expired vendor decisions — SAFETY NET.
 *
 * Since PR #235 the precise path is a BullMQ delayed job scheduled at
 * `Order.acceptanceDeadlineAt` by `OrderLifecycleScheduler`. This cron
 * stays as a safety net for the rare cases where Redis lost the job
 * (e.g. a redeploy wiped Docker volumes). Both paths share the same
 * status-guarded updateMany so whichever fires first wins; the other
 * matches zero rows and no-ops.
 *
 * Runs every 10s. The partial index orders_pending_deadline_idx makes the
 * scan ~O(expired-count) regardless of total order volume; in normal
 * operation that count is 0 because the queue caught everything first.
 */
@Injectable()
export class OrdersExpiryService {
  static readonly EXPIRED_REASON = 'EXPIRED_NO_VENDOR_RESPONSE';

  constructor(
    @InjectPinoLogger(OrdersExpiryService.name) private readonly logger: PinoLogger,
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
          this.logger.warn(
            { event: 'order_auto_expired_while_paid', orderId: order.id, vendorId: order.vendorId },
            'Order auto-expired while PAID — refund needed',
          );
        } else {
          this.logger.info(
            { event: 'order_auto_refused', orderId: order.id, vendorId: order.vendorId },
            'Order auto-refused (vendor did not respond within TTL)',
          );
        }
      } catch (err) {
        this.logger.error(
          { event: 'order_auto_refuse_failed', orderId: order.id, error: (err as Error).message },
          'Auto-refuse failed',
        );
      }
    }
  }
}
