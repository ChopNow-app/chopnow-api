import { Module } from '@nestjs/common';
import { RidersController } from './riders.controller';
import { RidersService } from './riders.service';

/**
 * Rider domain — onboarding (Story 1.4), availability (Story 4.x),
 * GPS heartbeats, reliability scoring. KYC photos land in the R2
 * `rider-kyc/` prefix (signed admin URLs only — public bucket access
 * is never granted to these objects).
 */
@Module({
  controllers: [RidersController],
  providers: [RidersService],
  exports: [RidersService],
})
export class RidersModule {}
