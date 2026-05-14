import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { RiderStatus, RiderVehicleType } from '@prisma/client';
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

interface CandidateRow {
  rider_id: string;
  distance_m: number;
  vehicle_type: RiderVehicleType;
  reliability_score: number;
}

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Story 4.1 — auto-dispatch on order acceptance.
   *
   * MVP scope: find the single nearest online rider within their vehicle's
   * radius and assign immediately (no top-3 broadcast, no 30s timeout, no
   * score blending). The rider's app surfaces the offer; they confirm via
   * POST /orders/:id/claim (next PR adds the claim endpoint).
   *
   * Re-dispatch on rejection / no-claim / escalation lands with Story 4.1
   * full implementation (Bull MQ queue) — for MVP, admin manually
   * re-triggers via a SUPER_ADMIN endpoint if a rider doesn't pick up.
   */
  @OnEvent(DomainEvents.ORDER_ACCEPTED)
  async onOrderAccepted(payload: { orderId: string; vendorId: string }) {
    await this.dispatchOrder(payload.orderId, payload.vendorId);
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
        `dispatch: no online rider for order=${orderId} vendor=${vendorId} — admin alert needed`,
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
      this.logger.warn(`dispatch: order=${orderId} was already assigned by a concurrent dispatch`);
      return null;
    }

    this.logger.log(
      `dispatch: order=${orderId} → rider=${chosen.rider_id} (${(chosen.distance_m / 1000).toFixed(2)}km, ${chosen.vehicle_type})`,
    );
    return { riderId: chosen.rider_id };
  }
}
