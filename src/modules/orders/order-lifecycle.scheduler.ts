import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  EXPIRE_VENDOR_DECISION_JOB,
  ORDER_LIFECYCLE_QUEUE,
  PROMOTE_PRE_ORDER_JOB,
  type OrderLifecycleJobData,
} from './order-lifecycle.constants';

/**
 * Thin producer that other order-pipeline services call to schedule
 * time-based lifecycle transitions on the BullMQ `order-lifecycle` queue.
 *
 * The companion worker (OrderLifecycleProcessor) does the actual state
 * flip. Both worker handlers are idempotent (status-guarded updateMany) so
 * a delayed job that fires after the order moved through another path
 * simply matches zero rows and no-ops.
 *
 * Enqueue failures are logged but never propagate: the polling crons
 * (OrdersExpiryService at 10s, PreOrderPromotionService at 1m) are the
 * safety net.
 */
@Injectable()
export class OrderLifecycleScheduler {
  /** Shared retry policy. Workers are idempotent so 2 quick retries is safe. */
  private static readonly DEFAULT_JOB_OPTS = {
    attempts: 2,
    backoff: { type: 'exponential' as const, delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
  };

  constructor(
    @InjectPinoLogger(OrderLifecycleScheduler.name) private readonly logger: PinoLogger,
    @InjectQueue(ORDER_LIFECYCLE_QUEUE)
    private readonly queue: Queue<OrderLifecycleJobData>,
  ) {}

  /**
   * Schedule the auto-refuse fire-time for an immediate or just-promoted
   * pre-order. `fireAt` should be Order.acceptanceDeadlineAt — the worker
   * will status-check at that moment and refuse only if the order is still
   * waiting on the vendor.
   */
  async scheduleAcceptanceExpiry(orderId: string, fireAt: Date): Promise<void> {
    const delay = Math.max(0, fireAt.getTime() - Date.now());
    try {
      await this.queue.add(
        EXPIRE_VENDOR_DECISION_JOB,
        { orderId },
        {
          ...OrderLifecycleScheduler.DEFAULT_JOB_OPTS,
          delay,
          jobId: `aexp:${orderId}`,
        },
      );
    } catch (err) {
      this.logger.warn(
        {
          event: 'expiry_enqueue_failed',
          orderId,
          fireAt: fireAt.toISOString(),
          error: (err as Error).message,
        },
        'Failed to enqueue acceptance-expiry job — cron safety net will catch it',
      );
    }
  }

  /**
   * Schedule the pre-order → vendor-decision promotion at
   * `scheduledFor - PRE_ORDER_NOTIFICATION_LEAD_MINUTES`. The worker is
   * idempotent: a duplicate enqueue (same `orderId`) collapses to one job,
   * and the worker's `WHERE acceptanceDeadlineAt: null` guard skips orders
   * the cron already promoted.
   */
  async schedulePreOrderPromotion(orderId: string, fireAt: Date): Promise<void> {
    const delay = Math.max(0, fireAt.getTime() - Date.now());
    try {
      await this.queue.add(
        PROMOTE_PRE_ORDER_JOB,
        { orderId },
        {
          ...OrderLifecycleScheduler.DEFAULT_JOB_OPTS,
          delay,
          jobId: `pop:${orderId}`,
        },
      );
    } catch (err) {
      this.logger.warn(
        {
          event: 'pre_order_promotion_enqueue_failed',
          orderId,
          fireAt: fireAt.toISOString(),
          error: (err as Error).message,
        },
        'Failed to enqueue pre-order promotion job — cron safety net will catch it',
      );
    }
  }
}
