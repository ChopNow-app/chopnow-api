import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { DomainEvents } from '../../shared/events/domain-events';
import { OrdersExpiryService } from './orders-expiry.service';

/**
 * Fans out vendor-decision events to the consumer via WhatsApp.
 *
 * The pilot uses the Twilio WhatsApp sandbox (no Meta template approval yet).
 * That's fine because every consumer authenticates with an OTP before
 * ordering, which opens a 24h sandbox session per phone — well within the
 * window for a vendor-decision notification to actually deliver.
 *
 * Only REFUSED is wired right now. Accept-side noise hurts more than it
 * helps for the pilot: the consumer is already watching /orders/[id] and
 * sees ACCEPTED → IN_PREP move within seconds. Refuse is the painful case
 * (60s of silence followed by a "didn't reply" timeline entry), so we ping
 * them so they know to try someone else.
 */
@Injectable()
export class OrderNotificationsService {
  private readonly logger = new Logger(OrderNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
  ) {}

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
