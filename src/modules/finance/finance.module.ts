import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { FinanceService } from './finance.service';
import { LedgerService } from './ledger.service';
import { VendorPayoutCronService } from './vendor-payout-cron.service';

/**
 * Epic 7 — Finance & Cashout.
 * Vendor weekly payouts (formal), on-demand payouts (informal), rider
 * daily settlement, append-only ledger, refund flow. See ADR-0005.
 *
 * S1 (this milestone): ledger foundation only — no callers yet.
 * S2: admin financial dashboard + payout crons will wire LedgerService
 * into onPaymentSucceeded, refund flow, payout crons.
 */
@Module({
  imports: [PrismaModule],
  controllers: [],
  providers: [LedgerService, FinanceService, VendorPayoutCronService],
  exports: [LedgerService, FinanceService, VendorPayoutCronService],
})
export class FinanceModule {}
