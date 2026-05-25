import { Module } from '@nestjs/common';
import { CouponsController } from './coupons.controller';
import { CouponsService } from './coupons.service';

/**
 * Promo coupon module (#167). Owns the validation + atomic redemption
 * primitives. OrdersModule depends on this for the in-transaction
 * redemption call in OrderCreationService.
 */
@Module({
  controllers: [CouponsController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
