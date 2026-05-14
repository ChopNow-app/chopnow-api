import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Story 3.7 — vendor refusal reasons. "Coupure de courant" is non-penalising. */
export enum RefusalReason {
  ITEM_OUT_OF_STOCK = 'ITEM_OUT_OF_STOCK',
  CLOSED = 'CLOSED',
  TOO_MANY_ORDERS = 'TOO_MANY_ORDERS',
  POWER_OUTAGE = 'POWER_OUTAGE',
  OTHER = 'OTHER',
}

export class RefuseOrderDto {
  @ApiProperty({ enum: RefusalReason })
  @IsEnum(RefusalReason)
  reason!: RefusalReason;

  @ApiProperty({ required: false, description: 'Free-text note (required when reason=OTHER).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
