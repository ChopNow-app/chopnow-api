import { WebPushService } from './web-push.service';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

import * as webpush from 'web-push';

describe('WebPushService', () => {
  let env: { vapid: { publicKey?: string; privateKey?: string; subject?: string } };
  let subs: {
    listForUser: jest.Mock;
    deactivateById: jest.Mock;
  };

  const configuredEnv = {
    vapid: {
      publicKey: 'BPUBLIC_KEY_BASE64',
      privateKey: 'PRIVATE_KEY_BASE64',
      subject: 'mailto:ops@tchopnow.app',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    subs = {
      listForUser: jest.fn().mockResolvedValue([]),
      deactivateById: jest.fn().mockResolvedValue(undefined),
    };
    env = configuredEnv;
  });

  function makeService() {
    return new WebPushService(env as never, subs as never);
  }

  it('configures VAPID once on construction', () => {
    makeService();
    expect(webpush.setVapidDetails).toHaveBeenCalledWith(
      'mailto:ops@tchopnow.app',
      'BPUBLIC_KEY_BASE64',
      'PRIVATE_KEY_BASE64',
    );
  });

  it('returns { sent: 0 } and skips push entirely when VAPID is unconfigured (graceful degrade)', async () => {
    env = { vapid: { publicKey: undefined, privateKey: undefined, subject: undefined } };
    const service = makeService();
    // setVapidDetails never called — caller will fall back to WhatsApp.
    expect(webpush.setVapidDetails).not.toHaveBeenCalled();
    const result = await service.sendToUser('user-1', { title: 't', body: 'b' });
    expect(result).toEqual({ sent: 0, deactivated: 0 });
    expect(subs.listForUser).not.toHaveBeenCalled();
  });

  it('returns { sent: 0 } when the user has no subscriptions', async () => {
    const service = makeService();
    const result = await service.sendToUser('user-1', { title: 't', body: 'b' });
    expect(result).toEqual({ sent: 0, deactivated: 0 });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('sends to every subscription and counts successes', async () => {
    subs.listForUser.mockResolvedValueOnce([
      { id: 's1', endpoint: 'https://fcm/1', p256dh: 'p1', auth: 'a1' },
      { id: 's2', endpoint: 'https://mozilla/2', p256dh: 'p2', auth: 'a2' },
    ]);
    (webpush.sendNotification as jest.Mock).mockResolvedValue({ statusCode: 201 });

    const service = makeService();
    const result = await service.sendToUser('user-1', {
      title: 'New order',
      body: 'TC-A23F4',
      data: { orderId: 'order-42' },
    });

    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    // Payload is JSON-stringified so the SW can JSON.parse it.
    const [, body] = (webpush.sendNotification as jest.Mock).mock.calls[0];
    expect(JSON.parse(body)).toMatchObject({ title: 'New order', body: 'TC-A23F4' });
    expect(result).toEqual({ sent: 2, deactivated: 0 });
    expect(subs.deactivateById).not.toHaveBeenCalled();
  });

  it('deactivates a subscription when the push service returns 410 Gone', async () => {
    subs.listForUser.mockResolvedValueOnce([
      { id: 's-stale', endpoint: 'https://fcm/stale', p256dh: 'p', auth: 'a' },
      { id: 's-live', endpoint: 'https://fcm/live', p256dh: 'p', auth: 'a' },
    ]);
    (webpush.sendNotification as jest.Mock)
      .mockRejectedValueOnce({ statusCode: 410, message: 'Gone' })
      .mockResolvedValueOnce({ statusCode: 201 });

    const service = makeService();
    const result = await service.sendToUser('user-1', { title: 't', body: 'b' });

    expect(subs.deactivateById).toHaveBeenCalledWith('s-stale');
    expect(subs.deactivateById).not.toHaveBeenCalledWith('s-live');
    expect(result).toEqual({ sent: 1, deactivated: 1 });
  });

  it('treats 404 Not Found the same as 410 Gone', async () => {
    subs.listForUser.mockResolvedValueOnce([
      { id: 's-404', endpoint: 'https://fcm/404', p256dh: 'p', auth: 'a' },
    ]);
    (webpush.sendNotification as jest.Mock).mockRejectedValueOnce({
      statusCode: 404,
      message: 'Not Found',
    });
    const service = makeService();
    const result = await service.sendToUser('user-1', { title: 't', body: 'b' });
    expect(result).toEqual({ sent: 0, deactivated: 1 });
  });

  it('does NOT deactivate on transient errors (429, network blip)', async () => {
    subs.listForUser.mockResolvedValueOnce([
      { id: 's1', endpoint: 'https://fcm/1', p256dh: 'p', auth: 'a' },
    ]);
    (webpush.sendNotification as jest.Mock).mockRejectedValueOnce({
      statusCode: 429,
      message: 'Too Many Requests',
    });
    const service = makeService();
    const result = await service.sendToUser('user-1', { title: 't', body: 'b' });
    expect(subs.deactivateById).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, deactivated: 0 });
  });

  it('one stale subscription does not break the batch (Promise.allSettled)', async () => {
    subs.listForUser.mockResolvedValueOnce([
      { id: 'a', endpoint: 'https://1', p256dh: 'p', auth: 'a' },
      { id: 'b', endpoint: 'https://2', p256dh: 'p', auth: 'a' },
      { id: 'c', endpoint: 'https://3', p256dh: 'p', auth: 'a' },
    ]);
    (webpush.sendNotification as jest.Mock)
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockResolvedValueOnce({ statusCode: 201 });

    const service = makeService();
    const result = await service.sendToUser('user-1', { title: 't', body: 'b' });
    expect(result).toEqual({ sent: 2, deactivated: 1 });
  });
});
