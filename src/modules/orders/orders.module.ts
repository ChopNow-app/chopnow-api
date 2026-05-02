import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';

/**
 * Epic 3 — Commande & Paiement.
 * Cart, order lifecycle, idempotency, ratings.
 * Emits domain events: order.created, order.paid, order.cancelled, order.delivered.
 *
 * OrdersService is the canonical example of the producer/consumer pattern —
 * see src/shared/events/domain-events.ts for the full event registry.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
