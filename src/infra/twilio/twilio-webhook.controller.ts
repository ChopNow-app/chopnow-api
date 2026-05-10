import { Body, Controller, ForbiddenException, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OtpStatus } from '@prisma/client';
import type { Request } from 'express';
import { validateRequest } from 'twilio';
import { Public } from '../../shared/decorators/public.decorator';
import { EnvService } from '../config/env.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Twilio POSTs delivery status updates here once the WhatsApp/SMS message reaches
 * (or fails to reach) the recipient. Reconciles the OtpLog row that was marked
 * SENT in AuthService.requestOtp to its real terminal state — DELIVERED or FAILED.
 *
 * In dev (NODE_ENV=development) signature validation is skipped so the endpoint
 * can be exercised with curl. In prod the signature is enforced; an attacker
 * forging this would otherwise be able to flip any OtpLog row to DELIVERED.
 *
 * Webhook payload reference:
 * https://www.twilio.com/docs/usage/webhooks/messaging-webhooks#http-status-callback-requests
 */
@ApiExcludeController()
@Controller('twilio')
export class TwilioWebhookController {
  private readonly logger = new Logger(TwilioWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  @Post('status')
  @Public()
  @HttpCode(204)
  async onStatus(@Req() req: Request, @Body() body: Record<string, string>): Promise<void> {
    if (this.env.nodeEnv === 'production') this.assertTwilioSignature(req);

    const sid = body.MessageSid;
    const status = body.MessageStatus;
    if (!sid || !status) {
      this.logger.warn('twilio status callback missing MessageSid or MessageStatus');
      return;
    }

    const log = await this.prisma.otpLog.findUnique({ where: { providerMessageId: sid } });
    if (!log) {
      // Could be a non-OTP Twilio message (e.g. if we later route other messages through
      // the same callback URL). Drop silently.
      this.logger.debug(`twilio status for unknown SID ${sid} (status=${status})`);
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

  private assertTwilioSignature(req: Request): void {
    const { authToken, statusCallbackUrl } = this.env.twilio;
    if (!authToken || !statusCallbackUrl) {
      throw new ForbiddenException('webhook not configured');
    }
    const signature = req.header('x-twilio-signature') ?? '';
    const valid = validateRequest(
      authToken,
      signature,
      statusCallbackUrl,
      req.body as Record<string, string>,
    );
    if (!valid) throw new ForbiddenException('invalid twilio signature');
  }
}
