import { Injectable, Logger } from '@nestjs/common';
import twilio from 'twilio';
import { EnvService } from '../config/env.service';

/**
 * Thin wrapper around the Twilio SDK. Lazily instantiates the client on first
 * use so the app can boot without Twilio credentials configured (dev-friendly).
 *
 * Domain modules should inject `OtpDeliveryService` (or a future
 * `WhatsappNotificationService`) — not this raw client.
 */
@Injectable()
export class TwilioService {
  private readonly logger = new Logger(TwilioService.name);
  private _client: twilio.Twilio | null = null;

  constructor(private readonly env: EnvService) {}

  private get client(): twilio.Twilio {
    if (this._client) return this._client;
    const { sid, authToken } = this.env.requireTwilio();
    this._client = twilio(sid, authToken);
    return this._client;
  }

  /** Send a WhatsApp message via Twilio. Returns the message SID on success. */
  async sendWhatsApp(toE164: string, body: string, statusCallback?: string): Promise<string> {
    const { whatsappFrom } = this.env.requireTwilio();
    const msg = await this.client.messages.create({
      from: whatsappFrom.startsWith('whatsapp:') ? whatsappFrom : `whatsapp:${whatsappFrom}`,
      to: `whatsapp:${toE164}`,
      body,
      ...(statusCallback ? { statusCallback } : {}),
    });
    return msg.sid;
  }

  /** Send an SMS via Twilio. Returns the message SID on success. */
  async sendSms(toE164: string, body: string, statusCallback?: string): Promise<string> {
    const { smsFrom } = this.env.requireTwilio();
    const msg = await this.client.messages.create({
      from: smsFrom,
      to: toE164,
      body,
      ...(statusCallback ? { statusCallback } : {}),
    });
    return msg.sid;
  }
}
