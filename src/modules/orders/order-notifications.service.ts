import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DomainEvents } from '../../shared/events/domain-events';
import {
  CONSUMER_ORDER_REFUSED_JOB,
  ORDER_NOTIFICATIONS_QUEUE,
  VENDOR_NEW_ORDER_JOB,
  type OrderNotificationJobData,
} from './order-notifications.constants';

/**
 * Listens to domain events and enqueues notification jobs onto the
 * `order-notifications` BullMQ queue. The actual WhatsApp + Web Push
 * delivery lives in `OrderNotificationsProcessor`.
 *
 * Why a queue: the previous in-process path silently lost the
 * notification on transient failure (Twilio 5xx, push transport blip).
 * Symptom was "vendor didn't get the order → cron auto-refuses 60s later
 * → consumer sees 'restaurant didn't reply'." With a queue + retries we
 * get 3 chances at delivery before giving up, and permanent failures
 * land in the BullMQ failed lane for ops inspection.
 *
 * Two job types today:
 *   - vendor-new-order   ← ORDER_CREATED
 *   - consumer-order-refused ← ORDER_REFUSED
 */
@Injectable()
export class OrderNotificationsService {
  /**
   * Retry policy applied to every enqueued notification:
   *   - attempts: 3
   *   - backoff: exponential starting at 5s → ~5s, 25s, 125s
   * Covers transient Twilio 5xx + push transport errors. Past 3 attempts
   * the job stops retrying; it sits in the failed lane (kept by
   * removeOnFail.count) for inspection.
   */
  private static readonly DEFAULT_JOB_OPTS = {
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { count: 1000 },
  };

  constructor(
    @InjectPinoLogger(OrderNotificationsService.name) private readonly logger: PinoLogger,
    @InjectQueue(ORDER_NOTIFICATIONS_QUEUE)
    private readonly notificationsQueue: Queue<OrderNotificationJobData>,
  ) {}

  @OnEvent(DomainEvents.ORDER_CREATED)
  async onOrderCreated(payload: { orderId: string }): Promise<void> {
    try {
      // Job ID = orderId so duplicate ORDER_CREATED emits (defensive — the
      // event is emitted once today, but a retry-on-the-emitter path would
      // otherwise enqueue twice) collapse to a single job.
      await this.notificationsQueue.add(
        VENDOR_NEW_ORDER_JOB,
        { orderId: payload.orderId },
        { ...OrderNotificationsService.DEFAULT_JOB_OPTS, jobId: `vno:${payload.orderId}` },
      );
    } catch (err) {
      // The enqueue itself failing (Redis unreachable) is logged but never
      // feeds back into the order pipeline — the order is already committed.
      this.logger.warn(
        {
          event: 'order_notification_enqueue_failed',
          jobName: VENDOR_NEW_ORDER_JOB,
          orderId: payload.orderId,
          error: (err as Error).message,
        },
        'Failed to enqueue vendor new-order notification — order still proceeds',
      );
    }
  }

  @OnEvent(DomainEvents.ORDER_REFUSED)
  async onOrderRefused(payload: { orderId: string; reason: string }): Promise<void> {
    try {
      await this.notificationsQueue.add(
        CONSUMER_ORDER_REFUSED_JOB,
        { orderId: payload.orderId, reason: payload.reason },
        { ...OrderNotificationsService.DEFAULT_JOB_OPTS, jobId: `cor:${payload.orderId}` },
      );
    } catch (err) {
      this.logger.warn(
        {
          event: 'order_notification_enqueue_failed',
          jobName: CONSUMER_ORDER_REFUSED_JOB,
          orderId: payload.orderId,
          error: (err as Error).message,
        },
        'Failed to enqueue consumer refusal notification',
      );
    }
  }
}
