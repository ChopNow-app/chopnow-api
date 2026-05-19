import { Injectable } from '@nestjs/common';
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

  /**
   * Story 4.17 — start a masked Twilio Voice call.
   *
   * Twilio first calls `toE164` (the leg holding the phone). On answer, Twilio
   * fetches `bridgeUrl` which must return TwiML that <Dial>s the other party.
   * Both parties see `voiceFrom` as the caller ID — neither sees the other's
   * real number. POC-4 validated this flow on 2026-04-13.
   */
  async startBridgedCall(toE164: string, bridgeUrl: string): Promise<string> {
    const cfg = this.env.twilio;
    if (!cfg.voiceFrom) throw new Error('TWILIO_VOICE_FROM is not set');
    const call = await this.client.calls.create({
      from: cfg.voiceFrom,
      to: toE164,
      url: bridgeUrl,
      // Hard 3-min cap (spec) — Twilio terminates the bridge after timeLimit s.
      timeLimit: 180,
    });
    return call.sid;
  }
}
