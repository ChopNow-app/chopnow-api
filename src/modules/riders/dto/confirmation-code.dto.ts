import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * Story 4.13 — 4-digit confirmation code body for the rider's picked-up
 * and delivered endpoints. Same shape for both transitions; the meaning
 * differs by route.
 */
export class ConfirmationCodeDto {
  @ApiProperty({
    description: '4-digit pickup or delivery code as shown by the vendor / consumer.',
    example: '4271',
  })
  @IsString()
  @Matches(/^\d{4}$/, { message: 'code must be exactly 4 digits.' })
  code!: string;
}
