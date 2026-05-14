import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Story 3.9 — both scores required (no partial ratings public-side). */
export class RateOrderDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  vendorScore!: number;

  @ApiProperty({ minimum: 1, maximum: 5, example: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  riderScore!: number;

  @ApiProperty({ required: false, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  comment?: string;
}
