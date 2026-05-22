import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DispatchService } from './dispatch.service';
import { DispatchRetryProcessor } from './dispatch-retry.processor';
import { DISPATCH_RETRY_QUEUE } from './dispatch-retry.constants';

/**
 * Epic 4 — Livraison & Dispatch.
 *
 * Story 4.1 ✅ — MVP slice: subscribe to order.accepted, pick nearest
 *                ONLINE rider in vehicle radius, assign.
 * Story 4.14 ✅ — dispatch retry via BullMQ (was in-process setTimeout).
 *
 * Deferred:
 *   - Top-3 broadcast + 30s timeout + escalation
 *   - Score blending (40% fiability + 40% proximity + 20% accept rate)
 *   - Batching (Story 4.3)
 *   - Voice proxy (Story 4.17 — separate module)
 */
@Module({
  imports: [BullModule.registerQueue({ name: DISPATCH_RETRY_QUEUE })],
  providers: [DispatchService, DispatchRetryProcessor],
  exports: [DispatchService],
})
export class DispatchModule {}
