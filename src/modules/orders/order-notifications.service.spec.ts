import { OrderNotificationsService } from './order-notifications.service';
import { OrdersExpiryService } from './orders-expiry.service';

describe('OrderNotificationsService', () => {
  let service: OrderNotificationsService;
  let prisma: { order: { findUnique: jest.Mock } };
  let twilio: { sendWhatsApp: jest.Mock };
  let webPush: { sendToUser: jest.Mock };

  const orderRow = {
    code: 'TC-A23F4',
    user: { phone: '+237670000123' },
    vendor: { name: 'Chez Maman Mboué' },
  };

  // PinoLogger no-op — tests don't assert on log output.
  const logger = {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    setContext: jest.fn(),
  };

  beforeEach(() => {
    prisma = { order: { findUnique: jest.fn().mockResolvedValue(orderRow) } };
    twilio = { sendWhatsApp: jest.fn().mockResolvedValue('SMxxx') };
    // Default: no push subscriptions reached → WhatsApp fallback fires.
    // Tests that assert push-success path override with sent > 0.
    webPush = { sendToUser: jest.fn().mockResolvedValue({ sent: 0, deactivated: 0 }) };
    service = new OrderNotificationsService(
      logger as never,
      prisma as never,
      twilio as never,
      webPush as never,
    );
  });

  it('sends a friendly WhatsApp on auto-expire refusal', async () => {
    await service.onOrderRefused({
      orderId: 'order-1',
      reason: OrdersExpiryService.EXPIRED_REASON,
    });
    expect(twilio.sendWhatsApp).toHaveBeenCalledTimes(1);
    const [phone, body] = twilio.sendWhatsApp.mock.calls[0];
    expect(phone).toBe('+237670000123');
    expect(body).toContain('Chez Maman Mboué');
    expect(body).toContain('TC-A23F4');
    expect(body).toContain("n'a pas répondu");
    expect(body).not.toContain('EXPIRED_NO_VENDOR_RESPONSE'); // raw code never leaks
  });

  it('humanizes a vendor-chosen reason (ITEM_OUT_OF_STOCK)', async () => {
    await service.onOrderRefused({ orderId: 'order-1', reason: 'ITEM_OUT_OF_STOCK' });
    const body = twilio.sendWhatsApp.mock.calls[0][1] as string;
    expect(body).toContain('épuisé');
    expect(body).not.toContain('ITEM_OUT_OF_STOCK');
  });

  it('appends the free-text note when present (OTHER: …)', async () => {
    await service.onOrderRefused({
      orderId: 'order-1',
      reason: 'OTHER: trop loin pour la moto',
    });
    const body = twilio.sendWhatsApp.mock.calls[0][1] as string;
    expect(body).toContain('Autre motif');
    expect(body).toContain('trop loin pour la moto');
  });

  it('skips delivery if the order has no phone (defensive)', async () => {
    prisma.order.findUnique.mockResolvedValueOnce({
      ...orderRow,
      user: { phone: null },
    });
    await service.onOrderRefused({ orderId: 'order-1', reason: 'CLOSED' });
    expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('swallows Twilio errors — never propagates to the order pipeline', async () => {
    twilio.sendWhatsApp.mockRejectedValueOnce(new Error('Twilio 500'));
    await expect(
      service.onOrderRefused({ orderId: 'order-1', reason: 'CLOSED' }),
    ).resolves.toBeUndefined();
  });

  describe('onOrderCreated', () => {
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

      await service.onOrderCreated({ orderId: 'order-42' });

      expect(webPush.sendToUser).toHaveBeenCalledWith('vendor-user-1', expect.any(Object));
      const payload = webPush.sendToUser.mock.calls[0][1];
      expect(payload.title).toContain('TC-A23F4');
      expect(payload.body).toContain('3 plat'); // 2 + 1 (matches 'plat' or 'plats')
      expect(payload.body).toContain('Payé via MTN MoMo');
      expect(payload.data).toMatchObject({
        kind: 'ORDER_CREATED',
        orderId: 'order-42',
        deepLink: '/vendor/commande/order-42',
      });
      // Push reached subscriptions → vendor already got the native
      // notification, no need to also fire WhatsApp.
      expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    });

    it('falls back to WhatsApp when push reached zero subscriptions', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(createdOrder);
      // Default mock already returns { sent: 0 } — vendor has no PWA installed.

      await service.onOrderCreated({ orderId: 'order-42' });

      expect(webPush.sendToUser).toHaveBeenCalledTimes(1); // push was attempted first
      expect(twilio.sendWhatsApp).toHaveBeenCalledTimes(1);
      const [phone, body] = twilio.sendWhatsApp.mock.calls[0];
      expect(phone).toBe('+237670000101'); // vendor phone, NOT consumer
      expect(body).toContain('TC-A23F4');
      expect(body).toContain('3 plat'); // matches both 'plat' and 'plats'
      // Node's fr-FR locale uses NBSP (U+202F) between thousands.
      expect(body).toMatch(/4\s350\s*FCFA/);
      expect(body).toContain('Payé via MTN MoMo');
      expect(body).toContain('60 secondes');
      expect(body).toContain('tchopnow.app/vendor/commande/order-42');
    });

    it('labels Orange Money distinctly from MTN MoMo (push payload + WhatsApp fallback)', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        ...createdOrder,
        paymentMethod: 'ORANGE_MONEY',
      });

      await service.onOrderCreated({ orderId: 'order-42' });

      const pushBody = webPush.sendToUser.mock.calls[0][1].body as string;
      expect(pushBody).toContain('Payé via Orange Money');
      expect(pushBody).not.toContain('MTN');
      const waBody = twilio.sendWhatsApp.mock.calls[0][1] as string;
      expect(waBody).toContain('Payé via Orange Money');
    });

    it('skips both channels when the vendor has no whatsappPhone AND no push subscriptions', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        ...createdOrder,
        vendor: { whatsappPhone: null, name: 'Phoneless', userId: 'vendor-user-1' },
      });
      await service.onOrderCreated({ orderId: 'order-42' });
      expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
      // Push was attempted (correct behavior — pre-installed PWA might exist
      // even before the WhatsApp number is captured during onboarding).
      expect(webPush.sendToUser).toHaveBeenCalledTimes(1);
    });

    it('still attempts WhatsApp fallback even when the push call rejects', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(createdOrder);
      // Push throws (push service outage). The try/catch wraps both attempts
      // so the WhatsApp fallback should NOT fire in this branch — we don't
      // know whether the push actually went through. This is the conservative
      // choice; a vendor might still see the push despite the error.
      webPush.sendToUser.mockRejectedValueOnce(new Error('VAPID misconfigured'));
      await expect(service.onOrderCreated({ orderId: 'order-42' })).resolves.toBeUndefined();
      // Documented behavior: outer try/catch swallows; WhatsApp NOT attempted.
      expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    });

    it('swallows Twilio errors so a stuck sandbox window cannot break order creation', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(createdOrder);
      twilio.sendWhatsApp.mockRejectedValueOnce(new Error('Twilio 429'));
      await expect(service.onOrderCreated({ orderId: 'order-42' })).resolves.toBeUndefined();
    });
  });
});
