import { PushSubscriptionsService } from './push-subscriptions.service';

describe('PushSubscriptionsService', () => {
  let prisma: {
    pushSubscription: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      delete: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let service: PushSubscriptionsService;

  beforeEach(() => {
    prisma = {
      pushSubscription: {
        upsert: jest.fn().mockResolvedValue({ id: 'sub-1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    service = new PushSubscriptionsService(prisma as never);
  });

  it('upserts on (userId, deviceFingerprint) — same device re-subscribing refreshes endpoint', async () => {
    await service.upsert('user-1', {
      endpoint: 'https://fcm/refreshed',
      keys: { p256dh: 'newP', auth: 'newA' },
      deviceFingerprint: 'iphone-bonamoussadi-1',
    });

    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_deviceFingerprint: {
            userId: 'user-1',
            deviceFingerprint: 'iphone-bonamoussadi-1',
          },
        },
        create: expect.objectContaining({
          userId: 'user-1',
          endpoint: 'https://fcm/refreshed',
          p256dh: 'newP',
          auth: 'newA',
        }),
        update: expect.objectContaining({
          endpoint: 'https://fcm/refreshed',
          p256dh: 'newP',
          auth: 'newA',
          lastUsedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('deactivateByEndpoint is idempotent', async () => {
    prisma.pushSubscription.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      service.deactivateByEndpoint('user-1', 'https://fcm/gone'),
    ).resolves.toBeUndefined();
  });

  it('deactivateById swallows race when row already deleted', async () => {
    prisma.pushSubscription.delete.mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { code: 'P2025' }),
    );
    await expect(service.deactivateById('sub-gone')).resolves.toBeUndefined();
  });
});
