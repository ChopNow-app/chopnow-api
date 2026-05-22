import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Filters for `GET /admin/audit-logs`. All optional; defaults to most-recent
 * 50 across all admins.
 */
export class ListAuditLogsDto {
  @ApiPropertyOptional({ description: 'Filter by admin user id.' })
  @IsOptional()
  @IsUUID()
  adminId?: string;

  @ApiPropertyOptional({ description: 'Exact action match — e.g. "validation.approveVendor".' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Filter by target type — e.g. "vendor", "rider", "order".' })
  @IsOptional()
  @IsString()
  targetType?: string;

  @ApiPropertyOptional({ description: 'Filter by the audited target id.' })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
