import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { PreOrderPromotionService } from './pre-order-promotion.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { DomainEvents } from '../../shared/events/domain-events';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';

describe('PreOrderPromotionService (#187)', () => {
  let service: PreOrderPromotionService;
  let prisma: {
    order: { findMany: jest.Mock; updateMany: jest.Mock };
  };
  let events: { emit: jest.Mock };

  const FAKE_NOW = new Date('2026-06-15T11:00:00.000Z');

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(FAKE_NOW);
    prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    events = { emit: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        PreOrderPromotionService,
        pinoLoggerProvider(PreOrderPromotionService.name),
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    service = module.get(PreOrderPromotionService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function ripeOrder() {
    return {
      id: 'order-1',
      code: 'TC-ABCDE',
      vendorId: 'v-1',
      userId: 'user-1',
      paymentMethod: PaymentMethod.MTN_MOMO,
      scheduledFor: new Date(FAKE_NOW.getTime() + 30 * 60_000), // in 30 min — well inside the 60-min lead
    };
  }

  it('queries for CONFIRMED+PAID pre-orders with scheduledFor within the promotion lead window', async () => {
    await service.sweep();
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(OrderStatus.CONFIRMED);
    expect(where.paymentStatus).toBe(PaymentStatus.PAID);
    expect(where.scheduledFor).toEqual({
      not: null,
      lte: new Date(FAKE_NOW.getTime() + 60 * 60_000),
    });
    expect(where.acceptanceDeadlineAt).toBeNull();
  });

  it('promotes a ripe pre-order: sets acceptanceDeadlineAt + emits ORDER_CREATED', async () => {
    prisma.order.findMany.mockResolvedValueOnce([ripeOrder()]);

    await service.sweep();

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', acceptanceDeadlineAt: null },
      data: { acceptanceDeadlineAt: expect.any(Date) },
    });
    expect(events.emit).toHaveBeenCalledWith(
      DomainEvents.ORDER_CREATED,
      expect.objectContaining({
        orderId: 'order-1',
        code: 'TC-ABCDE',
        vendorId: 'v-1',
      }),
    );
  });

  it('skips already-promoted rows (updateMany returns 0) — no duplicate event', async () => {
    prisma.order.findMany.mockResolvedValueOnce([ripeOrder()]);
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.sweep();

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('no-op when there are no candidates', async () => {
    await service.sweep();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('one row failing does not break the batch', async () => {
    const a = { ...ripeOrder(), id: 'a' };
    const b = { ...ripeOrder(), id: 'b' };
    const c = { ...ripeOrder(), id: 'c' };
    prisma.order.findMany.mockResolvedValueOnce([a, b, c]);
    prisma.order.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('connection blip'))
      .mockResolvedValueOnce({ count: 1 });

    await service.sweep();

    // Two ORDER_CREATED events (a and c). b failed but didn't stop the loop.
    expect(events.emit).toHaveBeenCalledTimes(2);
  });
});
