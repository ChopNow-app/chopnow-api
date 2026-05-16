import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersExpiryService } from './orders-expiry.service';
import { OrderNotificationsService } from './order-notifications.service';

/**
 * Epic 3 — Commande & Paiement.
 *
 * Story 3.1  ✅ — cart + order creation, server-side fee math + minimum
 *                 order, X-Idempotency-Key (3.14).
 * Story 3.7  ✅ — vendor accept / refuse with reason.
 * Story 3.8  ✅ — consumer cancel before vendor acceptance.
 * Story 3.3 / 3.4 — Campay MoMo init + webhook (next PR).
 * Story 3.6 — order tracking (event already wired; client polls /orders/:id).
 *
 * OrdersService listens for payment.succeeded and flips PENDING → CONFIRMED
 * (PaymentStatus.PAID) — single side-effect path from the payments module.
 */
@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrdersExpiryService, OrderNotificationsService],
  exports: [OrdersService],
})
export class OrdersModule {}
