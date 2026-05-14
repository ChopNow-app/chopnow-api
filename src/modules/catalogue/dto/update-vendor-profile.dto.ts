import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const PHONE_PATTERN = /^(?:6[5-9]\d{7}|\+?[1-9]\d{7,14})$/;

/**
 * Story 1.8 — vendor self-update fields.
 *
 * Deliberately NOT in scope for MVP:
 *   - quartier / pointOfReference / landmark move (needs Story 2.15
 *     landmark distance check + admin re-validation queue from 6.2)
 *   - commissionRate (admin-only — never editable from /vendors/me)
 *   - badge / vendorType (admin re-classification, separate flow)
 *   - momoPhone OTP-on-new-number confirmation (defer; admin oversight
 *     covers MVP launch)
 */
export class UpdateVendorProfileDto {
  @ApiProperty({ required: false, example: 'Chez Maman Mboué' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiProperty({
    required: false,
    example: 'La meilleure cuisine de Makepe — plats du jour à partir de 1 500 FCFA.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    required: false,
    description:
      'New MoMo number. No OTP-on-new-number confirmation in MVP — admin oversight handles fraud cases at launch.',
  })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, {
    message:
      'momoPhone must be a 9-digit Cameroon number (e.g. 670000000) or an E.164 international number.',
  })
  momoPhone?: string;
}
