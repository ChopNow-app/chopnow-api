import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../shared/decorators/roles.decorator';
import { AdminAuditInterceptor } from './admin-audit.interceptor';
import { AdminValidationService } from './admin-validation.service';
import { AdminDecisionDto } from './dto/admin-decision.dto';
import { SetVendorPreOrdersDto } from './dto/set-vendor-pre-orders.dto';

// Story 1.6 — admin routes are gated by @Roles(OPERATOR | ADMIN | SUPER_ADMIN).
// SUPER_ADMIN bypasses the @Roles() check in RolesGuard automatically.
const ADMIN_ROLES = [UserRole.OPERATOR, UserRole.ADMIN] as const;

@ApiTags('admin-validation')
@ApiBearerAuth()
@UseInterceptors(AdminAuditInterceptor)
@Controller('admin')
export class AdminValidationController {
  constructor(private readonly validation: AdminValidationService) {}

  // ── vendors ────────────────────────────────────────────────────────

  @Roles(...ADMIN_ROLES)
  @Get('vendors/pending')
  @ApiOperation({ summary: 'List vendors awaiting approval (Story 6.2)' })
  listPendingVendors() {
    return this.validation.listPendingVendors();
  }

  @Roles(...ADMIN_ROLES)
  @Post('vendors/:vendorId/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a vendor application',
    description:
      'Flips Vendor.status to ACTIVE + sets validatedAt. Fires the "🎉 en ligne" WhatsApp.',
  })
  approveVendor(@Param('vendorId', new ParseUUIDPipe()) vendorId: string) {
    return this.validation.approveVendor(vendorId);
  }

  @Roles(...ADMIN_ROLES)
  @Post('vendors/:vendorId/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject a vendor application',
    description: 'Sets REJECTED + rejectionReason. Fires WhatsApp with the reason.',
  })
  rejectVendor(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Body() dto: AdminDecisionDto,
  ) {
    return this.validation.rejectVendor(vendorId, dto.reason);
  }

  @Roles(...ADMIN_ROLES)
  @Post('vendors/:vendorId/suspend')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Suspend a vendor (Stories 1.7 + 6.2)',
    description:
      "Flips status to SUSPENDED, forces isOpen=false, and revokes the vendor's JWTs " +
      'via the Redis blacklist (Story 1.7) — their tokens stop working on the very next request.',
  })
  suspendVendor(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Body() dto: AdminDecisionDto,
  ) {
    return this.validation.suspendVendor(vendorId, dto.reason);
  }

  @Roles(...ADMIN_ROLES)
  @Post('vendors/:vendorId/unsuspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Lift a vendor suspension — clears the JWT blacklist.' })
  unsuspendVendor(@Param('vendorId', new ParseUUIDPipe()) vendorId: string) {
    return this.validation.unsuspendVendor(vendorId);
  }

  @Roles(...ADMIN_ROLES)
  @Patch('vendors/:vendorId/pre-orders')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Toggle Vendor.acceptsPreOrders (#187 follow-up)',
    description:
      'INFORMAL vendors get acceptsPreOrders=true at submission. This endpoint lets admin ' +
      'override per vendor without code changes — e.g. opting in a willing SEMI_FORMAL, ' +
      'or opting out an INFORMAL whose kitchen workflow does not support pre-orders. ' +
      'Idempotent: no DB write or audit log if the value is already what was requested.',
  })
  setVendorPreOrders(
    @Param('vendorId', new ParseUUIDPipe()) vendorId: string,
    @Body() dto: SetVendorPreOrdersDto,
  ) {
    return this.validation.setVendorPreOrders(vendorId, dto.acceptsPreOrders);
  }

  // ── riders ─────────────────────────────────────────────────────────

  @Roles(...ADMIN_ROLES)
  @Get('riders/pending')
  @ApiOperation({ summary: 'List riders awaiting KYC approval' })
  listPendingRiders() {
    return this.validation.listPendingRiders();
  }

  @Roles(...ADMIN_ROLES)
  @Post('riders/:riderId/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve a rider KYC' })
  approveRider(@Param('riderId', new ParseUUIDPipe()) riderId: string) {
    return this.validation.approveRider(riderId);
  }

  @Roles(...ADMIN_ROLES)
  @Post('riders/:riderId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a rider application' })
  rejectRider(
    @Param('riderId', new ParseUUIDPipe()) riderId: string,
    @Body() dto: AdminDecisionDto,
  ) {
    return this.validation.rejectRider(riderId, dto.reason);
  }

  @Roles(...ADMIN_ROLES)
  @Post('riders/:riderId/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend a rider (revokes JWTs immediately)' })
  suspendRider(
    @Param('riderId', new ParseUUIDPipe()) riderId: string,
    @Body() dto: AdminDecisionDto,
  ) {
    return this.validation.suspendRider(riderId, dto.reason);
  }

  @Roles(...ADMIN_ROLES)
  @Post('riders/:riderId/unsuspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Lift a rider suspension' })
  unsuspendRider(@Param('riderId', new ParseUUIDPipe()) riderId: string) {
    return this.validation.unsuspendRider(riderId);
  }
}
