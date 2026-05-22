import { Test } from '@nestjs/testing';
import { OrderStatus } from '@prisma/client';
import { AdminMetricsService } from './admin-metrics.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('AdminMetricsService', () => {
  let service: AdminMetricsService;
  let prisma: {
    order: { groupBy: jest.Mock; count: jest.Mock };
    dispatchEvent: { groupBy: jest.Mock };
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      order: {
        groupBy: jest.fn(),
        count: jest.fn(),
      },
      // Dispatch funnel reads — default to empty results; per-test override
      // when a case wants to exercise the funnel math.
      dispatchEvent: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [AdminMetricsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(AdminMetricsService);
    // Default for the dispatch-funnel $queryRaw calls so tests focused on
    // reorder/completion don't need to mock them explicitly.
    prisma.$queryRaw.mockImplementation(() => Promise.resolve([{ avg_ms: null, c: 0 }]));
  });

  const from = new Date('2026-05-08T00:00:00Z');
  const to = new Date('2026-05-15T00:00:00Z');

  it('reorder rate: 2 of 3 unique customers placed 2+ orders → 66.67%', async () => {
    prisma.order.groupBy.mockResolvedValue([
      { userId: 'u-1', _count: { _all: 3 } },
      { userId: 'u-2', _count: { _all: 2 } },
      { userId: 'u-3', _count: { _all: 1 } },
    ]);
    prisma.order.count.mockResolvedValueOnce(10).mockResolvedValueOnce(9);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ avg_ms: 1_200_000 }])
      .mockResolvedValueOnce([{ avg_ms: 30_000 }]);

    const result = await service.getPilotMetrics(from, to);

    expect(result.reorderRate).toEqual({
      reorderers: 2,
      uniqueCustomers: 3,
      percent: expect.closeTo(66.6667, 1),
    });
  });

  it('completion rate: 9 of 10 delivered → 90%', async () => {
    prisma.order.groupBy.mockResolvedValue([]);
    prisma.order.count.mockResolvedValueOnce(10).mockResolvedValueOnce(9);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ avg_ms: null }])
      .mockResolvedValueOnce([{ avg_ms: null }]);

    const result = await service.getPilotMetrics(from, to);

    expect(result.completionRate).toEqual({ delivered: 9, total: 10, percent: 90 });
    // Filter on the second count call confirms DELIVERED gate.
    expect(prisma.order.count).toHaveBeenNthCalledWith(2, {
      where: { placedAt: { gte: from, lt: to }, status: OrderStatus.DELIVERED },
    });
  });

  it('handles empty window: all rates 0, avg times null (no division by zero)', async () => {
    prisma.order.groupBy.mockResolvedValue([]);
    prisma.order.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ avg_ms: null }])
      .mockResolvedValueOnce([{ avg_ms: null }]);

    const result = await service.getPilotMetrics(from, to);

    expect(result.reorderRate.percent).toBe(0);
    expect(result.completionRate.percent).toBe(0);
    expect(result.avgDeliveryTimeMs).toBeNull();
    expect(result.avgVendorAcceptTimeMs).toBeNull();
  });

  it('passes through avg times from raw queries unchanged', async () => {
    prisma.order.groupBy.mockResolvedValue([]);
    prisma.order.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ avg_ms: 1_500_000 }])
      .mockResolvedValueOnce([{ avg_ms: 45_000 }]);

    const result = await service.getPilotMetrics(from, to);

    expect(result.avgDeliveryTimeMs).toBe(1_500_000);
    expect(result.avgVendorAcceptTimeMs).toBe(45_000);
  });
});
