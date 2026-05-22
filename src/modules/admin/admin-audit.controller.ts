import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../shared/decorators/roles.decorator';
import { AdminAuditService } from './admin-audit.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@ApiTags('admin-audit')
@ApiBearerAuth()
@Controller('admin/audit-logs')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  // SUPER_ADMIN only — audit-log access is sensitive (who-did-what is a
  // power tool; granting it to OPERATOR / ADMIN would let them surveil
  // each other's actions).
  @Roles(UserRole.SUPER_ADMIN)
  @Get()
  @ApiOperation({
    summary: 'List admin audit log entries (Phase A2) — SUPER_ADMIN only',
    description:
      'Append-only record of every admin write request. Filterable by adminId, action, ' +
      'targetType, targetId. Results sorted by createdAt DESC, default page size 50, max 200. ' +
      'Sensitive payload fields (password, code, token, recoveryCode, ...) are [REDACTED] at ' +
      'write time so this endpoint never echoes them.',
  })
  list(@Query() q: ListAuditLogsDto) {
    return this.audit.list({
      adminId: q.adminId,
      action: q.action,
      targetType: q.targetType,
      targetId: q.targetId,
      limit: q.limit,
      offset: q.offset,
    });
  }
}
