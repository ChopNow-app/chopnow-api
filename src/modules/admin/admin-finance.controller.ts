import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Roles } from '../../shared/decorators/roles.decorator';
import { FinanceService } from '../finance/finance.service';
import { ListCashoutRequestsDto, RejectCashoutRequestDto } from './dto/cashout.dto';
import {
  ListRefundQueueDto,
  ListRiderBalancesDto,
  ListVendorBalancesDto,
} from './dto/finance-list.dto';

const ADMIN_ROLES = [UserRole.OPERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN] as const;

@ApiTags('admin-finance')
@ApiBearerAuth()
@Controller('admin')
export class AdminFinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Roles(...ADMIN_ROLES)
  @Get('vendors/:vendorId/balance')
  @ApiOperation({
    summary: 'Vendor balance — read from LedgerEntry, signed (positive = platform owes vendor)',
    description:
      "Returns the vendor's current balance plus per-component breakdown " +
      '(gross, commission, penalty, adjustments) accumulated since the last ' +
      'paid VendorPayout (or vendor creation if none). Trusted flag drives ' +
      'the on-demand cashout admin UX per ADR-0005.',
  })
  getVendorBalance(@Param('vendorId', ParseUUIDPipe) vendorId: string) {
    return this.finance.getVendorBalance(vendorId);
  }

  @Roles(...ADMIN_ROLES)
  @Get('riders/:riderId/balance')
  @ApiOperation({
    summary: 'Rider balance — read from LedgerEntry, signed (positive = platform owes rider)',
    description:
      "Returns the rider's current balance plus per-component breakdown " +
      '(gross, adjustments) accumulated since the last paid RiderPayout. ' +
      'Riders have no commission or penalty surface in v1 — they earn the ' +
      'rider share of the delivery fee directly. See ADR-0005.',
  })
  getRiderBalance(@Param('riderId', ParseUUIDPipe) riderId: string) {
    return this.finance.getRiderBalance(riderId);
  }

  @Roles(...ADMIN_ROLES)
  @Get('finance/vendor-balances')
  @ApiOperation({
    summary: 'Paginated list of vendor balances (sorted by balance DESC)',
    description:
      'Drives the admin financial dashboard. Filter by VendorStatus, ' +
      'VendorType, and minimum balance. Pagination via offset/limit (pilot ' +
      'scope — switch to cursor-based when row counts demand it).',
  })
  listVendorBalances(@Query() query: ListVendorBalancesDto) {
    return this.finance.listVendorBalances(query);
  }

  @Roles(...ADMIN_ROLES)
  @Get('finance/rider-balances')
  @ApiOperation({
    summary: 'Paginated list of rider balances (sorted by balance DESC)',
  })
  listRiderBalances(@Query() query: ListRiderBalancesDto) {
    return this.finance.listRiderBalances(query);
  }

  @Roles(...ADMIN_ROLES)
  @Get('finance/refund-queue')
  @ApiOperation({
    summary: 'Refund worklist — orders in PaymentStatus.REFUND_PENDING, oldest first',
    description:
      'Manual ops worklist until Story 3.8 (Campay refund API) wires the ' +
      'automated refund flow. Surfaces order code, vendor name, total, and ' +
      'days since the refund was queued.',
  })
  listRefundQueue(@Query() query: ListRefundQueueDto) {
    return this.finance.listRefundQueue(query);
  }

  @Roles(...ADMIN_ROLES)
  @Get('finance/cashout-requests')
  @ApiOperation({
    summary: 'Cashout request queue — INFORMAL vendor on-demand cashouts (ADR-0005, 7.2b)',
    description:
      'Paginated list of vendor-side cashout requests, oldest first. Filter ' +
      'by CashoutRequestStatus. Each row carries vendor name, requested amount, ' +
      'age in hours, and the live isTrusted flag.',
  })
  listCashoutRequests(@Query() query: ListCashoutRequestsDto) {
    return this.finance.listCashoutRequests(query);
  }

  @Roles(...ADMIN_ROLES)
  @Post('finance/cashout-requests/:requestId/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a cashout request — creates a VendorPayout via the 7.2a path',
    description:
      'Reads live balance, applies the same negative-balance + minimum-amount ' +
      'guards as the weekly cron, creates a VendorPayout (status PENDING) with ' +
      'paired VENDOR_PAYABLE / CAMPAY_FLOAT ledger entries. Refuses if balance ' +
      'changed below MIN_CASHOUT_XAF since request, or open dispute appeared.',
  })
  approveCashoutRequest(@Param('requestId', ParseUUIDPipe) requestId: string, @Req() req: Request) {
    const admin = req.user as { id: string };
    return this.finance.approveCashoutRequest(requestId, admin.id);
  }

  @Roles(...ADMIN_ROLES)
  @Post('finance/cashout-requests/:requestId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject a cashout request with a reason' })
  async rejectCashoutRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() dto: RejectCashoutRequestDto,
    @Req() req: Request,
  ) {
    const admin = req.user as { id: string };
    await this.finance.rejectCashoutRequest(requestId, admin.id, dto.reason);
    return { ok: true };
  }
}
