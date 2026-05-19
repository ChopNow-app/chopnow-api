import { Injectable } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { OrderStatus, PaymentStatus, RiderStatus, RiderVehicleType } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';

// Story 4.1 — dispatch radius per vehicle. Hard-coded for MVP; the spec
// asks for admin-configurable per-vehicle settings (Story 6.6 territory).
const RADIUS_KM_BY_VEHICLE: Record<RiderVehicleType, number> = {
  [RiderVehicleType.ON_FOOT]: 1,
  [RiderVehicleType.BICYCLE]: 3,
  [RiderVehicleType.MOTO]: 7,
  [RiderVehicleType.CAR]: 10,
};

// Story 4.4 — "stale" cutoff. A rider that hasn't pinged in this long is
// excluded from dispatch even if isOnline is still true.
const STALE_HEARTBEAT_SECONDS = 60;

// Story 4.14 — no-rider-available retry policy. After the initial dispatch
// fails, retry every 30s for up to 5 minutes (10 attempts). If still no
// rider, mark the order EXPIRED with refusalReason = NO_RIDER_AVAILABLE and
// trigger refund. Numbers chosen so a typical Douala rider going online
// during the wait window has a real shot at picking up.
const RETRY_INTERVAL_MS = 30_000;
const MAX_RETRIES = 10;

// Refusal reason sentinel — written into Order.refusalReason on terminal
// no-rider giveup. Frontend branches on this value to render the refund /
// retry UI.
export const NO_RIDER_AVAILABLE_REASON = 'NO_RIDER_AVAILABLE';

interface CandidateRow {
  rider_id: string;
  distance_m: number;
  vehicle_type: RiderVehicleType;
  reliability_score: number;
}

@Injectable()
export class DispatchService {
  /**
   * In-process retry timers, keyed by orderId. Lives on a single API node —
   * fine for MVP since we run one instance. When we scale horizontally,
   * swap for Bull MQ (a job per retry survives node restart + balances).
   */
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @InjectPinoLogger(DispatchService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent(DomainEvents.ORDER_ACCEPTED)
  async onOrderAccepted(payload: { orderId: string; vendorId: string }) {
    await this.tryDispatch(payload.orderId, payload.vendorId, 0);
  }

  /**
   * Story 4.14 — single dispatch attempt + schedule next retry on failure.
   *
   * Each attempt either:
   *   - assigns a rider and clears any scheduled retries, OR
   *   - schedules another attempt 30s out, OR
   *   - on the last attempt, marks the order EXPIRED and triggers refund.
   *
   * `attempt` is 0-indexed: 0 is the initial dispatch from the event, 1..9
   * are the retries. After attempt 9 fails, we give up.
   */
  private async tryDispatch(orderId: string, vendorId: string, attempt: number): Promise<void> {
    // Defensive: don't retry an order that's already been canceled or
    // expired by another code path.
    const current = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, riderId: true },
    });
    if (!current) return;
    if (current.riderId) {
      this.clearRetry(orderId);
      return;
    }
    if (current.status === OrderStatus.CANCELLED || current.status === OrderStatus.EXPIRED) {
      this.clearRetry(orderId);
      return;
    }

    const result = await this.dispatchOrder(orderId, vendorId);
    if (result) {
      // Found a rider — kill any pending retry.
      this.clearRetry(orderId);
      return;
    }

    // No rider this round.
    if (attempt < MAX_RETRIES - 1) {
      this.logger.info(
        {
          event: 'dispatch_retry_scheduled',
          orderId,
          vendorId,
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES,
          retryInSeconds: RETRY_INTERVAL_MS / 1000,
        },
        'Dispatch retry scheduled — no rider this round',
      );
      const timer = setTimeout(() => {
        void this.tryDispatch(orderId, vendorId, attempt + 1);
      }, RETRY_INTERVAL_MS);
      // Unref so a pending timer doesn't keep the node process alive on
      // shutdown — Nest's graceful shutdown will let the timer be dropped.
      timer.unref();
      this.retryTimers.set(orderId, timer);
      return;
    }

    // Last attempt failed — give up. Mark EXPIRED + refund.
    await this.expireForNoRider(orderId);
    this.clearRetry(orderId);
  }

  private clearRetry(orderId: string): void {
    const t = this.retryTimers.get(orderId);
    if (t) {
      clearTimeout(t);
      this.retryTimers.delete(orderId);
    }
  }

  /**
   * Terminal state: no rider found after all retries. Mark the order
   * EXPIRED with a recognisable refusalReason and emit a refund event for
   * MoMo orders. CASH orders don't need a refund (no money changed hands)
   * but we still surface the EXPIRED state to the consumer so they know
   * to re-order.
   */
  private async expireForNoRider(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, paymentStatus: true, paymentMethod: true, userId: true },
    });
    if (!order) return;

    // Only flip if still in a state where giving up is correct. If a vendor
    // accepted and a rider was already assigned during the 30s gap, leave
    // it alone — that path will run to completion.
    const TERMINABLE: ReadonlySet<OrderStatus> = new Set([
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PREP,
      OrderStatus.READY_PICKUP,
    ]);
    if (!TERMINABLE.has(order.status)) return;

    const isPaid = order.paymentStatus === PaymentStatus.PAID;
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.EXPIRED,
        refusalReason: NO_RIDER_AVAILABLE_REASON,
        cancelledAt: new Date(),
        // MoMo refund — flip the paymentStatus optimistically. The actual
        // Campay refund call lands in the @OnEvent handler so this method
        // stays a single transaction.
        ...(isPaid ? { paymentStatus: PaymentStatus.REFUNDED } : {}),
      },
    });

    this.logger.warn(
      {
        event: 'dispatch_expired_no_rider',
        orderId,
        userId: order.userId,
        attempts: MAX_RETRIES,
        paymentStatus: isPaid ? 'REFUNDED' : order.paymentStatus,
        wasPaid: isPaid,
      },
      'Order EXPIRED — no rider available after all retries',
    );

    this.events.emit(DomainEvents.ORDER_CANCELLED, {
      orderId: order.id,
      userId: order.userId,
      reason: NO_RIDER_AVAILABLE_REASON,
      refundRequired: isPaid,
    });
  }

  async dispatchOrder(orderId: string, vendorId: string): Promise<{ riderId: string } | null> {
    // Skip if already assigned (defensive against duplicate events).
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { riderId: true },
    });
    if (!order || order.riderId) return null;

    // Resolve vendor location once; reuse for radius probes.
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true },
    });
    if (!vendor) return null;

    // Single SQL roundtrip — find nearest rider per vehicle radius. Each
    // vehicle has a different distance cap, so the query unions per
    // vehicle type with its own ST_DWithin filter. Vendor.location and
    // Rider.lastLocation are both `geography`; ST_Distance returns meters.
    const staleCutoff = new Date(Date.now() - STALE_HEARTBEAT_SECONDS * 1000);
    const candidates = await this.prisma.$queryRaw<CandidateRow[]>`
      SELECT
        r.id AS rider_id,
        r."vehicleType" AS vehicle_type,
        r."reliabilityScore" AS reliability_score,
        ST_Distance(
          r."lastLocation",
          (SELECT location FROM vendors WHERE id = ${vendor.id})
        ) AS distance_m
      FROM "riders" r
      WHERE r.status = ${RiderStatus.ACTIVE}::"RiderStatus"
        AND r."isOnline" = true
        AND r."lastLocation" IS NOT NULL
        AND r."lastSeenAt" > ${staleCutoff}
        AND ST_DWithin(
          r."lastLocation",
          (SELECT location FROM vendors WHERE id = ${vendor.id}),
          CASE r."vehicleType"
            WHEN 'ON_FOOT'  THEN ${RADIUS_KM_BY_VEHICLE.ON_FOOT * 1000}
            WHEN 'BICYCLE'  THEN ${RADIUS_KM_BY_VEHICLE.BICYCLE * 1000}
            WHEN 'MOTO'     THEN ${RADIUS_KM_BY_VEHICLE.MOTO * 1000}
            WHEN 'CAR'      THEN ${RADIUS_KM_BY_VEHICLE.CAR * 1000}
          END
        )
      ORDER BY distance_m ASC
      LIMIT 1
    `;

    if (candidates.length === 0) {
      this.logger.warn(
        { event: 'dispatch_no_online_rider', orderId, vendorId },
        'No online rider in range for vendor — will retry',
      );
      return null;
    }

    const chosen = candidates[0];

    // Conditional update — protects against two simultaneous dispatches
    // (e.g. duplicate event) trying to claim the same rider. The WHERE
    // riderId IS NULL clause is the locking primitive.
    const result = await this.prisma.order.updateMany({
      where: { id: orderId, riderId: null },
      data: { riderId: chosen.rider_id, assignedAt: new Date() },
    });
    if (result.count === 0) {
      this.logger.warn(
        { event: 'dispatch_already_assigned', orderId },
        'Order was already assigned by a concurrent dispatch (race short-circuit)',
      );
      return null;
    }

    this.logger.info(
      {
        event: 'dispatch_rider_assigned',
        orderId,
        riderId: chosen.rider_id,
        distanceKm: Number((chosen.distance_m / 1000).toFixed(2)),
        vehicleType: chosen.vehicle_type,
      },
      'Rider assigned to order',
    );
    return { riderId: chosen.rider_id };
  }
}
