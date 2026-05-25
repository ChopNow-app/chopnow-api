import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CouponsService } from './coupons.service';
import { ValidateCouponDto } from './dto/validate-coupon.dto';

/**
 * Promo coupon endpoint (#167). The frontend calls /validate when the
 * consumer types a code into the /cart input, and we return the would-be
 * discount so the cart can re-render with the line "Code BIENVENUE
 * appliqué · -800 FCFA (livraison offerte)".
 *
 * Authoritative redemption happens INSIDE the order-creation transaction,
 * not here — this endpoint is read-only / advisory. It exists so the
 * user gets immediate feedback instead of learning at POST /orders that
 * their code is invalid.
 */
@ApiTags('coupons')
@ApiBearerAuth()
@Controller('coupons')
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Post('validate')
  @ApiOperation({
    summary: 'Pre-validate a promo code against the current cart',
    description:
      'Returns the discount that WOULD be applied at order creation. Authoritative ' +
      "redemption only happens inside POST /orders's transaction. " +
      'Error codes: coupon_not_found, coupon_disabled, coupon_not_yet_active, ' +
      'coupon_expired, coupon_first_order_only, coupon_min_subtotal, ' +
      'coupon_already_redeemed, coupon_exhausted.',
  })
  validate(@Req() req: Request, @Body() dto: ValidateCouponDto) {
    const userId = (req.user as { id: string }).id;
    return this.coupons.validateForUser(dto.code, userId, dto.subtotalXAF, dto.deliveryFeeXAF);
  }
}
