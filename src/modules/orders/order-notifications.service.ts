import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { WebPushService } from '../notifications/web-push.service';
import { DomainEvents } from '../../shared/events/domain-events';
import { OrdersExpiryService } from './orders-expiry.service';

/**
 * Fans out order-lifecycle events to interested parties via WhatsApp.
 *
 * Two listeners today:
 *   - ORDER_CREATED → pings the VENDOR ("you have a new order, you have 60s")
 *   - ORDER_REFUSED → pings the CONSUMER ("restaurant couldn't take it")
 *
 * The pilot uses the Twilio WhatsApp sandbox (no Meta template approval yet).
 * That's fine because both vendor and consumer authenticate via OTP, which
 * opens a 24h sandbox session per phone. Both audiences re-OTP frequently
 * enough that the 24h window stays warm.
 *
 * Accept-side noise hurts more than it helps for the pilot: the consumer is
 * already watching /orders/[id] and sees ACCEPTED → IN_PREP move within
 * seconds. Refuse is the painful case (60s of silence followed by a
 * "didn't reply" timeline entry), so we ping them so they know to try
 * someone else.
 */
@Injectable()
export class OrderNotificationsService {
  private readonly logger = new Logger(OrderNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly webPush: WebPushService,
  ) {}

  /**
   * Pings the vendor the moment a new order is created.
   *
   * Two-channel cascade, push-first:
   *   1. Web Push to every active subscription (PWA installed, permission granted).
   *      Wakes the device with an OS notification that deep-links to
   *      /vendor/commande/<id>. If the dashboard is already foregrounded,
   *      the SW additionally postMessages focused clients → in-app chime
   *      + dashboard refresh (no SSE needed; one channel covers both states).
   *   2. WhatsApp fallback — fires ONLY when push reached zero subscriptions
   *      (vendor hasn't installed the PWA, denied permission, or all their
   *      endpoints expired). Mutually exclusive so we never double-ping a
   *      vendor who's already getting the native notification.
   *
   * Without either, the vendor's only signal is the dashboard's 10s poll
   * — a vendor cooking on the line misses the 60s acceptance window and
   * the cron auto-refuses, surfacing as "restaurant didn't reply" to the
   * consumer.
   */
  @OnEvent(DomainEvents.ORDER_CREATED)
  async onOrderCreated(payload: {
    orderId: string;
    code?: string;
    vendorId?: string;
    userId?: string;
    paymentMethod?: string;
  }): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: payload.orderId },
        select: {
          code: true,
          totalXAF: true,
          paymentMethod: true,
          items: { select: { quantity: true } },
          vendor: { select: { whatsappPhone: true, name: true, userId: true } },
        },
      });
      if (!order) return;

      const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
      // Pilot is MoMo-only — payment has already confirmed by the time this
      // event fires (it's emitted from onPaymentSucceeded, not createOrder).
      // The label distinguishes MTN vs Orange Money so the vendor knows
      // which provider the consumer used.
      const paymentLabel =
        order.paymentMethod === 'ORANGE_MONEY' ? 'Payé via Orange Money' : 'Payé via MTN MoMo';
      const totalLabel = `${order.totalXAF.toLocaleString('fr-FR')} FCFA`;

      // 1. Web Push first.
      const pushResult = await this.webPush.sendToUser(order.vendor.userId, {
        title: `🍲 Nouvelle commande ${order.code}`,
        body: `${itemCount} plat${itemCount > 1 ? 's' : ''} · ${totalLabel} · ${paymentLabel}`,
        data: {
          kind: 'ORDER_CREATED',
          orderId: payload.orderId,
          deepLink: `/vendor/commande/${payload.orderId}`,
        },
      });

      if (pushResult.sent > 0) return; // vendor got the native notification

      // 2. WhatsApp fallback — only when push had no reachable subscriptions.
      if (!order.vendor.whatsappPhone) return;
      const body =
        `🍲 Nouvelle commande ${order.code}\n` +
        `${itemCount} plat${itemCount > 1 ? 's' : ''} · ${totalLabel} · ${paymentLabel}\n\n` +
        `Tu as 60 secondes pour accepter :\n` +
        `tchopnow.app/vendor/commande/${payload.orderId}`;
      await this.twilio.sendWhatsApp(order.vendor.whatsappPhone, body);
    } catch (err) {
      // Best-effort. A push-service outage or stale Twilio sandbox window
      // must not feed back into the order pipeline — the order is already
      // committed.
      this.logger.warn(
        `Order creation notification failed for ${payload.orderId}: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent(DomainEvents.ORDER_REFUSED)
  async onOrderRefused(payload: { orderId: string; reason: string }): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: payload.orderId },
        select: {
          code: true,
          user: { select: { phone: true } },
          vendor: { select: { name: true } },
        },
      });
      if (!order?.user.phone) return;

      const reasonLine = humanizeReason(payload.reason);
      const body =
        `Bonjour 👋 Désolé, ${order.vendor.name} n'a pas pu prendre ta commande ${order.code}.\n` +
        `${reasonLine}\n` +
        `Aucun montant débité. Tu peux réessayer avec un autre restaurant : tchopnow.app/restaurants 🍲`;

      await this.twilio.sendWhatsApp(order.user.phone, body);
    } catch (err) {
      // Notifications are best-effort — never let a delivery failure feed back
      // into the order pipeline. Log so ops can investigate if delivery
      // becomes systematically broken.
      this.logger.warn(
        `Order refusal WhatsApp failed for ${payload.orderId}: ${(err as Error).message}`,
      );
    }
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
