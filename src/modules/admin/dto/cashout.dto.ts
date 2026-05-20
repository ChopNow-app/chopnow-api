import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
import { CashoutRequestStatus } from '@prisma/client';

const MAX_PAGE = 200;

export class ListCashoutRequestsDto {
  @ApiPropertyOptional({ enum: CashoutRequestStatus })
  @IsOptional()
  @IsEnum(CashoutRequestStatus)
  status?: CashoutRequestStatus;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class RejectCashoutRequestDto {
  @IsString()
  @MaxLength(200)
  reason!: string;
}
