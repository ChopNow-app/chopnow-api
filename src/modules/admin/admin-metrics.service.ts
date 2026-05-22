import { Injectable } from '@nestjs/common';
import { DispatchOutcome, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface PilotMetrics {
  window: { from: string; to: string };
  reorderRate: { reorderers: number; uniqueCustomers: number; percent: number };
  completionRate: { delivered: number; total: number; percent: number };
  avgDeliveryTimeMs: number | null;
  avgVendorAcceptTimeMs: number | null;
  dispatchFunnel: DispatchFunnel;
}

export interface DispatchFunnel {
  /** Orders that produced at least one ASSIGNED DispatchEvent in window. */
  ordersAssigned: number;
  /** Orders whose first ASSIGNED happened on attempt 1 (the happy path). */
  assignedOnFirstAttempt: number;
  /** Orders with no ASSIGNED event in window AND a NO_CANDIDATE at attempt 10 (gave up). */
  expiredNoRider: number;
  /** Avg number of attempts before assignment, across orders that got assigned. */
  avgAttemptsToAssign: number | null;
  /** Per-rider offer counts — flags the "starved rider" anti-pattern when one rider has >70% of offers. */
  topRiders: Array<{ riderId: string; offers: number }>;
}

@Injectable()
export class AdminMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pilot KPI snapshot. Used by /admin/metrics to drive the Week-3 decision
   * point (continue pilot, iterate, or pivot). Defaults to the last 7 days
   * to match the strategy memo's 7-day reorder-rate definition.
   *
   * Time arithmetic runs in Postgres (one round-trip each via $queryRaw)
   * because Prisma's typed API doesn't expose AVG over interval columns.
   */
  async getPilotMetrics(from: Date, to: Date): Promise<PilotMetrics> {
    const where = { placedAt: { gte: from, lt: to } };

    // 1) Reorder rate — group by userId, count orders, then bucket.
    const grouped = await this.prisma.order.groupBy({
      by: ['userId'],
      where,
      _count: { _all: true },
    });
    const uniqueCustomers = grouped.length;
    const reorderers = grouped.filter((g) => g._count._all >= 2).length;

    // 2) Completion rate.
    const [total, delivered] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.count({ where: { ...where, status: OrderStatus.DELIVERED } }),
    ]);

    // 3) Avg delivery time (pickedUp → delivered).
    // 4) Avg vendor accept time (placed → accepted).
    const [deliveryRow, acceptRow] = await Promise.all([
      this.prisma.$queryRaw<[{ avg_ms: number | null }]>(
        Prisma.sql`
          SELECT AVG(EXTRACT(EPOCH FROM ("deliveredAt" - "pickedUpAt")) * 1000)::float AS avg_ms
          FROM "orders"
          WHERE "status" = 'DELIVERED'
            AND "placedAt" >= ${from} AND "placedAt" < ${to}
            AND "deliveredAt" IS NOT NULL
            AND "pickedUpAt" IS NOT NULL
        `,
      ),
      this.prisma.$queryRaw<[{ avg_ms: number | null }]>(
        Prisma.sql`
          SELECT AVG(EXTRACT(EPOCH FROM ("acceptedAt" - "placedAt")) * 1000)::float AS avg_ms
          FROM "orders"
          WHERE "acceptedAt" IS NOT NULL
            AND "placedAt" >= ${from} AND "placedAt" < ${to}
        `,
      ),
    ]);

    const dispatchFunnel = await this.computeDispatchFunnel(from, to);

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      reorderRate: {
        reorderers,
        uniqueCustomers,
        percent: uniqueCustomers === 0 ? 0 : (reorderers / uniqueCustomers) * 100,
      },
      completionRate: {
        delivered,
        total,
        percent: total === 0 ? 0 : (delivered / total) * 100,
      },
      avgDeliveryTimeMs: deliveryRow[0]?.avg_ms ?? null,
      avgVendorAcceptTimeMs: acceptRow[0]?.avg_ms ?? null,
      dispatchFunnel,
    };
  }

  /**
   * Dispatch funnel from the DispatchEvent log. Powers the admin tile
   * that answers "is dispatch healthy?" and surfaces the two anti-
   * patterns we care about most at pilot scale:
   *
   *   - Orders that needed multiple attempts (a sign rider density is
   *     thin in some quartier-vendor pairs)
   *   - One rider getting >70 % of offers (the "starved rider"
   *     pathology — fix is operational, not engineering: bring a
   *     second rider online in that zone)
   */
  private async computeDispatchFunnel(from: Date, to: Date): Promise<DispatchFunnel> {
    const where = { createdAt: { gte: from, lt: to } };

    const [assignedRows, expiredCount, topRiderRows] = await Promise.all([
      // Per-order: smallest attempt# at which we saw ASSIGNED.
      this.prisma.$queryRaw<Array<{ order_id: string; first_assigned_attempt: number }>>(
        Prisma.sql`
          SELECT "orderId" AS order_id, MIN("attempt") AS first_assigned_attempt
          FROM "dispatch_events"
          WHERE "outcome" = 'ASSIGNED'
            AND "createdAt" >= ${from} AND "createdAt" < ${to}
          GROUP BY "orderId"
        `,
      ),
      // Orders that hit a NO_CANDIDATE at attempt = MAX_RETRIES (10) AND
      // never got an ASSIGNED. Heuristic: gave up.
      this.prisma.$queryRaw<[{ c: number }]>(
        Prisma.sql`
          SELECT COUNT(DISTINCT e."orderId")::int AS c
          FROM "dispatch_events" e
          WHERE e."outcome" = 'NO_CANDIDATE'
            AND e."attempt" >= 10
            AND e."createdAt" >= ${from} AND e."createdAt" < ${to}
            AND NOT EXISTS (
              SELECT 1 FROM "dispatch_events" e2
              WHERE e2."orderId" = e."orderId" AND e2."outcome" = 'ASSIGNED'
            )
        `,
      ),
      // Per-rider offer counts (descending). Top 5 — the admin UI flags
      // the leader if they have >70% of all offers, a sign that one
      // rider is bearing the load and the others are idle/offline.
      this.prisma.dispatchEvent.groupBy({
        by: ['riderId'],
        where: { ...where, outcome: DispatchOutcome.ASSIGNED, riderId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { riderId: 'desc' } },
        take: 5,
      }),
    ]);

    const ordersAssigned = assignedRows.length;
    const assignedOnFirstAttempt = assignedRows.filter(
      (r) => r.first_assigned_attempt === 1,
    ).length;
    const totalAttempts = assignedRows.reduce((sum, r) => sum + r.first_assigned_attempt, 0);
    const avgAttemptsToAssign = ordersAssigned === 0 ? null : totalAttempts / ordersAssigned;

    return {
      ordersAssigned,
      assignedOnFirstAttempt,
      expiredNoRider: expiredCount[0]?.c ?? 0,
      avgAttemptsToAssign,
      topRiders: topRiderRows
        .filter((r): r is typeof r & { riderId: string } => r.riderId !== null)
        .map((r) => ({ riderId: r.riderId, offers: r._count._all })),
    };
  }
}
