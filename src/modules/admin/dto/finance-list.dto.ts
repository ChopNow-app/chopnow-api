import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { RiderVehicleType, VendorStatus, VendorType } from '@prisma/client';

const MAX_PAGE = 200;

export class ListVendorBalancesDto {
  @ApiPropertyOptional({ enum: VendorStatus, enumName: 'VendorStatus' })
  @IsOptional()
  @IsEnum(VendorStatus)
  status?: VendorStatus;

  @ApiPropertyOptional({ enum: VendorType, enumName: 'VendorType' })
  @IsOptional()
  @IsEnum(VendorType)
  type?: VendorType;

  @ApiPropertyOptional({ description: 'Minimum balance in FCFA (signed)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  minBalanceXAF?: number;

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

export class ListRiderBalancesDto {
  @ApiPropertyOptional({ enum: RiderVehicleType, enumName: 'RiderVehicleType' })
  @IsOptional()
  @IsEnum(RiderVehicleType)
  vehicleType?: RiderVehicleType;

  @ApiPropertyOptional({ description: 'Minimum balance in FCFA (signed)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  minBalanceXAF?: number;

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

export class ListRefundQueueDto {
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
