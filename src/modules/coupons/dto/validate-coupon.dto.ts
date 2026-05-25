import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

/**
 * POST /api/v1/coupons/validate payload. The frontend sends the typed
 * code + the *expected* subtotal/delivery so the server can compute
 * the would-be discount BEFORE the order is created. The order-creation
 * endpoint re-validates everything atomically, so this DTO doesn't
 * need to be tamper-proof — values are advisory only.
 */
export class ValidateCouponDto {
  @ApiProperty({
    description: 'Promo code typed by the user.',
    example: 'bienvenue',
    maxLength: 32,
  })
  @IsString()
  @MaxLength(32)
  code!: string;

  @ApiProperty({ description: 'Cart subtotal in XAF.', example: 4500, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  subtotalXAF!: number;

  @ApiProperty({ description: 'Computed delivery fee in XAF.', example: 800, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  deliveryFeeXAF!: number;
}
