import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RiderVehicleType } from '@prisma/client';
import { DispatchService } from './dispatch.service';
import { PrismaService } from '../../infra/prisma/prisma.service';

describe('DispatchService', () => {
  let service: DispatchService;
  let prisma: {
    order: { findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
    vendor: { findUnique: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      vendor: { findUnique: jest.fn().mockResolvedValue({ id: 'v-1' }) },
      $queryRaw: jest.fn(),
    };
    events = { emit: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        DispatchService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
      ],
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

  describe('onOrderAccepted retry + expire (Story 4.14)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function neverDispatchable() {
      // Both the pre-dispatch state check AND the inner dispatchOrder() call
      // hit findUnique; both should see "no rider yet, not cancelled".
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        riderId: null,
        status: 'ACCEPTED',
        paymentStatus: 'PAID',
        paymentMethod: 'MTN_MOMO',
        userId: 'u-1',
      });
      prisma.$queryRaw.mockResolvedValue([]); // never any rider
    }

    it('after MAX_RETRIES failures, expires the order and emits ORDER_CANCELLED with refundRequired', async () => {
      neverDispatchable();

      await service.onOrderAccepted({ orderId: 'order-1', vendorId: 'v-1' });

      // 9 retries * 30s = 270s. Advance past all of them.
      await jest.advanceTimersByTimeAsync(10 * 30_000);

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: expect.objectContaining({
          status: 'EXPIRED',
          refusalReason: 'NO_RIDER_AVAILABLE',
          paymentStatus: 'REFUNDED', // was PAID
          cancelledAt: expect.any(Date),
        }),
      });
      expect(events.emit).toHaveBeenCalledWith(
        'order.cancelled',
        expect.objectContaining({
          orderId: 'order-1',
          reason: 'NO_RIDER_AVAILABLE',
          refundRequired: true,
        }),
      );
    });

    it('does not flip paymentStatus when the cash order expires (no refund needed)', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        riderId: null,
        status: 'ACCEPTED',
        paymentStatus: 'PENDING',
        paymentMethod: 'CASH',
        userId: 'u-1',
      });
      prisma.$queryRaw.mockResolvedValue([]);

      await service.onOrderAccepted({ orderId: 'order-1', vendorId: 'v-1' });
      await jest.advanceTimersByTimeAsync(10 * 30_000);

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: expect.not.objectContaining({ paymentStatus: expect.anything() }),
      });
      expect(events.emit).toHaveBeenCalledWith(
        'order.cancelled',
        expect.objectContaining({ refundRequired: false }),
      );
    });

    it('stops retrying as soon as the order is no longer assignable (e.g. consumer cancelled)', async () => {
      // First call: assignable. Second (next retry): order is now CANCELLED.
      prisma.order.findUnique
        .mockResolvedValueOnce({ riderId: null, status: 'ACCEPTED' })
        .mockResolvedValueOnce({ riderId: null, status: 'CANCELLED' });
      prisma.$queryRaw.mockResolvedValue([]); // first attempt: no rider

      await service.onOrderAccepted({ orderId: 'order-1', vendorId: 'v-1' });
      // First retry fires 30s later, sees CANCELLED, bails.
      await jest.advanceTimersByTimeAsync(30_000);
      // Advance way past the remaining retry window — no more dispatch attempts should run.
      await jest.advanceTimersByTimeAsync(20 * 30_000);

      // expire() never called because the abort happened first.
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });
});
