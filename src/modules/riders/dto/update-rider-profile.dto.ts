import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const PHONE_PATTERN = /^(?:6[5-9]\d{7}|\+?[1-9]\d{7,14})$/;

/**
 * Story 1.8 — rider self-update fields.
 *
 * Deliberately NOT in scope for MVP:
 *   - vehicleType change (transitions rider to "En validation" — admin
 *     queue from Story 6.2)
 *   - idCardPhoto / selfiePhoto / vehiclePhoto change (re-validation
 *     required — same queue dependency)
 *   - licensePlate change (admin-mediated — fraud surface)
 *   - momoPhone OTP-on-new-number confirmation (defer; admin oversight)
 */
export class UpdateRiderProfileDto {
  @ApiProperty({ required: false, example: 'Bonamoussadi' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  preferredZone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, {
    message:
      'momoPhone must be a 9-digit Cameroon number (e.g. 670000020) or an E.164 international number.',
  })
  momoPhone?: string;
}
