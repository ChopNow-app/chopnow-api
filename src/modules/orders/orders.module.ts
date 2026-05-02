import { Module } from '@nestjs/common';

/**
 * Epic 3 — Commande & Paiement.
 * Cart, order lifecycle, idempotency, ratings.
 * Emits domain events: order.created, order.paid, order.cancelled, order.delivered.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class OrdersModule {}
