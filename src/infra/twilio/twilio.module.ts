import { Global, Module } from '@nestjs/common';
import { OtpDeliveryService } from './otp-delivery.service';
import { TwilioService } from './twilio.service';
import { TwilioWebhookController } from './twilio-webhook.controller';

@Global()
@Module({
  controllers: [TwilioWebhookController],
  providers: [TwilioService, OtpDeliveryService],
  exports: [TwilioService, OtpDeliveryService],
})
export class TwilioModule {}
