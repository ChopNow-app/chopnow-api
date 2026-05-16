import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { VendorType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsLatitude,
  IsLongitude,
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

  @ApiProperty({
    description: 'Nom complet du propriétaire (gérant). Used for KYC + payment receipts.',
    example: 'Marie Mboué',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  ownerName!: string;

  @ApiProperty({
    description: 'Type de vendeur — détermine le badge affiché + le tier KYC.',
    enum: VendorType,
    example: VendorType.INFORMAL,
    required: false,
    default: VendorType.INFORMAL,
  })
  @IsOptional()
  @IsEnum(VendorType)
  type?: VendorType;

  @ApiProperty({ description: 'Quartier de Douala.', example: 'Makepe' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  quartier!: string;

  @ApiProperty({
    description:
      'Latitude WGS84. Captured via the browser geolocation API from the vendor phone. ' +
      'Optional — when absent the service falls back to Douala city center (legacy behavior).',
    example: 4.0826,
    required: false,
    minimum: -90,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @ApiProperty({
    description: 'Longitude WGS84. Same source/constraints as latitude.',
    example: 9.7679,
    required: false,
    minimum: -180,
    maximum: 180,
  })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

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

  // Multi-item onboarding (#12) — up to 2 extra dishes captured as flat
  // fields (avoids multipart JSON-array parsing gymnastics). The first
  // item still gets the hero photo; extras are name + price only, which
  // keeps the form fast on mobile and the validation surface small. The
  // vendor adds more items via the /vendor dashboard once activated.

  @ApiProperty({ description: "Nom d'un 2e plat (optionnel).", required: false, example: 'Ndolè' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  extraItem1Name?: string;

  @ApiProperty({ description: 'Prix du 2e plat en FCFA.', required: false, example: 2500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  extraItem1PriceXAF?: number;

  @ApiProperty({ description: "Nom d'un 3e plat (optionnel).", required: false, example: 'Eru' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  extraItem2Name?: string;

  @ApiProperty({ description: 'Prix du 3e plat en FCFA.', required: false, example: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  extraItem2PriceXAF?: number;
}
