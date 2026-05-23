import { Test } from '@nestjs/testing';
import { DeviceService, summarizeUserAgent } from './device.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { EnvService } from '../../infra/config/env.service';
import { MailService } from '../../infra/mail/mail.service';
import { WebPushService } from '../notifications/web-push.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';

describe('DeviceService', () => {
  let service: DeviceService;
  let prisma: {
    device: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let mail: { send: jest.Mock };
  let webPush: { sendToUser: jest.Mock };

  beforeEach(async () => {
    prisma = {
      device: {
        findFirst: jest.fn(),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'dev-new',
          firstSeenAt: new Date('2026-05-22T20:00:00Z'),
          lastSeenAt: new Date('2026-05-22T20:00:00Z'),
          ...data,
        })),
        update: jest.fn().mockImplementation(({ where, data }) => ({
          id: where.id,
          firstSeenAt: new Date('2026-05-20T10:00:00Z'),
          lastSeenAt: data.lastSeenAt ?? new Date(),
          ...data,
        })),
      },
      user: { findUnique: jest.fn() },
    };
    mail = { send: jest.fn().mockResolvedValue({ id: 'mail-1' }) };
    webPush = { sendToUser: jest.fn().mockResolvedValue({ sent: 0, deactivated: 0 }) };

    const module = await Test.createTestingModule({
      providers: [
        DeviceService,
        pinoLoggerProvider(DeviceService.name),
        { provide: PrismaService, useValue: prisma },
        { provide: EnvService, useValue: { appUrl: 'https://app.tchopnow.app' } },
        { provide: MailService, useValue: mail },
        { provide: WebPushService, useValue: webPush },
      ],
    }).compile();
    service = module.get(DeviceService);
  });

  describe('resolveDevice', () => {
    it('returns isNew=true when no cookie is presented (fresh sign-in)', async () => {
      const result = await service.resolveDevice('user-1', {
        deviceCookie: null,
        ipAddress: '10.0.0.1',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      });
      expect(result.isNew).toBe(true);
      expect(prisma.device.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            ipAddress: '10.0.0.1',
            userAgentLabel: 'Safari sur iPhone/iPad',
          }),
        }),
      );
    });

    it('returns isNew=false + updates lastSeen when the cookie matches an existing row', async () => {
      prisma.device.findFirst.mockResolvedValueOnce({ id: 'dev-known', userId: 'user-1' });
      const result = await service.resolveDevice('user-1', {
        deviceCookie: 'dev-known',
        ipAddress: '10.0.0.2',
        userAgent: 'Mozilla/5.0',
      });
      expect(result.isNew).toBe(false);
      expect(prisma.device.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dev-known' },
          data: expect.objectContaining({ ipAddress: '10.0.0.2' }),
        }),
      );
    });

    it('mints a fresh device + isNew=true when the cookie belongs to a different user', async () => {
      // findFirst is scoped to userId so a stolen cookie from a different
      // user simply doesn't match — no cross-user leak.
      prisma.device.findFirst.mockResolvedValueOnce(null);
      const result = await service.resolveDevice('user-2', {
        deviceCookie: 'dev-belongs-to-user-1',
        ipAddress: '10.0.0.3',
        userAgent: 'Mozilla/5.0',
      });
      expect(result.isNew).toBe(true);
      expect(prisma.device.create).toHaveBeenCalled();
    });

    it('records null UA hash + label when no User-Agent header was sent', async () => {
      await service.resolveDevice('user-1', {
        deviceCookie: null,
        ipAddress: '10.0.0.1',
        userAgent: null,
      });
      expect(prisma.device.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userAgentHash: null,
            userAgentLabel: null,
          }),
        }),
      );
    });
  });

  describe('sendNewDeviceAlert', () => {
    const deviceRow = {
      id: 'dev-new',
      firstSeenAt: new Date('2026-05-22T20:00:00Z'),
      ipAddress: '10.0.0.1',
      userAgentLabel: 'Chrome sur Android',
    } as Parameters<DeviceService['sendNewDeviceAlert']>[1];

    it('sends an email when the user has one on file', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        email: 'a@b.com',
        displayName: 'Kouamé',
      });
      await service.sendNewDeviceAlert('user-1', deviceRow);
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'a@b.com',
          subject: expect.stringContaining('Nouvelle connexion'),
          html: expect.stringContaining('Chrome sur Android'),
        }),
      );
    });

    it('no-ops silently when the user has no email (phone-only consumer)', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ email: null, displayName: null });
      await service.sendNewDeviceAlert('user-1', deviceRow);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('swallows mail.send errors — verifyOtp must not fail because of a flaky Resend', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ email: 'a@b.com', displayName: null });
      mail.send.mockRejectedValueOnce(new Error('Resend 503'));
      await expect(service.sendNewDeviceAlert('user-1', deviceRow)).resolves.toBeUndefined();
    });
  });

  describe('sendDeviceMismatchAlert (Phase D2)', () => {
    it('sends a stronger-worded alert when the user has an email', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        email: 'a@b.com',
        displayName: 'Kouamé',
      });
      await service.sendDeviceMismatchAlert('user-1', {
        ipAddress: '203.0.113.55',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0',
      });
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'a@b.com',
          // Stronger subject than the C2 "new device" alert
          subject: expect.stringContaining('Alerte sécurité'),
          html: expect.stringContaining('appareil différent'),
        }),
      );
    });

    it('no-ops silently for phone-only consumers (no email)', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ email: null, displayName: null });
      await service.sendDeviceMismatchAlert('user-1', {
        ipAddress: null,
        userAgent: null,
      });
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('swallows mail.send errors so the refresh path still 401s cleanly', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ email: 'a@b.com', displayName: null });
      mail.send.mockRejectedValueOnce(new Error('Resend 503'));
      await expect(
        service.sendDeviceMismatchAlert('user-1', { ipAddress: null, userAgent: null }),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendNewDevicePush (Phase D3)', () => {
    const deviceRow = {
      id: 'dev-new',
      ipAddress: '10.0.0.1',
      userAgentLabel: 'Chrome sur Android',
    } as Parameters<DeviceService['sendNewDevicePush']>[1];

    it('fans out a Web Push notification via WebPushService.sendToUser', async () => {
      webPush.sendToUser.mockResolvedValueOnce({ sent: 2, deactivated: 0 });
      await service.sendNewDevicePush('user-1', deviceRow);
      expect(webPush.sendToUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          title: 'Nouvelle connexion détectée',
          body: expect.stringContaining('Chrome sur Android'),
          data: expect.objectContaining({
            kind: 'new_device_signin',
            deviceId: 'dev-new',
            url: 'https://app.tchopnow.app/account?next=revoke-all',
          }),
        }),
      );
    });

    it('no-ops cleanly when user has no subscriptions (sendToUser returns sent=0)', async () => {
      webPush.sendToUser.mockResolvedValueOnce({ sent: 0, deactivated: 0 });
      await expect(service.sendNewDevicePush('user-1', deviceRow)).resolves.toBeUndefined();
    });

    it('swallows WebPush errors so verifyOtp stays fast + successful', async () => {
      webPush.sendToUser.mockRejectedValueOnce(new Error('VAPID network blip'));
      await expect(service.sendNewDevicePush('user-1', deviceRow)).resolves.toBeUndefined();
    });
  });
});

describe('summarizeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1',
      'Safari sur iPhone/iPad',
    ],
    ['Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0', 'Chrome sur Android'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0', 'Chrome sur Mac'],
    ['Mozilla/5.0 (Windows NT 10.0) Firefox/118.0', 'Firefox sur Windows'],
    ['curl/8.0.1', 'curl/8.0.1'],
  ])('summarizes %s → %s', (ua, expected) => {
    expect(summarizeUserAgent(ua)).toBe(expected);
  });

  it('trims very long opaque UAs to 80 chars', () => {
    const ua = 'X'.repeat(500);
    expect(summarizeUserAgent(ua).length).toBeLessThanOrEqual(80);
  });
});
