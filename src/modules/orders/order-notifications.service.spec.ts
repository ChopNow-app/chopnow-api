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
});
