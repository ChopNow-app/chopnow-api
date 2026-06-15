import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PHONE_PATTERN = /^(?:6[5-9]\d{7}|\+?[1-9]\d{7,14}|0\d{8,9})$/;

/** Story 3.2 — create or update a saved address. */
export class UpsertAddressDto {
  @ApiProperty({ required: false, example: 'Maison' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  label?: string;

  @ApiProperty({
    required: false,
    description: 'Free-form description (e.g. "2ème portail bleu après le transformateur").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty({ required: false, example: 'Makepe' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  quartier?: string;

  @ApiProperty({ required: false, description: 'Landmark UUID (Story 2.15).' })
  @IsOptional()
  @IsUUID()
  landmarkId?: string;

  @ApiProperty({ example: 4.0511 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;

  @ApiProperty({ example: 9.7679 })
  @Type(() => Number)
  @IsLongitude()
  lng!: number;

  @ApiProperty({
    required: false,
    description: "Delivery phone. Defaults to the user's account phone at order time if unset.",
  })
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, {
    message:
      'phone must be a Cameroon number (6XXXXXXXX), local format (0XXXXXXXXX) or E.164 (+XXXXXXXXXXX).',
  })
  phone?: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
