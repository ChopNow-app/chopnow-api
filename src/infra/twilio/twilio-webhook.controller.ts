import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OtpStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Public } from '../../shared/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioWebhookGuard } from './guards/twilio-webhook.guard';

/**
 * Twilio POSTs delivery status updates here once the WhatsApp/SMS message reaches
 * (or fails to reach) the recipient. Reconciles the OtpLog row that was marked
 * SENT in AuthService.requestOtp to its real terminal state — DELIVERED or FAILED.
 *
 * Authentication: `TwilioWebhookGuard` verifies X-Twilio-Signature against
 * TWILIO_AUTH_TOKEN. In `nodeEnv !== 'production'` the guard is a no-op so the
 * endpoint can be exercised with curl + integration tests don't have to mint
 * Twilio signatures.
 *
 * Webhook payload reference:
 * https://www.twilio.com/docs/usage/webhooks/messaging-webhooks#http-status-callback-requests
 */
@ApiExcludeController()
@Controller('twilio')
export class TwilioWebhookController {
  constructor(
    @InjectPinoLogger(TwilioWebhookController.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {}

  @Post('status')
  @Public()
  @UseGuards(TwilioWebhookGuard)
  @HttpCode(204)
  async onStatus(@Body() body: Record<string, string>): Promise<void> {
    const sid = body.MessageSid;
    const status = body.MessageStatus;
    if (!sid || !status) {
      this.logger.warn(
        { event: 'twilio_status_callback_malformed' },
        'Twilio status callback missing MessageSid or MessageStatus',
      );
      return;
    }

    const log = await this.prisma.otpLog.findUnique({ where: { providerMessageId: sid } });
    if (!log) {
      // Could be a non-OTP Twilio message (e.g. if we later route other messages through
      // the same callback URL). Drop silently.
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
        const reason = body.ErrorMessage || `twilio_error_${body.ErrorCode ?? 'unknown'}`;
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
}
