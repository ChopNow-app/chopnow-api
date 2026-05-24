import { Injectable } from '@nestjs/common';
import { OtpChannel, OtpStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnvService } from '../config/env.service';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(
    @InjectPinoLogger(OtpDeliveryService.name) private readonly logger: PinoLogger,
    private readonly twilio: TwilioService,
    private readonly env: EnvService,
    private readonly prisma: PrismaService,
  ) {}

  async sendOtp(phone: string, code: string): Promise<OtpDeliveryResult> {
    const e164 = this.toE164(phone);
    const body = this.formatBody(code);
    const statusCallback = this.env.twilio.statusCallbackUrl;

    // Three bypass paths, evaluated in order; the first match short-circuits
    // to log-only delivery. Real Twilio call only fires when ALL three fail.
    //
    //   1. Twilio not configured → unavoidable, dev/CI environments.
    //   2. OTP_BYPASS_PHONES allowlist contains this phone → per-number
    //      opt-in. Lets staging serve real Twilio for the founder's own
    //      number while still bypassing for seeded placeholder phones
    //      (+237 670 000 1xx / 2xx) that nobody owns. Used during alpha
    //      test weeks — see ChopNow/alpha-test/protocol.md.
    //   3. OTP_DEV_BYPASS=true → global kill-switch. Local dev convenience;
    //      should NEVER be set in staging or prod (use the allowlist
    //      instead for selective bypass).
    const allowlist = this.parseBypassPhones(process.env.OTP_BYPASS_PHONES);
    const inAllowlist = allowlist.includes(e164);
    const globalBypass = process.env.OTP_DEV_BYPASS === 'true';
    if (!this.isTwilioConfigured() || inAllowlist || globalBypass) {
      const reason = !this.isTwilioConfigured()
        ? 'twilio_not_configured'
        : inAllowlist
          ? 'otp_bypass_phones_allowlist'
          : 'otp_dev_bypass';
      this.logger.warn(
        { event: 'otp_dev_stub', phone: e164, reason, code },
        '[DEV] OTP printed to logs instead of sent',
      );
      return { channel: OtpChannel.WHATSAPP, providerMessageId: 'dev-' + Date.now() };
    }

    // Try WhatsApp first
    try {
      const sid = await this.twilio.sendWhatsApp(e164, body, statusCallback);
      return { channel: OtpChannel.WHATSAPP, providerMessageId: sid };
    } catch (err) {
      this.logger.warn(
        {
          event: 'otp_whatsapp_failed_fallback_to_sms',
          phone: e164,
          error: (err as Error).message,
        },
        'WhatsApp OTP delivery failed — falling back to SMS',
      );
    }

    // SMS fallback
    const sid = await this.twilio.sendSms(e164, body, statusCallback);
    return { channel: OtpChannel.SMS, providerMessageId: sid };
  }

  /**
   * Reconcile an OtpLog row to its terminal state when Twilio reports
   * the real delivery outcome via the status callback webhook. Called
   * from `TwilioWebhookController.onStatus`.
   *
   * State machine:
   *   - delivered / read → OtpStatus.DELIVERED
   *   - failed / undelivered → OtpStatus.FAILED with a `failedReason`
   *   - any other status (queued, sent, sending) → no-op
   *
   * Guards:
   *   - Unknown SID (not one of our OTPs): drop silently.
   *   - Row already VERIFIED or FAILED: do not downgrade. Twilio
   *     sometimes retries callbacks; a late "failed" must not flip a
   *     row the user already verified.
   */
  async handleTwilioStatus(
    sid: string,
    status: string,
    errorMessage?: string,
    errorCode?: string,
  ): Promise<void> {
    const log = await this.prisma.otpLog.findUnique({ where: { providerMessageId: sid } });
    if (!log) {
      // Could be a non-OTP Twilio message (e.g. if we later route other messages
      // through the same callback URL). Drop silently.
      this.logger.debug(
        { event: 'twilio_status_unknown_sid', sid, status },
        'Twilio status callback for unknown SID',
      );
      return;
    }

    // Don't downgrade a row that's already VERIFIED or in a terminal state.
    if (log.status === OtpStatus.VERIFIED || log.status === OtpStatus.FAILED) return;

    switch (status) {
      case 'delivered':
      case 'read':
        await this.prisma.otpLog.update({
          where: { id: log.id },
          data: { status: OtpStatus.DELIVERED, deliveredAt: new Date() },
        });
        return;

      case 'failed':
      case 'undelivered': {
        const reason = errorMessage || `twilio_error_${errorCode ?? 'unknown'}`;
        await this.prisma.otpLog.update({
          where: { id: log.id },
          data: { status: OtpStatus.FAILED, failedReason: reason },
        });
        return;
      }

      // 'queued' / 'sent' / 'sending' — intermediate, no DB change.
      default:
        return;
    }
  }

  /**
   * Parse OTP_BYPASS_PHONES into an array of E.164 phones.
   *
   * Format: comma-separated, whitespace-tolerant. Both `+237670000101`
   * and `237670000101` accepted; bare 9-digit Cameroon (`670000101`) is
   * normalized via toE164. Empty / missing env var = empty array =
   * everyone goes through Twilio.
   */
  private parseBypassPhones(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => this.toE164(p));
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
