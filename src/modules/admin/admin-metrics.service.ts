import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface PilotMetrics {
  window: { from: string; to: string };
  reorderRate: { reorderers: number; uniqueCustomers: number; percent: number };
  completionRate: { delivered: number; total: number; percent: number };
  avgDeliveryTimeMs: number | null;
  avgVendorAcceptTimeMs: number | null;
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
          FROM "Order"
          WHERE "status" = 'DELIVERED'
            AND "placedAt" >= ${from} AND "placedAt" < ${to}
            AND "deliveredAt" IS NOT NULL
            AND "pickedUpAt" IS NOT NULL
        `,
      ),
      this.prisma.$queryRaw<[{ avg_ms: number | null }]>(
        Prisma.sql`
          SELECT AVG(EXTRACT(EPOCH FROM ("acceptedAt" - "placedAt")) * 1000)::float AS avg_ms
          FROM "Order"
          WHERE "acceptedAt" IS NOT NULL
            AND "placedAt" >= ${from} AND "placedAt" < ${to}
        `,
      ),
    ]);

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
    };
  }
}
