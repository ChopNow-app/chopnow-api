import { Module } from '@nestjs/common';
import { DispatchService } from './dispatch.service';

/**
 * Epic 4 — Livraison & Dispatch.
 *
 * Story 4.1 ✅ — MVP slice: subscribe to order.accepted, pick nearest
 *                ONLINE rider in vehicle radius, assign.
 *
 * Deferred:
 *   - Top-3 broadcast + 30s timeout + escalation (Bull MQ queue)
 *   - Score blending (40% fiability + 40% proximity + 20% accept rate)
 *   - Batching (Story 4.3)
 *   - Voice proxy (Story 4.17 — separate module)
 */
@Module({
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
