import { OrderNotificationsService } from './order-notifications.service';
import { OrdersExpiryService } from './orders-expiry.service';

describe('OrderNotificationsService', () => {
  let service: OrderNotificationsService;
  let prisma: { order: { findUnique: jest.Mock } };
  let twilio: { sendWhatsApp: jest.Mock };

  const orderRow = {
    code: 'TC-A23F4',
    user: { phone: '+237670000123' },
    vendor: { name: 'Chez Maman Mboué' },
  };

  beforeEach(() => {
    prisma = { order: { findUnique: jest.fn().mockResolvedValue(orderRow) } };
    twilio = { sendWhatsApp: jest.fn().mockResolvedValue('SMxxx') };
    service = new OrderNotificationsService(prisma as never, twilio as never);
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
      paymentMethod: 'CASH',
      items: [{ quantity: 2 }, { quantity: 1 }],
      vendor: { whatsappPhone: '+237670000101', name: 'Chez Maman Mboué' },
    };

    it('pings the vendor WhatsApp with code + item count + total + countdown link', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(createdOrder);

      await service.onOrderCreated({ orderId: 'order-42' });

      expect(twilio.sendWhatsApp).toHaveBeenCalledTimes(1);
      const [phone, body] = twilio.sendWhatsApp.mock.calls[0];
      expect(phone).toBe('+237670000101'); // vendor phone, NOT consumer
      expect(body).toContain('TC-A23F4'); // order code
      expect(body).toContain('3 plats'); // 2 + 1
      // Node's fr-FR locale uses NBSP (U+202F) between thousands; assert the
      // digits + FCFA suffix loosely so a future locale upgrade doesn't break.
      expect(body).toMatch(/4\s350\s*FCFA/);
      expect(body).toContain('Cash à la livraison');
      expect(body).toContain('60 secondes');
      // Deep link to the countdown screen — must include the actual orderId
      expect(body).toContain('tchopnow.app/vendor/commande/order-42');
    });

    it('labels MoMo payments distinctly from cash', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        ...createdOrder,
        paymentMethod: 'MTN_MOMO',
      });

      await service.onOrderCreated({ orderId: 'order-42' });
      const body = twilio.sendWhatsApp.mock.calls[0][1] as string;
      expect(body).toContain('Payé via MoMo');
      expect(body).not.toContain('Cash');
    });

    it('skips silently when the vendor has no whatsappPhone (defensive)', async () => {
      prisma.order.findUnique.mockResolvedValueOnce({
        ...createdOrder,
        vendor: { whatsappPhone: null, name: 'Phoneless' },
      });
      await service.onOrderCreated({ orderId: 'order-42' });
      expect(twilio.sendWhatsApp).not.toHaveBeenCalled();
    });

    it('swallows Twilio errors so a stuck sandbox window cannot break order creation', async () => {
      prisma.order.findUnique.mockResolvedValueOnce(createdOrder);
      twilio.sendWhatsApp.mockRejectedValueOnce(new Error('Twilio 429'));
      await expect(service.onOrderCreated({ orderId: 'order-42' })).resolves.toBeUndefined();
    });
  });
});
