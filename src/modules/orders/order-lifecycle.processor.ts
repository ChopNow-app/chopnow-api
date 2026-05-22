import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';
import { OrdersExpiryService } from './orders-expiry.service';
import { OrderLifecycleScheduler } from './order-lifecycle.scheduler';
import {
  EXPIRE_VENDOR_DECISION_JOB,
  ORDER_LIFECYCLE_QUEUE,
  PROMOTE_PRE_ORDER_JOB,
  type ExpireVendorDecisionJobData,
  type OrderLifecycleJobData,
  type PromotePreOrderJobData,
} from './order-lifecycle.constants';
import { ACCEPTANCE_TTL_SECONDS } from './orders.service';

/**
 * BullMQ worker that handles time-based order lifecycle transitions.
 *
 * The state flips are intentionally identical to the polling crons
 * (OrdersExpiryService, PreOrderPromotionService) — same status guards,
 * same emits — so the two paths are interchangeable. Whichever fires
 * first wins; the other matches zero rows and no-ops.
 *
 * This worker is the precise path (fires at the exact deadline). The
 * crons are the safety net (catch anything Redis lost).
 */
@Processor(ORDER_LIFECYCLE_QUEUE)
export class OrderLifecycleProcessor extends WorkerHost {
  constructor(
    @InjectPinoLogger(OrderLifecycleProcessor.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly scheduler: OrderLifecycleScheduler,
  ) {
    super();
  }

  async process(job: Job<OrderLifecycleJobData>): Promise<void> {
    switch (job.name) {
      case EXPIRE_VENDOR_DECISION_JOB:
        await this.expireVendorDecision(job.data as ExpireVendorDecisionJobData, job);
        return;
      case PROMOTE_PRE_ORDER_JOB:
        await this.promotePreOrder(job.data as PromotePreOrderJobData, job);
        return;
      default:
        this.logger.warn(
          { event: 'order_lifecycle_unknown_job', jobName: job.name, jobId: job.id },
          'Unknown job name on order-lifecycle queue — ignoring',
        );
    }
  }

  /**
   * Mirror of `OrdersExpiryService.sweepExpired()` per-order — the queue
   * fires this at exactly `Order.acceptanceDeadlineAt`. The status guard
   * ensures we don't refuse an order the vendor already accepted in the
   * interim.
   */
  async expireVendorDecision(data: ExpireVendorDecisionJobData, job: Job): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: data.orderId },
      select: { id: true, vendorId: true, status: true, paymentStatus: true },
    });
    if (!order) {
      this.logger.warn(
        { event: 'expire_order_missing', orderId: data.orderId, jobId: job.id },
        'Order not found at expiry time — skipping',
      );
      return;
    }
    if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.CONFIRMED) {
      // Vendor accepted (ACCEPTED) or already terminal (REFUSED, CANCELLED,
      // EXPIRED, DELIVERED). The cron would skip too — no-op.
      return;
    }

    const now = new Date();
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
    if (res.count === 0) return; // raced — vendor accepted between findUnique + updateMany

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
  }

  /**
   * Mirror of `PreOrderPromotionService.sweep()` per-order — the queue
   * fires this at exactly `scheduledFor - PRE_ORDER_NOTIFICATION_LEAD`.
   * Sets acceptanceDeadlineAt, emits ORDER_CREATED, and schedules the
   * follow-on auto-refuse expiry so the chain stays on the precise path.
   */
  async promotePreOrder(data: PromotePreOrderJobData, job: Job): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: data.orderId },
      select: {
        id: true,
        code: true,
        vendorId: true,
        userId: true,
        paymentMethod: true,
        status: true,
        paymentStatus: true,
        acceptanceDeadlineAt: true,
        scheduledFor: true,
      },
    });
    if (!order) {
      this.logger.warn(
        { event: 'promote_order_missing', orderId: data.orderId, jobId: job.id },
        'Pre-order not found at promotion time — skipping',
      );
      return;
    }
    if (
      order.status !== OrderStatus.CONFIRMED ||
      order.paymentStatus !== PaymentStatus.PAID ||
      order.acceptanceDeadlineAt !== null
    ) {
      // Already promoted (cron beat us), or no longer eligible. No-op.
      return;
    }

    const now = new Date();
    const deadline = new Date(now.getTime() + ACCEPTANCE_TTL_SECONDS * 1000);
    const res = await this.prisma.order.updateMany({
      where: { id: order.id, acceptanceDeadlineAt: null },
      data: { acceptanceDeadlineAt: deadline },
    });
    if (res.count === 0) return; // lost the race to the cron or admin path

    this.events.emit(DomainEvents.ORDER_CREATED, {
      orderId: order.id,
      code: order.code,
      vendorId: order.vendorId,
      userId: order.userId,
      paymentMethod: order.paymentMethod,
    });

    // Chain the follow-on auto-refuse expiry so the next step stays on the
    // delayed-job fast path rather than waiting for the next cron tick.
    await this.scheduler.scheduleAcceptanceExpiry(order.id, deadline);

    this.logger.info(
      {
        event: 'pre_order_promoted',
        orderId: order.id,
        vendorId: order.vendorId,
        scheduledFor: order.scheduledFor,
      },
      'Pre-order promoted via lifecycle queue',
    );
  }
}
