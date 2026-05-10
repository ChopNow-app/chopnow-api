import { Injectable, Logger } from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { EnvService } from '../config/env.service';
import { TwilioService } from './twilio.service';

export interface OtpDeliveryResult {
  channel: OtpChannel;
  providerMessageId: string;
}

/**
 * Story 1.1 — sends OTPs via WhatsApp first, falls back to SMS on failure.
 * Returns the channel actually used so AuthService can log it on the OtpLog row.
 *
 * In dev (no Twilio configured) it logs the code instead of sending — devs can
 * read the OTP from the server logs without burning credits or needing Twilio.
 */
@Injectable()
export class OtpDeliveryService {
  private readonly logger = new Logger(OtpDeliveryService.name);

  constructor(
    private readonly twilio: TwilioService,
    private readonly env: EnvService,
  ) {}

  async sendOtp(phone: string, code: string): Promise<OtpDeliveryResult> {
    const e164 = this.toE164(phone);
    const body = this.formatBody(code);
    const statusCallback = this.env.twilio.statusCallbackUrl;

    // Dev convenience: skip live delivery if Twilio isn't configured.
    if (!this.isTwilioConfigured()) {
      this.logger.warn(
        `[DEV] Twilio not configured — OTP for ${e164} is "${code}" (would send via WhatsApp)`,
      );
      return { channel: OtpChannel.WHATSAPP, providerMessageId: 'dev-' + Date.now() };
    }

    // Try WhatsApp first
    try {
      const sid = await this.twilio.sendWhatsApp(e164, body, statusCallback);
      return { channel: OtpChannel.WHATSAPP, providerMessageId: sid };
    } catch (err) {
      this.logger.warn(
        `WhatsApp delivery failed for ${e164}: ${(err as Error).message}. Falling back to SMS.`,
      );
    }

    // SMS fallback
    const sid = await this.twilio.sendSms(e164, body, statusCallback);
    return { channel: OtpChannel.SMS, providerMessageId: sid };
  }

  private isTwilioConfigured(): boolean {
    const { sid, authToken, whatsappFrom, smsFrom } = this.env.twilio;
    if (!sid || !authToken || !whatsappFrom || !smsFrom) return false;
    // Reject the placeholder values shipped in .env.example so a fresh
    // clone falls into dev-log mode instead of hitting Twilio with garbage creds.
    if (!sid.startsWith('AC') || sid.includes('xxxx')) return false;
    if (authToken.toLowerCase().includes('your_twilio')) return false;
    return true;
  }

  /** Cameroon 9-digit phone → +237XXXXXXXXX. Pass-through when already E.164. */
  private toE164(phone: string): string {
    if (phone.startsWith('+')) return phone;
    if (/^6[5-9]\d{7}$/.test(phone)) return `+237${phone}`;
    // Dev: bare international digits (e.g. "33695412820") → prepend '+'
    return `+${phone}`;
  }

  private formatBody(code: string): string {
    return `Votre code ChopNow : ${code}\nCe code expire dans 5 minutes. Ne le partagez jamais.`;
  }
}
