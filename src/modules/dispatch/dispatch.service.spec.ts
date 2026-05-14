import { Test } from '@nestjs/testing';
import { RiderVehicleType } from '@prisma/client';
import { DispatchService } from './dispatch.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('DispatchService', () => {
  let service: DispatchService;
  let prisma: {
    order: { findUnique: jest.Mock; updateMany: jest.Mock };
    vendor: { findUnique: jest.Mock };
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vendor: { findUnique: jest.fn().mockResolvedValue({ id: 'v-1' }) },
      $queryRaw: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [DispatchService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(DispatchService);
  });

  it('assigns the nearest online rider in radius', async () => {
    prisma.order.findUnique.mockResolvedValue({ riderId: null });
    prisma.$queryRaw.mockResolvedValue([
      {
        rider_id: 'r-near',
        distance_m: 1200,
        vehicle_type: RiderVehicleType.MOTO,
        reliability_score: 85,
      },
    ]);

    const result = await service.dispatchOrder('order-1', 'v-1');

    expect(result).toEqual({ riderId: 'r-near' });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', riderId: null },
      data: { riderId: 'r-near', assignedAt: expect.any(Date) },
    });
  });

  it('returns null when no rider is in radius (admin alert needed)', async () => {
    prisma.order.findUnique.mockResolvedValue({ riderId: null });
    prisma.$queryRaw.mockResolvedValue([]);
    const result = await service.dispatchOrder('order-1', 'v-1');
    expect(result).toBeNull();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('skips when the order is already assigned (duplicate event guard)', async () => {
    prisma.order.findUnique.mockResolvedValue({ riderId: 'r-existing' });
    const result = await service.dispatchOrder('order-1', 'v-1');
    expect(result).toBeNull();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns null when a concurrent dispatch already claimed (updateMany count=0)', async () => {
    prisma.order.findUnique.mockResolvedValue({ riderId: null });
    prisma.$queryRaw.mockResolvedValue([
      {
        rider_id: 'r-near',
        distance_m: 100,
        vehicle_type: RiderVehicleType.MOTO,
        reliability_score: 90,
      },
    ]);
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.dispatchOrder('order-1', 'v-1');
    expect(result).toBeNull();
  });

  it('passes a stale-heartbeat cutoff (~60s) into the query', async () => {
    prisma.order.findUnique.mockResolvedValue({ riderId: null });
    prisma.$queryRaw.mockResolvedValue([]);
    const before = Date.now();
    await service.dispatchOrder('order-1', 'v-1');
    const after = Date.now();

    const bindings = prisma.$queryRaw.mock.calls[0].slice(1);
    // The cutoff Date is the only Date binding; everything else is strings/numbers.
    const cutoffDate = bindings.find((b: unknown): b is Date => b instanceof Date);
    expect(cutoffDate).toBeDefined();
    // ~60s ago, within a tolerant window
    expect(cutoffDate!.getTime()).toBeLessThanOrEqual(after - 59_000);
    expect(cutoffDate!.getTime()).toBeGreaterThanOrEqual(before - 61_000);
  });
});
