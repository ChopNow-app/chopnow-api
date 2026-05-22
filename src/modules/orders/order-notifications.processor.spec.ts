import { Job } from 'bullmq';
import { OrderNotificationsProcessor } from './order-notifications.processor';
import { OrdersExpiryService } from './orders-expiry.service';
import { CONSUMER_ORDER_REFUSED_JOB, VENDOR_NEW_ORDER_JOB } from './order-notifications.constants';

describe('OrderNotificationsProcessor', () => {
  let processor: OrderNotificationsProcessor;
  let prisma: { order: { findUnique: jest.Mock } };
  let twilio: { sendWhatsApp: jest.Mock };
  let webPush: { sendToUser: jest.Mock };

  // PinoLogger no-op — tests don't assert on log output.
  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    setContext: jest.fn(),
  };

  const refusedOrderRow = {
    code: 'TC-A23F4',
    user: { phone: '+237670000123' },
    vendor: { name: 'Chez Maman Mboué' },
  };

  beforeEach(() => {
    prisma = { order: { findUnique: jest.fn().mockResolvedValue(refusedOrderRow) } };
    twilio = { sendWhatsApp: jest.fn().mockResolvedValue('SMxxx') };
    webPush = { sendToUser: jest.fn().mockResolvedValue({ sent: 0, deactivated: 0 }) };
    processor = new OrderNotificationsProcessor(
      logger as never,
      prisma as never,
      twilio as never,
      webPush as never,
    );
  });

  // The processor's `process()` dispatches on job.name; building a minimal
  // Job-shaped object is enough — BullMQ doesn't validate any other fields
  // when called directly in tests.
  function job<T>(name: string, data: T): Job<T> {
    return { name, data, id: 'job-1' } as unknown as Job<T>;
  }

  describe('consumer-order-refused', () => {
    it('sends a friendly WhatsApp on auto-expire refusal', async () => {
      await processor.process(
        job(CONSUMER_ORDER_REFUSED_JOB, {
          orderId: 'order-1',
          reason: OrdersExpiryService.EXPIRED_REASON,
        }),
      );
      expect(twilio.sendWhatsApp).toHaveBeenCalledTimes(1);
      const [phone, body] = twilio.sendWhatsApp.mock.calls[0];
      expect(phone).toBe('+237670000123');
      expect(body).toContain('Chez Maman Mboué');
      expect(body).toContain('TC-A23F4');
      expect(body).toContain("n'a pas répondu");
      expect(body).not.toContain('EXPIRED_NO_VENDOR_RESPONSE'); // raw code never leaks
    });

    it('humanizes a vendor-chosen reason (ITEM_OUT_OF_STOCK)', async () => {
      await processor.process(
        job(CONSUMER_ORDER_REFUSED_JOB, { orderId: 'order-1', reason: 'ITEM_OUT_OF_STOCK' }),
      );
      const body = twilio.sendWhatsApp.mock.calls[0][1] as string;
      expect(body).toContain('épuisé');
      expect(body).not.toContain('ITEM_OUT_OF_STOCK');
    });

    it('appends the free-text note when present (OTHER: …)', async () => {
      await processor.process(
        job(CONSUMER_ORDER_REFUSED_JOB, {
          orderId: 'order-1',
          reason: 'OTHER: trop loin pour la moto',
        }),
      );
      const body = twilio.sendWhatsApp.mock.calls[0][1] as string;
      expect(body).toContain('Autre motif');
      expect(body).toContain('trop loin pour la moto');
    });

    it('skips delivery if the order has no phone (defensive, no retry)', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        ...refusedOrderRow,
        user: { phone: null },
      });
      await expect(
        processor.process(
          job(CONSUMER_ORDER_REFUSED_JOB, { orderId: 'order-1', reason: 'CLOSED' }),
        ),
      ).resolves.toBeUndefined();
      expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    });

    it('propagates Twilio errors so BullMQ can retry the job', async () => {
      twilio.sendWhatsApp.mockRejectedValueOnce(new Error('Twilio 500'));
      await expect(
        processor.process(
          job(CONSUMER_ORDER_REFUSED_JOB, { orderId: 'order-1', reason: 'CLOSED' }),
        ),
      ).rejects.toThrow('Twilio 500');
    });
  });

  describe('vendor-new-order', () => {
    const createdOrder = {
      code: 'TC-A23F4',
      totalXAF: 4350,
      paymentMethod: 'MTN_MOMO',
      items: [{ quantity: 2 }, { quantity: 1 }],
      vendor: {
        whatsappPhone: '+237670000101',
        name: 'Chez Maman Mboué',
        userId: 'vendor-user-1',
      },
    };

    it('sends Web Push to the vendor (push-first) when at least one subscription is reachable', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(createdOrder);
      webPush.sendToUser.mockResolvedValueOnce({ sent: 2, deactivated: 0 });

      await processor.process(job(VENDOR_NEW_ORDER_JOB, { orderId: 'order-42' }));

      expect(webPush.sendToUser).toHaveBeenCalledWith('vendor-user-1', expect.any(Object));
      const payload = webPush.sendToUser.mock.calls[0][1];
      expect(payload.title).toContain('TC-A23F4');
      expect(payload.body).toContain('3 plat');
      expect(payload.body).toContain('Payé via MTN MoMo');
      expect(payload.data).toMatchObject({
        kind: 'ORDER_CREATED',
        orderId: 'order-42',
        deepLink: '/vendor/commande/order-42',
      });
      expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    });

    it('falls back to WhatsApp when push reached zero subscriptions', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(createdOrder);

      await processor.process(job(VENDOR_NEW_ORDER_JOB, { orderId: 'order-42' }));

      expect(webPush.sendToUser).toHaveBeenCalledTimes(1);
      expect(twilio.sendWhatsApp).toHaveBeenCalledTimes(1);
      const [phone, body] = twilio.sendWhatsApp.mock.calls[0];
      expect(phone).toBe('+237670000101');
      expect(body).toContain('TC-A23F4');
      expect(body).toContain('3 plat');
      expect(body).toMatch(/4\s350\s*FCFA/);
      expect(body).toContain('Payé via MTN MoMo');
      expect(body).toContain('60 secondes');
      expect(body).toContain('tchopnow.app/vendor/commande/order-42');
    });

    it('labels Orange Money distinctly from MTN MoMo', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        ...createdOrder,
        paymentMethod: 'ORANGE_MONEY',
      });

      await processor.process(job(VENDOR_NEW_ORDER_JOB, { orderId: 'order-42' }));

      const pushBody = webPush.sendToUser.mock.calls[0][1].body as string;
      expect(pushBody).toContain('Payé via Orange Money');
      expect(pushBody).not.toContain('MTN');
      const waBody = twilio.sendWhatsApp.mock.calls[0][1] as string;
      expect(waBody).toContain('Payé via Orange Money');
    });

    it('skips both channels when the vendor has no whatsappPhone AND push had zero subscriptions', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        ...createdOrder,
        vendor: { whatsappPhone: null, name: 'Phoneless', userId: 'vendor-user-1' },
      });
      await processor.process(job(VENDOR_NEW_ORDER_JOB, { orderId: 'order-42' }));
      expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
      expect(webPush.sendToUser).toHaveBeenCalledTimes(1);
    });

    it('propagates a push transport error so BullMQ retries the whole job', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(createdOrder);
      webPush.sendToUser.mockRejectedValueOnce(new Error('VAPID misconfigured'));
      await expect(
        processor.process(job(VENDOR_NEW_ORDER_JOB, { orderId: 'order-42' })),
      ).rejects.toThrow('VAPID misconfigured');
      // WhatsApp NOT attempted on this attempt — the retry covers the fallback.
      expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    });

    it('propagates Twilio errors so BullMQ can retry the fallback', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(createdOrder);
      twilio.sendWhatsApp.mockRejectedValueOnce(new Error('Twilio 429'));
      await expect(
        processor.process(job(VENDOR_NEW_ORDER_JOB, { orderId: 'order-42' })),
      ).rejects.toThrow('Twilio 429');
    });

    it('logs + skips when the order has been deleted between enqueue and process (no retry)', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(null);
      await expect(
        processor.process(job(VENDOR_NEW_ORDER_JOB, { orderId: 'gone' })),
      ).resolves.toBeUndefined();
      expect(webPush.sendToUser).not.toHaveBeenCalled();
      expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  it('ignores unknown job names without throwing (just logs)', async () => {
    await expect(processor.process(job('unknown-job', { orderId: 'x' }))).resolves.toBeUndefined();
    expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    expect(webPush.sendToUser).not.toHaveBeenCalled();
  });
});
