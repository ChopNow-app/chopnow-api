import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Story 2.0 — Onboarding Vendeur Informel.
 *
 * The 5-screen form (chopnow-app frontend) is collapsed into a single
 * multipart POST: text fields below + two files (`profilePhoto`,
 * `firstItemPhoto`) sent in the same request.
 */

// Same phone pattern as RequestOtpDto. Cameroon local OR international E.164.
const PHONE_PATTERN = /^(?:6[5-9]\d{7}|\+?[1-9]\d{7,14})$/;

/** Declared capacity (Écran 4) — 3 discrete buckets mapped to integer rows. */
export enum DeclaredCapacity {
  LT_10 = 'LT_10', // < 10 plats/day → mapped to 8
  R_10_30 = 'R_10_30', // 10-30 plats/day → mapped to 30
  GT_30 = 'GT_30', // > 30 plats/day → mapped to 50
}

export const CAPACITY_TO_INT: Record<DeclaredCapacity, number> = {
  [DeclaredCapacity.LT_10]: 8,
  [DeclaredCapacity.R_10_30]: 30,
  [DeclaredCapacity.GT_30]: 50,
};

export class SubmitVendorDto {
  @ApiProperty({ description: 'Nom de la cuisine.', example: 'Chez Maman Mboué' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ description: 'Quartier de Douala.', example: 'Makepe' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  quartier!: string;

  @ApiProperty({
    description: 'Point de repère (optionnel).',
    example: 'En face de la pharmacie Sainte-Marie',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pointOfReference?: string;

  @ApiProperty({
    description: 'WhatsApp phone — Cameroon local or international E.164.',
    example: '670000000',
  })
  @IsString()
  @Matches(PHONE_PATTERN, {
    message:
      'whatsappPhone must be a 9-digit Cameroon number (e.g. 670000000) or an E.164 international number.',
  })
  whatsappPhone!: string;

  @ApiProperty({
    description: 'MTN MoMo or Orange Money phone — Cameroon local or E.164.',
    example: '670000000',
  })
  @IsString()
  @Matches(PHONE_PATTERN, {
    message:
      'momoPhone must be a 9-digit Cameroon number (e.g. 670000000) or an E.164 international number.',
  })
  momoPhone!: string;

  @ApiProperty({
    description: 'Capacité déclarée (Écran 4).',
    enum: DeclaredCapacity,
    example: DeclaredCapacity.R_10_30,
  })
  @IsEnum(DeclaredCapacity)
  declaredCapacity!: DeclaredCapacity;

  @ApiProperty({ description: 'Nom du premier plat.', example: 'Poulet DG' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  firstItemName!: string;

  @ApiProperty({
    description: 'Prix du premier plat en FCFA (entier, positif).',
    example: 3000,
  })
  @Type(() => Number) // multipart bodies arrive as strings — coerce
  @IsInt()
  @Min(100) // sanity floor; smallest market unit on local MoMo is 5 FCFA, but a real plat is >= 100
  firstItemPriceXAF!: number;
}
