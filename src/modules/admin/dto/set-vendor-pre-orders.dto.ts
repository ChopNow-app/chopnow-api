import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Admin toggle for `Vendor.acceptsPreOrders` (#187 follow-up).
 *
 * The flag is set to `true` automatically when a vendor submits as
 * INFORMAL; this endpoint lets admin override per-vendor (e.g., enabling
 * pre-orders for a SEMI_FORMAL vendor on request, or disabling it for an
 * INFORMAL vendor whose kitchen workflow doesn't support it).
 */
export class SetVendorPreOrdersDto {
  @ApiProperty({ description: 'Whether the vendor should accept pre-orders.' })
  @IsBoolean()
  acceptsPreOrders!: boolean;
}
