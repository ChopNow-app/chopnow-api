import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';

const PHONE_PATTERN = /^(?:6[5-9]\d{7}|\+?[1-9]\d{7,14})$/;

/** A single line in the cart. The server snapshots name + price at order time. */
export class CartLineDto {
  @ApiProperty({ description: 'Item UUID (must belong to the same vendor as the cart).' })
  @IsUUID()
  itemId!: string;

  @ApiProperty({ minimum: 1, maximum: 50, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  quantity!: number;
}

export class CreateOrderDto {
  @ApiProperty({ description: 'Target vendor UUID. All cart lines must belong to it.' })
  @IsUUID()
  vendorId!: string;

  @ApiProperty({ type: () => [CartLineDto], minItems: 1, maxItems: 30 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => CartLineDto)
  items!: CartLineDto[];

  @ApiProperty({ enum: PaymentMethod, enumName: 'PaymentMethod' })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiProperty({
    required: false,
    description: 'Note for the vendor — the only client→vendor channel. Max 120 chars.',
    example: 'Sans piment',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  noteForVendor?: string;

  // ── Delivery address (Story 3.2 — inline snapshot) ──────────────────

  @ApiProperty({ example: 4.0511 })
  @Type(() => Number)
  @IsLatitude()
  deliveryLat!: number;

  @ApiProperty({ example: 9.7679 })
  @Type(() => Number)
  @IsLongitude()
  deliveryLng!: number;

  @ApiProperty({ example: 'Makepe' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  deliveryQuartier!: string;

  @ApiProperty({ required: false, example: 'Rond-Point Total Makepe' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deliveryLandmark?: string;

  @ApiProperty({ required: false, example: '2ème portail bleu après le transformateur' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deliveryDescription?: string;

  @ApiProperty({ description: 'Phone the rider will call if lost. E.164 or Cameroon local.' })
  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'deliveryPhone must be a 9-digit Cameroon number or E.164 international.',
  })
  deliveryPhone!: string;

  // ── Pre-orders (#187 — v1, INFORMAL vendors only) ────────────────────
  @ApiProperty({
    required: false,
    description:
      'Schedule the order for a future time (vendor must have acceptsPreOrders=true). ' +
      'Omit / null for immediate delivery. v1 supports same-day pre-orders only.',
    example: '2026-05-19T12:30:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduledFor?: Date;
}
