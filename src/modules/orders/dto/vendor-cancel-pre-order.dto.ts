import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Vendor's pre-order cancel-after-accept request body (#187).
 *
 * Only the optional free-text `note` field — the reason is fixed
 * (`PRE_ORDER_VENDOR_CANCEL_AFTER_ACCEPT` on the penalty row, no enum
 * variants in v1 since there's only one cancel scenario gated by this
 * endpoint). Note surfaces to the consumer in the refund-pending
 * WhatsApp so they know what happened.
 */
export class VendorCancelPreOrderDto {
  @ApiProperty({
    required: false,
    description: 'Optional explanation surfaced to the consumer (max 200 chars).',
    example: 'Pas de courant depuis 2h, impossible de finir la cuisson.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
