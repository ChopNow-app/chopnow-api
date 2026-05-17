import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
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
  ) {}

  /**
   * Pings the vendor's WhatsApp the moment a new order is created.
   *
   * Without this, the vendor's only signal is the dashboard's 10s poll. A
   * vendor cooking on the line who isn't staring at the phone misses the
   * 60s acceptance window entirely and the order gets auto-refused by the
   * cron — a self-inflicted "restaurant didn't reply" experience that
   * burns trust with the consumer.
   *
   * Body is deliberately short + urgent + actionable: code, item count,
   * total, payment method, deep-link to the countdown screen. Vendor taps
   * the link in WhatsApp and lands on /vendor/commande/<id>.
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
          vendor: { select: { whatsappPhone: true, name: true } },
        },
      });
      if (!order?.vendor.whatsappPhone) return;

      const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
      const paymentLabel = order.paymentMethod === 'CASH' ? 'Cash à la livraison' : 'Payé via MoMo';
      const body =
        `🍲 Nouvelle commande ${order.code}\n` +
        `${itemCount} plat${itemCount > 1 ? 's' : ''} · ${order.totalXAF.toLocaleString('fr-FR')} FCFA · ${paymentLabel}\n\n` +
        `Tu as 60 secondes pour accepter :\n` +
        `tchopnow.app/vendor/commande/${payload.orderId}`;

      await this.twilio.sendWhatsApp(order.vendor.whatsappPhone, body);
    } catch (err) {
      // Best-effort. Twilio outage or stale sandbox window must not feed
      // back into the order pipeline — the order is already committed.
      this.logger.warn(
        `Order creation WhatsApp failed for ${payload.orderId}: ${(err as Error).message}`,
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
