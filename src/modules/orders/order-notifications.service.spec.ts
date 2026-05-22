import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { OrderNotificationsService } from './order-notifications.service';
import { OrdersExpiryService } from './orders-expiry.service';
import {
  CONSUMER_ORDER_REFUSED_JOB,
  ORDER_NOTIFICATIONS_QUEUE,
  VENDOR_NEW_ORDER_JOB,
} from './order-notifications.constants';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';

describe('OrderNotificationsService (enqueuer)', () => {
  let service: OrderNotificationsService;
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    queue = { add: jest.fn().mockResolvedValue({}) };
    const module = await Test.createTestingModule({
      providers: [
        OrderNotificationsService,
        pinoLoggerProvider(OrderNotificationsService.name),
        { provide: getQueueToken(ORDER_NOTIFICATIONS_QUEUE), useValue: queue },
      ],
    }).compile();
    service = module.get(OrderNotificationsService);
  });

  it('enqueues a vendor-new-order job on ORDER_CREATED with retry policy + dedup jobId', async () => {
    await service.onOrderCreated({ orderId: 'order-42' });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      VENDOR_NEW_ORDER_JOB,
      { orderId: 'order-42' },
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        jobId: 'vno:order-42',
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      }),
    );
  });

  it('enqueues a consumer-order-refused job on ORDER_REFUSED carrying the reason verbatim', async () => {
    await service.onOrderRefused({
      orderId: 'order-7',
      reason: OrdersExpiryService.EXPIRED_REASON,
    });
    expect(queue.add).toHaveBeenCalledWith(
      CONSUMER_ORDER_REFUSED_JOB,
      { orderId: 'order-7', reason: 'EXPIRED_NO_VENDOR_RESPONSE' },
      expect.objectContaining({
        attempts: 3,
        jobId: 'cor:order-7',
      }),
    );
  });

  it('swallows Redis enqueue failures so the order pipeline keeps moving', async () => {
    queue.add.mockRejectedValueOnce(new Error('Redis unreachable'));
    await expect(service.onOrderCreated({ orderId: 'order-1' })).resolves.toBeUndefined();
  });
});
