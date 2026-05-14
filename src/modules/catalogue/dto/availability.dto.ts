import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';

/** Story 2.4 — 1-tap availability toggle. */
export class UpdateAvailabilityDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  isOpen!: boolean;
}

// Matches "HH:MM" 24h. Loose enough to allow 7:30 or 07:30, strict enough to
// reject obviously bad input.
const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

class DayHours {
  @ApiProperty({ example: '07:30' })
  @IsString()
  @Matches(TIME_PATTERN, { message: 'open must be HH:MM (24h)' })
  open!: string;

  @ApiProperty({ example: '21:00' })
  @IsString()
  @Matches(TIME_PATTERN, { message: 'close must be HH:MM (24h)' })
  close!: string;
}

/**
 * Story 2.4 — restaurant per-day hours. Days that are absent or null mean
 * "closed all day". Informal vendors don't use this (their `isOpen` toggle
 * is the only source).
 */
export class UpdateHoursDto {
  @ApiProperty({ type: () => DayHours, required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DayHours)
  mon?: DayHours;

  @ApiProperty({ type: () => DayHours, required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DayHours)
  tue?: DayHours;

  @ApiProperty({ type: () => DayHours, required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DayHours)
  wed?: DayHours;

  @ApiProperty({ type: () => DayHours, required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DayHours)
  thu?: DayHours;

  @ApiProperty({ type: () => DayHours, required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DayHours)
  fri?: DayHours;

  @ApiProperty({ type: () => DayHours, required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DayHours)
  sat?: DayHours;

  @ApiProperty({ type: () => DayHours, required: false })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DayHours)
  sun?: DayHours;
}
