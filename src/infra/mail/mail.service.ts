import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { EnvService } from '../config/env.service';

/**
 * Resend-backed transactional email.
 *
 * Used by:
 *   - Story 1.12 admin password reset
 *   - Future: vendor / rider summary emails, dispute notifications
 *
 * In dev (no RESEND_API_KEY) it logs the email instead of sending.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private _client: Resend | null = null;

  constructor(private readonly env: EnvService) {}

  private get client(): Resend {
    if (this._client) return this._client;
    const { resendApiKey } = this.env.requireMail();
    this._client = new Resend(resendApiKey);
    return this._client;
  }

  async send(opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<{ id: string }> {
    if (!this.env.mail.resendApiKey) {
      this.logger.warn(
        `[DEV] RESEND_API_KEY not set — would send to ${opts.to}: "${opts.subject}"`,
      );
      return { id: 'dev-' + Date.now() };
    }

    const { from } = this.env.requireMail();
    const res = await this.client.emails.send({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });

    if (res.error) {
      throw new Error(`Resend send failed: ${res.error.message}`);
    }
    if (!res.data?.id) {
      throw new Error('Resend send returned no message id');
    }
    return { id: res.data.id };
  }
}
