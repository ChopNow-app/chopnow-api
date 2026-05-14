import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Reject / suspend reason. Required for suspension, optional for rejection (admin can use the rejectionReason text instead). */
export class AdminDecisionDto {
  @ApiProperty({
    required: false,
    description: 'Free-text reason — shown to the vendor/rider in their WhatsApp notification.',
    example: "Photo de pièce d'identité illisible",
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
