import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ManualMarkPaidDto {
  @ApiProperty({ description: 'Campay transaction reference from the manual fire' })
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  campayRef!: string;

  @ApiPropertyOptional({ description: 'Free-text audit note' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
