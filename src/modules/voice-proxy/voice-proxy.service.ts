import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { normalizePhone } from '../../shared/phone/phone.util';

// Story 4.17 / 3.17 — masked voice proxy. Each party sees the TchopNow
// voice number on caller ID; the platform bridges via Twilio. No party
// ever sees another party's raw phone number, so they cannot bypass
// the platform via direct contact.
//
// Eligibility windows per direction:
//   rider ↔ consumer    — order must be PICKED_UP or coming up to it
//                          (vendor accepted, food being delivered)
//   vendor ↔ consumer   — anytime after vendor ACCEPTED, until DELIVERED
//                          (consumer asks about address, vendor flags
//                          out-of-stock substitution, etc.)
//   vendor ↔ rider      — only when a rider has been assigned and the
//                          order is in the prep/pickup window
//                          (vendor calls rider before they arrive)
//   consumer ↔ vendor   — same as vendor ↔ consumer (symmetric)
//   consumer ↔ rider    — same as rider ↔ consumer (symmetric)

const ALL_LIVE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.ACCEPTED,
  OrderStatus.IN_PREP,
  OrderStatus.READY_PICKUP,
  OrderStatus.PICKED_UP,
]);

// Vendor ↔ rider only makes sense once a rider has been dispatched. The
// rider may not pick up yet, but they're assigned (status guard is still
// the live set; we additionally require riderId to be present).
const RIDER_INVOLVED_STATUSES = ALL_LIVE_STATUSES;

// Leg type — drives the TwiML bridge to pick the right destination
// number. Stays opaque to clients; passed as ?to= on the webhook URL.
export type CallTarget = 'consumer' | 'vendor' | 'rider';

@Injectable()
export class VoiceProxyService {
  constructor(
    @InjectPinoLogger(VoiceProxyService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly env: EnvService,
  ) {}

  // ── Rider-initiated calls ────────────────────────────────────────

  async startRiderToConsumer(orderId: string, riderUserId: string): Promise<{ callSid: string }> {
    const rider = await this.requireRider(riderUserId);
    await this.requireOrderAssignedToRider(orderId, rider.id);
    return this.bridgeCall({
      fromUserPhone: rider.user.phone,
      target: 'consumer',
      orderId,
      direction: 'rider_to_consumer',
    });
  }

  // ── Vendor-initiated calls ───────────────────────────────────────

  async startVendorToConsumer(orderId: string, vendorUserId: string): Promise<{ callSid: string }> {
    const vendor = await this.requireVendor(vendorUserId);
    await this.requireOrderForVendor(orderId, vendor.id, { needRider: false });
    return this.bridgeCall({
      fromUserPhone: vendor.whatsappPhone,
      target: 'consumer',
      orderId,
      direction: 'vendor_to_consumer',
    });
  }

  async startVendorToRider(orderId: string, vendorUserId: string): Promise<{ callSid: string }> {
    const vendor = await this.requireVendor(vendorUserId);
    await this.requireOrderForVendor(orderId, vendor.id, { needRider: true });
    return this.bridgeCall({
      fromUserPhone: vendor.whatsappPhone,
      target: 'rider',
      orderId,
      direction: 'vendor_to_rider',
    });
  }

  // ── Consumer-initiated calls ─────────────────────────────────────

  async startConsumerToVendor(
    orderId: string,
    consumerUserId: string,
  ): Promise<{ callSid: string }> {
    const order = await this.requireOrderForConsumer(orderId, consumerUserId, {
      needRider: false,
    });
    const consumer = await this.requireConsumer(consumerUserId);
    return this.bridgeCall({
      fromUserPhone: consumer.phone,
      target: 'vendor',
      orderId: order.id,
      direction: 'consumer_to_vendor',
    });
  }

  async startConsumerToRider(
    orderId: string,
    consumerUserId: string,
  ): Promise<{ callSid: string }> {
    const order = await this.requireOrderForConsumer(orderId, consumerUserId, {
      needRider: true,
    });
    const consumer = await this.requireConsumer(consumerUserId);
    return this.bridgeCall({
      fromUserPhone: consumer.phone,
      target: 'rider',
      orderId: order.id,
      direction: 'consumer_to_rider',
    });
  }

  // ── TwiML bridge ─────────────────────────────────────────────────

  // Twilio fetches the bridge URL after the originating leg answers.
  // ?to=consumer|vendor|rider picks which party to dial.
  async buildBridgeTwiml(orderId: string, target: CallTarget): Promise<string> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        deliveryPhone: true,
        vendor: { select: { whatsappPhone: true } },
        rider: { select: { user: { select: { phone: true } } } },
      },
    });
    if (!order || !ALL_LIVE_STATUSES.has(order.status)) {
      return this.hangupTwiml("La commande n'est plus active.");
    }

    let dialNumber: string | null = null;
    let copy = '';
    if (target === 'consumer') {
      dialNumber = order.deliveryPhone;
      copy = 'Connexion avec votre client TchopNow.';
    } else if (target === 'vendor') {
      dialNumber = order.vendor?.whatsappPhone ?? null;
      copy = 'Connexion avec le restaurant TchopNow.';
    } else if (target === 'rider') {
      dialNumber = order.rider?.user?.phone ?? null;
      copy = 'Connexion avec votre livreur TchopNow.';
    }

    if (!dialNumber) {
      return this.hangupTwiml('Numéro indisponible.');
    }

    const cfg = this.env.twilio;
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `  <Say language="fr-FR">${copy}</Say>`,
      `  <Dial callerId="${cfg.voiceFrom ?? ''}" timeout="30" timeLimit="170">`,
      `    <Number>${normalizePhone(dialNumber)}</Number>`,
      '  </Dial>',
      '</Response>',
    ].join('');
  }

  // ── private ──────────────────────────────────────────────────────

  private hangupTwiml(message: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `  <Say language="fr-FR">${message}</Say>`,
      '  <Hangup/>',
      '</Response>',
    ].join('');
  }

  private async bridgeCall(args: {
    fromUserPhone: string | null | undefined;
    target: CallTarget;
    orderId: string;
    direction: string;
  }): Promise<{ callSid: string }> {
    if (!args.fromUserPhone) {
      throw new NotFoundException('caller_phone_missing');
    }
    const bridgeUrl = this.buildBridgeUrl(args.orderId, args.target);
    const callSid = await this.twilio.startBridgedCall(
      normalizePhone(args.fromUserPhone),
      bridgeUrl,
    );
    this.logger.info(
      {
        event: 'voice_proxy_call_started',
        orderId: args.orderId,
        callSid,
        direction: args.direction,
      },
      'Voice proxy bridged call started',
    );
    return { callSid };
  }

  private buildBridgeUrl(orderId: string, target: CallTarget): string {
    return (
      `${this.env.appUrl}/api/webhooks/twilio/voice/bridge` +
      `?orderId=${encodeURIComponent(orderId)}` +
      `&to=${encodeURIComponent(target)}`
    );
  }

  private async requireRider(userId: string) {
    const rider = await this.prisma.rider.findUnique({
      where: { userId },
      select: { id: true, user: { select: { phone: true } } },
    });
    if (!rider) throw new NotFoundException('rider_not_found');
    return rider;
  }

  private async requireVendor(userId: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, whatsappPhone: true },
    });
    if (!vendor) throw new NotFoundException('vendor_not_found');
    return vendor;
  }

  private async requireConsumer(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    if (!user) throw new NotFoundException('user_not_found');
    return user;
  }

  private async requireOrderAssignedToRider(orderId: string, riderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, riderId: true, status: true },
    });
    if (!order || order.riderId !== riderId) throw new NotFoundException('order_not_found');
    if (!ALL_LIVE_STATUSES.has(order.status)) {
      throw new NotFoundException('order_not_found');
    }
    return order;
  }

  private async requireOrderForVendor(
    orderId: string,
    vendorId: string,
    opts: { needRider: boolean },
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, vendorId: true, status: true, riderId: true },
    });
    if (!order || order.vendorId !== vendorId) throw new NotFoundException('order_not_found');
    if (!ALL_LIVE_STATUSES.has(order.status)) {
      throw new NotFoundException('order_not_found');
    }
    if (opts.needRider && !order.riderId) {
      throw new NotFoundException('rider_not_assigned');
    }
    if (opts.needRider && !RIDER_INVOLVED_STATUSES.has(order.status)) {
      throw new NotFoundException('order_not_found');
    }
    return order;
  }

  private async requireOrderForConsumer(
    orderId: string,
    userId: string,
    opts: { needRider: boolean },
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, status: true, riderId: true },
    });
    if (!order || order.userId !== userId) throw new NotFoundException('order_not_found');
    if (!ALL_LIVE_STATUSES.has(order.status)) {
      throw new NotFoundException('order_not_found');
    }
    if (opts.needRider && !order.riderId) {
      throw new NotFoundException('rider_not_assigned');
    }
    if (opts.needRider && !RIDER_INVOLVED_STATUSES.has(order.status)) {
      throw new NotFoundException('order_not_found');
    }
    return order;
  }
}
