import { Global, Module } from '@nestjs/common';
import { OtpDeliveryService } from './otp-delivery.service';
import { TwilioService } from './twilio.service';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { TwilioWebhookGuard } from './guards/twilio-webhook.guard';

@Global()
@Module({
  controllers: [TwilioWebhookController],
  providers: [TwilioService, OtpDeliveryService, TwilioWebhookGuard],
  exports: [TwilioService, OtpDeliveryService, TwilioWebhookGuard],
})
export class TwilioModule {}
