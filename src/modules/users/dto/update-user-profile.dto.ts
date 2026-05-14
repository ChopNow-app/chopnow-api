import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Story 1.8 — fields any authenticated user can self-update. */
export class UpdateUserProfileDto {
  @ApiProperty({ description: 'Nom affiché.', example: 'Maman Mboué', required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  displayName?: string;
}
