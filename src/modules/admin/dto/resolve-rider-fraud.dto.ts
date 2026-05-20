import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class ResolveRiderFraudDto {
  @ApiProperty({ enum: ['SUSPEND', 'WARN'], description: 'What to do with the rider' })
  @IsIn(['SUSPEND', 'WARN'])
  riderAction!: 'SUSPEND' | 'WARN';

  @ApiProperty({ description: 'Whether to compensate the vendor for the lost food' })
  @IsBoolean()
  vendorCompensation!: boolean;

  @ApiProperty({ description: 'Whether to queue a refund to the consumer' })
  @IsBoolean()
  consumerRefund!: boolean;

  @ApiProperty({ description: 'Free-text note captured in refusalReason + audit log' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  note!: string;
}
