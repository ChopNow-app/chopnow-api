import { Module } from '@nestjs/common';
import { CampayModule } from '../../infra/campay/campay.module';
import { CampayWebhookController } from './campay-webhook.controller';
import { CampayWebhookGuard } from './guards/campay-webhook.guard';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Epic 3 + 7 — Paiements & encaissements.
 *
 * Story 3.3 ✅ — MTN MoMo via Campay (USSD collect + webhook)
 * Story 3.4 ✅ — Orange Money via Campay (same flow, different provider)
 * Story 3.5 ✅ — Cash on delivery (no payment call; order stays PENDING
 *                until vendor accept)
 * Story 3.14 ✅ — Idempotency: Redis lock on /pay + webhook + Order
 *                 .paymentReference @unique
 *
 * Deferred:
 *   - Story 7.10 refunds (Campay reverse-collect)
 *   - Story 7.12 circuit breaker / degraded mode
 *   - Webhook IP allowlist at nginx (Hetzner prod box)
 */
@Module({
  imports: [CampayModule],
  controllers: [PaymentsController, CampayWebhookController],
  providers: [PaymentsService, CampayWebhookGuard],
  exports: [PaymentsService, CampayWebhookGuard],
})
export class PaymentsModule {}
