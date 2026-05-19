import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../shared/decorators/roles.decorator';
import { FinanceService } from '../finance/finance.service';

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
}
