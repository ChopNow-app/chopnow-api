import { Module } from '@nestjs/common';
import { CampayModule } from '../../infra/campay/campay.module';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { CampayRefundWebhookController } from './campay-refund-webhook.controller';
import { CampayTransferWebhookController } from './campay-transfer-webhook.controller';
import { FinanceService } from './finance.service';
import { LedgerService } from './ledger.service';
import { PayoutEscalationService } from './payout-escalation.service';
import { PayoutTransferWorker } from './payout-transfer-worker.service';
import { RefundProcessorService } from './refund-processor.service';
import { RiderPayoutCronService } from './rider-payout-cron.service';
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
  imports: [PrismaModule, CampayModule],
  controllers: [CampayTransferWebhookController, CampayRefundWebhookController],
  providers: [
    LedgerService,
    FinanceService,
    VendorPayoutCronService,
    RiderPayoutCronService,
    PayoutTransferWorker,
    RefundProcessorService,
    PayoutEscalationService,
  ],
  exports: [
    LedgerService,
    FinanceService,
    VendorPayoutCronService,
    RiderPayoutCronService,
    PayoutTransferWorker,
    RefundProcessorService,
    PayoutEscalationService,
  ],
})
export class FinanceModule {}
