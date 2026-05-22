import { Body, Controller, HttpCode, Post, UseGuards, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Public } from '../../shared/decorators/public.decorator';
import { TwilioWebhookGuard } from './guards/twilio-webhook.guard';
import { OtpDeliveryService } from './otp-delivery.service';

/**
 * Twilio POSTs delivery status updates here once the WhatsApp/SMS
 * message reaches (or fails to reach) the recipient. The reconciliation
 * logic (state machine + don't-downgrade guard) lives in
 * `OtpDeliveryService.handleTwilioStatus` — this controller is a pure
 * delegate that parses the form-encoded body and hands off.
 *
 * Authentication: `TwilioWebhookGuard` verifies X-Twilio-Signature
 * against TWILIO_AUTH_TOKEN. In `nodeEnv !== 'production'` the guard is
 * a no-op so the endpoint can be exercised with curl + integration
 * tests don't have to mint Twilio signatures.
 *
 * Webhook payload reference:
 * https://www.twilio.com/docs/usage/webhooks/messaging-webhooks#http-status-callback-requests
 */
@ApiExcludeController()
@Controller({ path: 'twilio', version: VERSION_NEUTRAL })
export class TwilioWebhookController {
  constructor(
    @InjectPinoLogger(TwilioWebhookController.name) private readonly logger: PinoLogger,
    private readonly otpDelivery: OtpDeliveryService,
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
    await this.otpDelivery.handleTwilioStatus(sid, status, body.ErrorMessage, body.ErrorCode);
  }
}
