import { Module } from '@nestjs/common';

/**
 * Epic 4 — Livraison & Dispatch.
 * Rider assignment (PostGIS geo-queries), GPS heartbeats, batching, voice proxy.
 * Listens for: order.paid → assigns rider.
 * Emits: rider.assigned, rider.arrived, order.picked_up, order.delivered.
 */
@Module({
  imports: [],
  controllers: [],
  providers: [],
  exports: [],
})
export class DispatchModule {}
