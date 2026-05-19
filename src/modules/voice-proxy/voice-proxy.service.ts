import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TwilioService } from '../../infra/twilio/twilio.service';
import { normalizePhone } from '../../shared/phone/phone.util';

// Story 4.17 — only orders where a rider has been dispatched and is
// actively moving through delivery are eligible for a proxy call. We
// don't expose the call button before pickup or after drop-off.
const CALL_ELIGIBLE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.ACCEPTED,
  OrderStatus.IN_PREP,
  OrderStatus.READY_PICKUP,
  OrderStatus.PICKED_UP,
]);

@Injectable()
export class VoiceProxyService {
  constructor(
    @InjectPinoLogger(VoiceProxyService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly env: EnvService,
  ) {}

  /**
   * Rider taps "Appeler le client" in the livreur app.
   *
   * Flow:
   *   1. Verify the caller is the assigned rider on this order.
   *   2. Ask Twilio to call the *rider's* phone first; the caller ID is
   *      our TchopNow voice number (never the client's number).
   *   3. When the rider answers, Twilio fetches `/api/webhooks/twilio/voice/bridge?orderId=X`
   *      which returns TwiML that <Dial>s the client's deliveryPhone — also
   *      masked behind the same TchopNow number.
   *   4. Hard 3-min cap via TwilioService.timeLimit.
   */
  async startRiderToConsumer(orderId: string, riderUserId: string): Promise<{ callSid: string }> {
    const rider = await this.prisma.rider.findUnique({
      where: { userId: riderUserId },
      select: { id: true, user: { select: { phone: true } } },
    });
    if (!rider) throw new NotFoundException('rider_not_found');

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, riderId: true, status: true, deliveryPhone: true },
    });
    if (!order || order.riderId !== rider.id) throw new NotFoundException('order_not_found');

    if (!CALL_ELIGIBLE_STATUSES.has(order.status)) {
      throw new NotFoundException('order_not_found'); // status-leak guard
    }

    const riderPhone = rider.user.phone;
    if (!riderPhone) {
      throw new NotFoundException('rider_phone_missing');
    }

    const bridgeUrl = this.buildBridgeUrl(order.id);
    const callSid = await this.twilio.startBridgedCall(normalizePhone(riderPhone), bridgeUrl);

    this.logger.info(
      {
        event: 'voice_proxy_call_started',
        orderId: order.id,
        callSid,
        direction: 'rider_to_consumer',
      },
      'Voice proxy bridged call started',
    );
    return { callSid };
  }

  /**
   * Returns the TwiML body Twilio fetches when the rider's leg answers.
   * Twilio reads the XML and dials the consumer.
   */
  async buildBridgeTwiml(orderId: string): Promise<string> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { deliveryPhone: true, status: true },
    });
    if (!order || !CALL_ELIGIBLE_STATUSES.has(order.status)) {
      // Hang up politely — refuse to bridge for stale / cancelled orders.
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Response>',
        '  <Say language="fr-FR">La commande n\'est plus active.</Say>',
        '  <Hangup/>',
        '</Response>',
      ].join('');
    }

    const cfg = this.env.twilio;
    const consumerNumber = normalizePhone(order.deliveryPhone);
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      '  <Say language="fr-FR">Connexion avec votre client TchopNow.</Say>',
      `  <Dial callerId="${cfg.voiceFrom ?? ''}" timeout="30" timeLimit="170">`,
      `    <Number>${consumerNumber}</Number>`,
      '  </Dial>',
      '</Response>',
    ].join('');
  }

  private buildBridgeUrl(orderId: string): string {
    return `${this.env.appUrl}/api/webhooks/twilio/voice/bridge?orderId=${encodeURIComponent(orderId)}`;
  }
}
