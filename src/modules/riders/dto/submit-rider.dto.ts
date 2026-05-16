import { ApiProperty } from '@nestjs/swagger';
import { RiderVehicleType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Story 1.4 — Inscription Livreur.
 *
 * Multipart POST. Text fields below + up to 3 files:
 *   - idCardPhoto    (required, all vehicleTypes)
 *   - selfiePhoto    (required, all vehicleTypes)
 *   - vehiclePhoto   (required for MOTO/CAR/BICYCLE; absent for ON_FOOT)
 *
 * License plate rules:
 *   - MOTO, CAR  → required
 *   - BICYCLE    → optional/ignored
 *   - ON_FOOT    → absent
 */

const PHONE_PATTERN = /^(?:6[5-9]\d{7}|\+?[1-9]\d{7,14})$/;
// Cameroon plates can carry visual spaces ("LT 1234 AB"). The frontend
// normalizes (strips spaces, uppercases) before submitting; we accept both
// the visible form (with spaces) and the normalized form, then re-normalize
// in the service before persisting. 15-char ceiling accommodates the
// widest format observed in the field.
const PLATE_PATTERN = /^[A-Z0-9 -]{4,15}$/;

export class SubmitRiderDto {
  @ApiProperty({ description: 'Nom complet du livreur.', example: 'Jean Mboué' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ description: 'Cameroon local or international E.164.', example: '670000020' })
  @IsString()
  @Matches(PHONE_PATTERN, {
    message:
      'phone must be a 9-digit Cameroon number (e.g. 670000020) or an E.164 international number.',
  })
  phone!: string;

  @ApiProperty({ enum: RiderVehicleType, example: RiderVehicleType.MOTO })
  @IsEnum(RiderVehicleType)
  vehicleType!: RiderVehicleType;

  @ApiProperty({
    description: 'Zone de livraison préférée (quartier, secteur).',
    example: 'Makepe',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  preferredZone?: string;

  @ApiProperty({
    description:
      'Numéro de plaque (requis pour MOTO et CAR ; optionnel pour BICYCLE ; absent pour ON_FOOT). Lettres majuscules, chiffres et tirets.',
    example: 'LT1234',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(PLATE_PATTERN, {
    message:
      'licensePlate must be 4-15 chars: uppercase letters, digits, spaces, or dashes ' +
      '(spaces are stripped before persisting).',
  })
  licensePlate?: string;

  @ApiProperty({ description: 'Cameroon local or international E.164.', example: '670000020' })
  @IsString()
  @Matches(PHONE_PATTERN, {
    message:
      'momoPhone must be a 9-digit Cameroon number (e.g. 670000020) or an E.164 international number.',
  })
  momoPhone!: string;
}
