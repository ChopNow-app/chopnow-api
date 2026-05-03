import { Global, Module } from '@nestjs/common';
import { OtpDeliveryService } from './otp-delivery.service';
import { TwilioService } from './twilio.service';

@Global()
@Module({
  providers: [TwilioService, OtpDeliveryService],
  exports: [TwilioService, OtpDeliveryService],
})
export class TwilioModule {}
