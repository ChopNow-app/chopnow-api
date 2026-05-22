import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  DispatchOutcome,
  OrderStatus,
  PaymentStatus,
  RiderStatus,
  RiderVehicleType,
} from '@prisma/client';
import { Queue } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';
import {
  DISPATCH_RETRY_JOB,
  DISPATCH_RETRY_QUEUE,
  type DispatchRetryJobData,
} from './dispatch-retry.constants';

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
  constructor(
    @InjectPinoLogger(DispatchService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    @InjectQueue(DISPATCH_RETRY_QUEUE) private readonly retryQueue: Queue<DispatchRetryJobData>,
  ) {}

  @OnEvent(DomainEvents.ORDER_ACCEPTED)
  async onOrderAccepted(payload: { orderId: string; vendorId: string }) {
    await this.tryDispatch(payload.orderId, payload.vendorId, 0);
  }

  /**
   * Entry point used by the BullMQ worker when a delayed retry job fires.
   * Kept as a thin public wrapper around `tryDispatch` so the queue
   * processor doesn't reach into a private. Idempotent: `tryDispatch`
   * re-checks the order state before doing anything.
   */
  async runRetry(orderId: string, vendorId: string, attempt: number): Promise<void> {
    await this.tryDispatch(orderId, vendorId, attempt);
  }

  /**
   * Append-only audit row for every dispatchOrder() call's outcome.
   * Powers the admin "dispatch funnel" tile + per-rider audits + the
   * signal we'll need to design score-based dispatch v2 post-pilot.
   *
   * Swallows insert errors deliberately — a logging failure must not
   * break the dispatch path itself. We log the swallowed error so the
   * gap shows up in the structured logs.
   */
  private async logDispatchEvent(input: {
    orderId: string;
    vendorId: string;
    attempt: number;
    outcome: DispatchOutcome;
    riderId?: string | null;
    vehicleType?: RiderVehicleType | null;
    distanceM?: number | null;
  }): Promise<void> {
    try {
      await this.prisma.dispatchEvent.create({
        data: {
          orderId: input.orderId,
          vendorId: input.vendorId,
          attempt: input.attempt,
          outcome: input.outcome,
          riderId: input.riderId ?? null,
          vehicleType: input.vehicleType ?? null,
          distanceM: input.distanceM ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        { event: 'dispatch_event_log_failed', orderId: input.orderId, err: String(err) },
        'Failed to write DispatchEvent row — dispatch continues',
      );
    }
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
    // expired by another code path. A BullMQ retry job that fires after
    // the order was assigned via a parallel path just no-ops here.
    const current = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, riderId: true },
    });
    if (!current) return;
    if (current.riderId) return;
    if (current.status === OrderStatus.CANCELLED || current.status === OrderStatus.EXPIRED) return;

    // attempt arg is 0-indexed; DispatchEvent.attempt is 1-indexed for
    // human-readability in the admin UI ("attempt 1, 2, 3…").
    const result = await this.dispatchOrder(orderId, vendorId, attempt + 1);
    if (result) return;

    // No rider this round.
    if (attempt < MAX_RETRIES - 1) {
      const nextAttempt = attempt + 1;
      this.logger.info(
        {
          event: 'dispatch_retry_scheduled',
          orderId,
          vendorId,
          attempt: nextAttempt,
          maxAttempts: MAX_RETRIES,
          retryInSeconds: RETRY_INTERVAL_MS / 1000,
        },
        'Dispatch retry scheduled — no rider this round',
      );
      // Job ID locks duplicate enqueues for the same (order, attempt) —
      // if two concurrent dispatchers both decided to schedule attempt N,
      // only one job ends up in Redis.
      await this.retryQueue.add(
        DISPATCH_RETRY_JOB,
        { orderId, vendorId, attempt: nextAttempt },
        {
          delay: RETRY_INTERVAL_MS,
          jobId: `${orderId}:${nextAttempt}`,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: { count: 1000 }, // keep last 1000 failures for inspection
        },
      );
      return;
    }

    // Last attempt failed — give up. Mark EXPIRED + refund.
    await this.expireForNoRider(orderId);
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

  async dispatchOrder(
    orderId: string,
    vendorId: string,
    attempt: number = 1,
  ): Promise<{ riderId: string } | null> {
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
    //
    // ORDER BY: proximity is the primary sort. lastAssignedAt is the
    // tie-breaker so two riders at the same distance alternate instead
    // of the same one getting hammered. NULLS FIRST so a rider who has
    // never been assigned ranks ahead of one who was assigned recently.
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
      ORDER BY distance_m ASC, r."lastAssignedAt" ASC NULLS FIRST
      LIMIT 1
    `;

    if (candidates.length === 0) {
      this.logger.warn(
        { event: 'dispatch_no_online_rider', orderId, vendorId, attempt },
        'No online rider in range for vendor — will retry',
      );
      await this.logDispatchEvent({
        orderId,
        vendorId,
        attempt,
        outcome: DispatchOutcome.NO_CANDIDATE,
      });
      return null;
    }

    const chosen = candidates[0];
    const now = new Date();

    // Conditional update — protects against two simultaneous dispatches
    // (e.g. duplicate event) trying to claim the same rider. The WHERE
    // riderId IS NULL clause is the locking primitive.
    const result = await this.prisma.order.updateMany({
      where: { id: orderId, riderId: null },
      data: { riderId: chosen.rider_id, assignedAt: now },
    });
    if (result.count === 0) {
      this.logger.warn(
        { event: 'dispatch_already_assigned', orderId, attempt },
        'Order was already assigned by a concurrent dispatch (race short-circuit)',
      );
      await this.logDispatchEvent({
        orderId,
        vendorId,
        attempt,
        outcome: DispatchOutcome.RACE_LOST,
        riderId: chosen.rider_id,
        vehicleType: chosen.vehicle_type,
        distanceM: chosen.distance_m,
      });
      return null;
    }

    // Stamp lastAssignedAt on the rider for the next dispatch's round-
    // robin tie-breaker. Fire-and-forget — a failure here just means
    // the rider's tie-breaker stays at its previous value (slightly
    // unfair to them, never to others) and is logged for visibility.
    void this.prisma.rider
      .update({ where: { id: chosen.rider_id }, data: { lastAssignedAt: now } })
      .catch((err) =>
        this.logger.warn(
          {
            event: 'rider_last_assigned_update_failed',
            riderId: chosen.rider_id,
            err: String(err),
          },
          'Failed to bump Rider.lastAssignedAt — round-robin will be slightly off',
        ),
      );

    this.logger.info(
      {
        event: 'dispatch_rider_assigned',
        orderId,
        riderId: chosen.rider_id,
        distanceKm: Number((chosen.distance_m / 1000).toFixed(2)),
        vehicleType: chosen.vehicle_type,
        attempt,
      },
      'Rider assigned to order',
    );
    await this.logDispatchEvent({
      orderId,
      vendorId,
      attempt,
      outcome: DispatchOutcome.ASSIGNED,
      riderId: chosen.rider_id,
      vehicleType: chosen.vehicle_type,
      distanceM: chosen.distance_m,
    });
    return { riderId: chosen.rider_id };
  }
}
