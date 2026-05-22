import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { WebPushService } from '../notifications/web-push.service';
import { OrdersExpiryService } from './orders-expiry.service';
import {
  CONSUMER_ORDER_REFUSED_JOB,
  ORDER_NOTIFICATIONS_QUEUE,
  VENDOR_NEW_ORDER_JOB,
  type ConsumerOrderRefusedJobData,
  type OrderNotificationJobData,
  type VendorNewOrderJobData,
} from './order-notifications.constants';

/**
 * BullMQ worker that actually delivers order-lifecycle notifications.
 *
 * Replaces the in-process send-from-OnEvent path. The producer
 * (OrderNotificationsService) enqueues a minimal `{ orderId }` payload; the
 * worker re-fetches the order so the message body reflects current state.
 *
 * Failure modes:
 *   - Pre-conditions (order missing, no phone + no push subs): return
 *     normally → BullMQ marks job complete, no retry. These are "nothing to
 *     do," not transient.
 *   - Transient (Twilio 5xx, web-push transport error): exception
 *     propagates → BullMQ retries with exponential backoff per the job's
 *     `attempts` + `backoff` config set at enqueue time.
 *   - After all attempts: job lands in the failed lane (kept by
 *     removeOnFail: { count: 1000 }) for ops inspection.
 */
@Processor(ORDER_NOTIFICATIONS_QUEUE)
export class OrderNotificationsProcessor extends WorkerHost {
  constructor(
    @InjectPinoLogger(OrderNotificationsProcessor.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly webPush: WebPushService,
  ) {
    super();
  }

  async process(job: Job<OrderNotificationJobData>): Promise<void> {
    switch (job.name) {
      case VENDOR_NEW_ORDER_JOB:
        await this.handleVendorNewOrder(job.data as VendorNewOrderJobData, job);
        return;
      case CONSUMER_ORDER_REFUSED_JOB:
        await this.handleConsumerOrderRefused(job.data as ConsumerOrderRefusedJobData, job);
        return;
      default:
        this.logger.warn(
          { event: 'order_notification_unknown_job', jobName: job.name, jobId: job.id },
          'Unknown job name on order-notifications queue — ignoring',
        );
    }
  }

  /**
   * Pings the vendor the moment a new order is created.
   *
   * Two-channel cascade, push-first:
   *   1. Web Push to every active subscription (PWA installed, permission granted).
   *   2. WhatsApp fallback — fires ONLY when push reached zero subscriptions.
   *
   * Mutually exclusive so we never double-ping. Exceptions from Twilio or
   * the push transport propagate → BullMQ retries the whole job (idempotent
   * cost: an extra push payload to already-pinged subs, fine).
   */
  async handleVendorNewOrder(data: VendorNewOrderJobData, job: Job): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: data.orderId },
      select: {
        code: true,
        totalXAF: true,
        paymentMethod: true,
        items: { select: { quantity: true } },
        vendor: { select: { whatsappPhone: true, name: true, userId: true } },
      },
    });
    if (!order) {
      this.logger.warn(
        { event: 'order_notification_order_missing', orderId: data.orderId, jobId: job.id },
        'Order not found at notification time — skipping',
      );
      return;
    }

    const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
    const paymentLabel =
      order.paymentMethod === 'ORANGE_MONEY' ? 'Payé via Orange Money' : 'Payé via MTN MoMo';
    const totalLabel = `${order.totalXAF.toLocaleString('fr-FR')} FCFA`;

    const pushResult = await this.webPush.sendToUser(order.vendor.userId, {
      title: `🍲 Nouvelle commande ${order.code}`,
      body: `${itemCount} plat${itemCount > 1 ? 's' : ''} · ${totalLabel} · ${paymentLabel}`,
      data: {
        kind: 'ORDER_CREATED',
        orderId: data.orderId,
        deepLink: `/vendor/commande/${data.orderId}`,
      },
    });
    if (pushResult.sent > 0) return;

    if (!order.vendor.whatsappPhone) return;
    const body =
      `🍲 Nouvelle commande ${order.code}\n` +
      `${itemCount} plat${itemCount > 1 ? 's' : ''} · ${totalLabel} · ${paymentLabel}\n\n` +
      `Tu as 60 secondes pour accepter :\n` +
      `tchopnow.app/vendor/commande/${data.orderId}`;
    await this.twilio.sendWhatsApp(order.vendor.whatsappPhone, body);
  }

  async handleConsumerOrderRefused(data: ConsumerOrderRefusedJobData, job: Job): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: data.orderId },
      select: {
        code: true,
        user: { select: { phone: true } },
        vendor: { select: { name: true } },
      },
    });
    if (!order?.user.phone) {
      this.logger.warn(
        { event: 'order_refused_phone_missing', orderId: data.orderId, jobId: job.id },
        'Consumer phone missing on refusal notification — skipping',
      );
      return;
    }

    const reasonLine = humanizeReason(data.reason);
    const body =
      `Bonjour 👋 Désolé, ${order.vendor.name} n'a pas pu prendre ta commande ${order.code}.\n` +
      `${reasonLine}\n` +
      `Aucun montant débité. Tu peux réessayer avec un autre restaurant : tchopnow.app/restaurants 🍲`;

    await this.twilio.sendWhatsApp(order.user.phone, body);
  }
}

// Same mapping as the consumer-side OrderTimeline.humanizeRefusal — duplicated
// rather than imported because they live in different repos and the strings
// need to be edited by hand in both anyway.
function humanizeReason(reason: string): string {
  const [code, ...rest] = reason.split(':');
  const note = rest.join(':').trim();
  const map: Record<string, string> = {
    ITEM_OUT_OF_STOCK: 'Le plat commandé est épuisé.',
    CLOSED: 'Le restaurant est actuellement fermé.',
    TOO_MANY_ORDERS: 'Le restaurant est trop chargé pour le moment.',
    POWER_OUTAGE: 'Le restaurant fait face à une coupure de courant.',
    OTHER: "Autre motif (voir détail dans l'app).",
    [OrdersExpiryService.EXPIRED_REASON]:
      "Le restaurant n'a pas répondu dans le temps imparti — il était probablement très occupé.",
  };
  const label = map[code.trim()] ?? 'La commande a été refusée.';
  return note ? `${label} (${note})` : label;
}
