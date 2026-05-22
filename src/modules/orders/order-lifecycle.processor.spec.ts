import { Job } from 'bullmq';
import { OrderLifecycleProcessor } from './order-lifecycle.processor';
import { OrdersExpiryService } from './orders-expiry.service';
import { EXPIRE_VENDOR_DECISION_JOB, PROMOTE_PRE_ORDER_JOB } from './order-lifecycle.constants';

describe('OrderLifecycleProcessor', () => {
  let processor: OrderLifecycleProcessor;
  let prisma: {
    order: { findUnique: jest.Mock; updateMany: jest.Mock };
  };
  let events: { emit: jest.Mock };
  let scheduler: { scheduleAcceptanceExpiry: jest.Mock; schedulePreOrderPromotion: jest.Mock };

  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    setContext: jest.fn(),
  };

  beforeEach(() => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    events = { emit: jest.fn() };
    scheduler = {
      scheduleAcceptanceExpiry: jest.fn().mockResolvedValue(undefined),
      schedulePreOrderPromotion: jest.fn().mockResolvedValue(undefined),
    };
    processor = new OrderLifecycleProcessor(
      logger as never,
      prisma as never,
      events as never,
      scheduler as never,
    );
  });

  function job<T>(name: string, data: T): Job<T> {
    return { name, data, id: 'job-1' } as unknown as Job<T>;
  }

  describe('expire-vendor-decision', () => {
    it('flips PENDING → REFUSED with EXPIRED_NO_VENDOR_RESPONSE + emits ORDER_REFUSED', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        id: 'order-1',
        vendorId: 'v-1',
        status: 'PENDING',
        paymentStatus: 'PAID',
      });

      await processor.process(job(EXPIRE_VENDOR_DECISION_JOB, { orderId: 'order-1' }));

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order-1',
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        data: {
          status: 'REFUSED',
          refusedAt: expect.any(Date),
          refusalReason: OrdersExpiryService.EXPIRED_REASON,
        },
      });
      expect(events.emit).toHaveBeenCalledWith(
        'order.refused',
        expect.objectContaining({
          orderId: 'order-1',
          reason: OrdersExpiryService.EXPIRED_REASON,
        }),
      );
    });

    it('no-ops when the vendor already accepted (status=ACCEPTED) — no update, no emit', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        id: 'order-1',
        vendorId: 'v-1',
        status: 'ACCEPTED',
        paymentStatus: 'PAID',
      });

      await processor.process(job(EXPIRE_VENDOR_DECISION_JOB, { orderId: 'order-1' }));

      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('no-ops when the order was deleted between enqueue and fire', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(null);
      await processor.process(job(EXPIRE_VENDOR_DECISION_JOB, { orderId: 'gone' }));
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('no-ops when the status-guarded updateMany matches zero rows (cron raced us)', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        id: 'order-1',
        vendorId: 'v-1',
        status: 'PENDING',
        paymentStatus: 'PAID',
      });
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await processor.process(job(EXPIRE_VENDOR_DECISION_JOB, { orderId: 'order-1' }));

      // updateMany was called, but no emit because we lost the race.
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('promote-pre-order', () => {
    const eligiblePreOrder = {
      id: 'pre-1',
      code: 'TC-PRE01',
      vendorId: 'v-1',
      userId: 'u-1',
      paymentMethod: 'MTN_MOMO',
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
      acceptanceDeadlineAt: null,
      scheduledFor: new Date('2026-05-22T20:00:00Z'),
    };

    it('sets acceptanceDeadlineAt + emits ORDER_CREATED + chains the expiry job', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(eligiblePreOrder);

      await processor.process(job(PROMOTE_PRE_ORDER_JOB, { orderId: 'pre-1' }));

      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'pre-1', acceptanceDeadlineAt: null },
        data: { acceptanceDeadlineAt: expect.any(Date) },
      });
      expect(events.emit).toHaveBeenCalledWith(
        'order.created',
        expect.objectContaining({
          orderId: 'pre-1',
          code: 'TC-PRE01',
          vendorId: 'v-1',
        }),
      );
      // Chained scheduling keeps the next step on the precise path
      expect(scheduler.scheduleAcceptanceExpiry).toHaveBeenCalledWith('pre-1', expect.any(Date));
    });

    it('skips when already promoted (acceptanceDeadlineAt non-null)', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        ...eligiblePreOrder,
        acceptanceDeadlineAt: new Date(),
      });

      await processor.process(job(PROMOTE_PRE_ORDER_JOB, { orderId: 'pre-1' }));

      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(scheduler.scheduleAcceptanceExpiry).not.toHaveBeenCalled();
    });

    it('skips when status is no longer CONFIRMED (e.g. cancelled before promotion)', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        ...eligiblePreOrder,
        status: 'CANCELLED',
      });

      await processor.process(job(PROMOTE_PRE_ORDER_JOB, { orderId: 'pre-1' }));

      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('skips when the cron raced us and won (updateMany count=0)', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(eligiblePreOrder);
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await processor.process(job(PROMOTE_PRE_ORDER_JOB, { orderId: 'pre-1' }));

      // updateMany was called, but the second-mover didn't emit or chain.
      expect(events.emit).not.toHaveBeenCalled();
      expect(scheduler.scheduleAcceptanceExpiry).not.toHaveBeenCalled();
    });
  });

  it('ignores unknown job names without throwing', async () => {
    await expect(processor.process(job('unknown-job', { orderId: 'x' }))).resolves.toBeUndefined();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });
});
