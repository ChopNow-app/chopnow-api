import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Roles } from '../../shared/decorators/roles.decorator';
import { AdminRiderFraudService } from './admin-rider-fraud.service';
import { ResolveRiderFraudDto } from './dto/resolve-rider-fraud.dto';

const ADMIN_ROLES = [UserRole.OPERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN] as const;

@ApiTags('admin-rider-fraud')
@ApiBearerAuth()
@Controller('admin/orders')
export class AdminRiderFraudController {
  constructor(private readonly riderFraud: AdminRiderFraudService) {}

  @Roles(...ADMIN_ROLES)
  @Get('stuck-pickup')
  @ApiOperation({
    summary: 'List Orders stuck in PICKED_UP > 2h — admin rider-fraud triage queue',
    description:
      'Synchronous version of the StuckPickupDetectorService cron output. Returns ' +
      'orders where the rider scanned pickup but never marked delivered, oldest first. ' +
      'Powers the admin /admin/finance → Incidents livreurs tab.',
  })
  listStuckPickups() {
    return this.riderFraud.listStuckPickups();
  }

  @Roles(...ADMIN_ROLES)
  @Post(':orderId/resolve-rider-fraud')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve a rider-fraud incident (Order stuck in PICKED_UP)',
    description:
      'Atomic resolution flow for the scenario where a rider scanned pickup ' +
      'but never marked DELIVERED. Admin picks any combination of: queue a ' +
      'consumer refund (paymentStatus → REFUND_PENDING, RefundProcessor drains ' +
      'it), compensate the vendor via an ADJUSTMENT ledger entry, and either ' +
      'SUSPEND the rider (status flip + JWT revoke) or WARN them ' +
      '(reliabilityScore decrement). Order always ends CANCELLED with refusalReason ' +
      'set to "RIDER_FRAUD: <note>". Per ADR-0005 §S3.',
  })
  resolveRiderFraud(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: ResolveRiderFraudDto,
    @Req() req: Request,
  ) {
    const admin = req.user as { id: string };
    return this.riderFraud.resolveRiderFraud(orderId, admin.id, dto);
  }
}
