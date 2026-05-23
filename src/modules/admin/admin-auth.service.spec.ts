import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { UserRole } from '@prisma/client';
import { AdminAuthService } from './admin-auth.service';
import { AdminTotpService } from './admin-totp.service';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';

const TEST_META = { deviceCookie: null, ipAddress: '127.0.0.1', userAgent: 'jest' };

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let prisma: { user: { findUnique: jest.Mock } };
  let redis: {
    get: jest.Mock;
    incrWithTTL: jest.Mock;
    setWithTTL: jest.Mock;
    del: jest.Mock;
    client: { set: jest.Mock };
  };
  let totp: {
    isEnrolled: jest.Mock;
    verifyCode: jest.Mock;
    consumeRecoveryCode: jest.Mock;
  };
  let auth: { issueAdminSession: jest.Mock };

  const password = 'StrongPwd!2026';
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await argon2.hash(password);
  });

  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn() } };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      incrWithTTL: jest.fn().mockResolvedValue(1),
      setWithTTL: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(0),
      client: { set: jest.fn().mockResolvedValue('OK') },
    };
    totp = {
      // Default: admin has NOT enrolled, login returns access token immediately
      // (legacy / first-login path).
      isEnrolled: jest.fn().mockResolvedValue(false),
      verifyCode: jest.fn().mockResolvedValue(false),
      consumeRecoveryCode: jest.fn().mockResolvedValue(false),
    };
    auth = {
      issueAdminSession: jest.fn().mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        deviceId: 'dev-admin-1',
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        AdminAuthService,
        pinoLoggerProvider(AdminAuthService.name),
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: AdminTotpService, useValue: totp },
        { provide: AuthService, useValue: auth },
      ],
    }).compile();

    service = module.get(AdminAuthService);
  });

  it('issues a 15-min access + 24h refresh pair on valid credentials (no TOTP enrolled)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });

    const result = await service.login('Admin@ChopNow.App', password, TEST_META);

    expect(result).toEqual({
      stage: 'success',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      deviceId: 'dev-admin-1',
      role: UserRole.SUPER_ADMIN,
      email: 'admin@chopnow.app',
      expiresIn: 15 * 60, // Phase D1 — access TTL in seconds
    });
    // Delegates token minting to AuthService.issueAdminSession (which threads
    // the device fingerprint + admin refresh TTL through signTokens).
    expect(auth.issueAdminSession).toHaveBeenCalledWith('admin-1', UserRole.SUPER_ADMIN, TEST_META);
    // Counter reset on success — guards against locking a returning admin
    // who got it wrong once an hour ago
    expect(redis.del).toHaveBeenCalledWith('admin:login-attempts:admin-1');
  });

  it('rejects with invalid_credentials for an unknown email (no enumeration)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.login('nope@example.com', password, TEST_META)).rejects.toMatchObject({
      response: { code: 'invalid_credentials' },
    });
  });

  it('rejects with invalid_credentials when the user is not an admin role', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'consumer@example.com',
      passwordHash,
      role: UserRole.CONSUMER,
    });

    await expect(service.login('consumer@example.com', password, TEST_META)).rejects.toMatchObject({
      response: { code: 'invalid_credentials' },
    });
  });

  it('rejects with invalid_credentials when the user has no passwordHash', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash: null,
      role: UserRole.SUPER_ADMIN,
    });

    await expect(service.login('admin@chopnow.app', password, TEST_META)).rejects.toMatchObject({
      response: { code: 'invalid_credentials' },
    });
  });

  it('rejects with account_locked when the lock key is set', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });
    redis.get.mockResolvedValue('1');

    await expect(service.login('admin@chopnow.app', password, TEST_META)).rejects.toMatchObject({
      response: { code: 'account_locked' },
    });
    // Never even runs argon2 nor mints a session — short-circuit before
    // any expensive crypto / DB writes.
    expect(auth.issueAdminSession).not.toHaveBeenCalled();
  });

  it('increments the counter on a wrong password and surfaces invalid_credentials', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });
    redis.incrWithTTL.mockResolvedValue(2);

    await expect(
      service.login('admin@chopnow.app', 'WrongPwd!2026', TEST_META),
    ).rejects.toMatchObject({
      response: { code: 'invalid_credentials' },
    });
    expect(redis.incrWithTTL).toHaveBeenCalledWith('admin:login-attempts:admin-1', 15 * 60);
    // Below the threshold — no lock yet
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  it('locks the account on the 5th failed attempt (threshold = 5)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });
    redis.incrWithTTL.mockResolvedValue(5);

    await expect(
      service.login('admin@chopnow.app', 'WrongPwd!2026', TEST_META),
    ).rejects.toMatchObject({
      response: { code: 'account_locked' },
    });
    // Lock key set with no TTL — only manual unlock clears it
    expect(redis.client.set).toHaveBeenCalledWith('admin:locked:admin-1', '1');
  });

  it('unlock() clears both keys', async () => {
    await service.unlock('admin-1');
    expect(redis.del).toHaveBeenCalledWith('admin:locked:admin-1', 'admin:login-attempts:admin-1');
  });

  it('normalises the email (lowercase + trim) before lookup', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.login('  Admin@ChopNow.App  ', password, TEST_META),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'admin@chopnow.app' },
    });
  });

  describe('Phase A1 — TOTP 2FA flow', () => {
    // Factory not constant — `passwordHash` is set in `beforeAll`, which runs
    // AFTER object literals in describe-block scope are evaluated.
    const enrolledAdmin = () => ({
      id: 'admin-1',
      email: 'admin@chopnow.app',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
    });

    it('returns a totp_required challenge when the admin has confirmed enrollment', async () => {
      prisma.user.findUnique.mockResolvedValue(enrolledAdmin());
      totp.isEnrolled.mockResolvedValue(true);

      const result = await service.login('admin@chopnow.app', password, TEST_META);

      expect(result.stage).toBe('totp_required');
      expect((result as { challenge: string }).challenge).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      // No tokens issued yet — second factor pending.
      expect(auth.issueAdminSession).not.toHaveBeenCalled();
      // Challenge persisted in Redis with 5-min TTL.
      expect(redis.setWithTTL).toHaveBeenCalledWith(
        expect.stringMatching(/^admin:2fa-challenge:/),
        'admin-1',
        5 * 60,
      );
    });

    it('verifyTotpChallenge issues an access token on a valid code', async () => {
      // Pre-seed Redis with the challenge → userId mapping.
      const challenge = 'test-challenge-token-abc123';
      redis.get.mockResolvedValueOnce('admin-1');
      totp.verifyCode.mockResolvedValueOnce(true);
      prisma.user.findUnique.mockResolvedValueOnce(enrolledAdmin());

      const result = await service.verifyTotpChallenge(challenge, '123456', false, TEST_META);

      expect(result.stage).toBe('success');
      expect((result as { accessToken: string }).accessToken).toBe('access-token');
      // Challenge consumed on success
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining(challenge));
    });

    it('verifyTotpChallenge rejects with totp_challenge_expired when the challenge is unknown', async () => {
      redis.get.mockResolvedValueOnce(null);
      await expect(
        service.verifyTotpChallenge('expired-token', '123456', false, TEST_META),
      ).rejects.toMatchObject({
        response: { code: 'totp_challenge_expired' },
      });
      expect(totp.verifyCode).not.toHaveBeenCalled();
    });

    it('verifyTotpChallenge rejects with totp_invalid_code WITHOUT consuming the challenge (stale code retry)', async () => {
      redis.get.mockResolvedValueOnce('admin-1');
      totp.verifyCode.mockResolvedValueOnce(false);

      await expect(
        service.verifyTotpChallenge('challenge-1', '000000', false, TEST_META),
      ).rejects.toMatchObject({
        response: { code: 'totp_invalid_code' },
      });
      // Critical: a wrong code does NOT consume the challenge — the admin
      // can retry within the 5-min TTL without restarting from password.
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('verifyTotpChallenge accepts a single-use recovery code when isRecoveryCode=true', async () => {
      redis.get.mockResolvedValueOnce('admin-1');
      totp.consumeRecoveryCode.mockResolvedValueOnce(true);
      prisma.user.findUnique.mockResolvedValueOnce(enrolledAdmin());

      const result = await service.verifyTotpChallenge('challenge-1', 'ABCD-EFGH', true, TEST_META);

      expect(result.stage).toBe('success');
      expect(totp.consumeRecoveryCode).toHaveBeenCalledWith('admin-1', 'ABCD-EFGH');
      expect(totp.verifyCode).not.toHaveBeenCalled();
    });
  });
});
