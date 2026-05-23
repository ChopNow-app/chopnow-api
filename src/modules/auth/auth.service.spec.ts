import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { OtpStatus, UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { OtpDeliveryService } from '../../infra/twilio/otp-delivery.service';
import { DeviceService } from './device.service';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';

const TEST_META = { deviceCookie: null, ipAddress: '127.0.0.1', userAgent: 'jest' };

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    otpLog: {
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    user: { upsert: jest.Mock; findUnique: jest.Mock };
    refreshToken: {
      create: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let otpDelivery: { sendOtp: jest.Mock };
  let redis: { setNX: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    prisma = {
      otpLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        upsert: jest.fn().mockResolvedValue({ id: 'user-1', role: 'CONSUMER' }),
        findUnique: jest.fn(),
      },
      refreshToken: {
        // signTokens (called by verifyOtp + refresh) goes through $transaction,
        // which forwards `tx` = the same prisma object. create/update inside
        // the txn use these mocks.
        create: jest.fn().mockImplementation(({ data }) => ({ id: 'rt-new', ...data })),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };
    otpDelivery = {
      sendOtp: jest.fn().mockResolvedValue({ channel: 'WHATSAPP', providerMessageId: 'SMxxx' }),
    };
    // Default: lock always acquired (no in-flight collision). Individual
    // tests override with false to assert the short-circuit branch.
    redis = {
      setNX: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockResolvedValue(1),
    };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        pinoLoggerProvider(AuthService.name),
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: {
            // Distinguish access vs refresh by inspecting the secret the caller
            // passes — verifyOtp/signTokens calls signAsync twice, once per kind.
            signAsync: jest.fn().mockImplementation((_payload, opts) => {
              const secret = String(opts?.secret ?? '');
              return Promise.resolve(secret.startsWith('a') ? 'access-jwt' : 'refresh-jwt');
            }),
          },
        },
        {
          provide: EnvService,
          useValue: {
            nodeEnv: 'test',
            jwtAccessSecret: 'a'.repeat(64),
            jwtRefreshSecret: 'b'.repeat(64),
            jwtAccessTtl: '24h',
            jwtRefreshTtl: '30d',
          },
        },
        { provide: OtpDeliveryService, useValue: otpDelivery },
        { provide: RedisService, useValue: redis },
        {
          // Stub DeviceService: every resolveDevice call returns a fresh
          // device id; tests that care about new-device alert specifics
          // can spy on the methods themselves.
          provide: DeviceService,
          useValue: {
            resolveDevice: jest.fn().mockImplementation(async () => ({
              device: { id: 'dev-1' },
              isNew: false,
            })),
            sendNewDeviceAlert: jest.fn().mockResolvedValue(undefined),
            sendDeviceMismatchAlert: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('generateCode (security regression — must not use Math.random)', () => {
    /**
     * If a future change reintroduces Math.random() into the OTP path,
     * an attacker who observes a handful of own-phone OTPs can predict
     * the V8 PRNG state and forge the next OTP for any victim phone.
     * Lock the contract here in addition to the ESLint guard.
     */
    it('does NOT call Math.random when generating an OTP', async () => {
      const mathRandomSpy = jest.spyOn(Math, 'random');
      // Drop the test-env short-circuit so the real generation path runs.
      type Internal = { generateCode: () => string; env: { nodeEnv: string } };
      const internal = service as unknown as Internal;
      internal.env.nodeEnv = 'development';
      try {
        for (let i = 0; i < 100; i++) {
          const code = internal.generateCode();
          expect(code).toMatch(/^\d{6}$/);
        }
        expect(mathRandomSpy).not.toHaveBeenCalled();
      } finally {
        internal.env.nodeEnv = 'test';
        mathRandomSpy.mockRestore();
      }
    });
  });

  describe('requestOtp', () => {
    it('normalizes a Cameroon-local phone before persisting', async () => {
      await service.requestOtp('670000000');

      // Both the create (initial PENDING) and the post-send update
      // should reference the canonical +237 form, not the bare 9-digit input.
      const created = prisma.otpLog.create.mock.calls[0][0].data;
      expect(created.phone).toBe('+237670000000');
      expect(otpDelivery.sendOtp).toHaveBeenCalledWith('+237670000000', expect.any(String));
    });

    it('passes through E.164 international numbers unchanged', async () => {
      await service.requestOtp('+33695412820');

      const created = prisma.otpLog.create.mock.calls[0][0].data;
      expect(created.phone).toBe('+33695412820');
      expect(otpDelivery.sendOtp).toHaveBeenCalledWith('+33695412820', expect.any(String));
    });

    it('stores SENT (not DELIVERED) and the provider SID after a successful send', async () => {
      // The optimistic DELIVERED bug: messages.create() returning a SID does not
      // mean the message was delivered — it might still fail downstream. The
      // status webhook reconciles to DELIVERED/FAILED later.
      await service.requestOtp('670000000');

      const updateArgs = prisma.otpLog.update.mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: 'log-1' });
      expect(updateArgs.data).toMatchObject({
        status: OtpStatus.SENT,
        providerMessageId: 'SMxxx',
        channel: 'WHATSAPP',
      });
      expect(updateArgs.data.deliveredAt).toBeUndefined();
    });

    it('marks the row FAILED when delivery throws and surfaces a generic error', async () => {
      otpDelivery.sendOtp.mockRejectedValueOnce(new Error('Authentication Error'));

      await expect(service.requestOtp('670000000')).rejects.toThrow(UnauthorizedException);

      const updateArgs = prisma.otpLog.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe(OtpStatus.FAILED);
      expect(updateArgs.data.failedReason).toBe('Authentication Error');
    });

    it('acquires a per-phone in-flight lock keyed by canonical phone with 30s TTL', async () => {
      await service.requestOtp('670000000');
      expect(redis.setNX).toHaveBeenCalledWith(
        'otp:inflight:+237670000000',
        expect.any(String),
        30,
      );
    });

    it('short-circuits a duplicate concurrent send and does NOT bill Twilio or insert an OtpLog row', async () => {
      // Simulate the second of two near-simultaneous requests: the first one
      // grabbed the lock; setNX returns false here.
      redis.setNX.mockResolvedValueOnce(false);

      const result = await service.requestOtp('670000000');

      // No DB write, no Twilio send — that's the whole point of the lock.
      expect(prisma.otpLog.create).not.toHaveBeenCalled();
      expect(otpDelivery.sendOtp).not.toHaveBeenCalled();
      // Caller still sees a success-shape response. The original code is
      // already valid for ~5 minutes; we don't want to surface a 429-style
      // error for what's almost always a double-tap.
      expect(result).toEqual({ ok: true, expiresInSeconds: OTP_TTL_MINUTES_SECONDS });
    });

    it('releases the lock when delivery fails so a legitimate retry is not blocked', async () => {
      otpDelivery.sendOtp.mockRejectedValueOnce(new Error('Twilio 500'));

      await expect(service.requestOtp('670000000')).rejects.toThrow(UnauthorizedException);

      // Lock released on failure path — otherwise a Twilio blip would
      // strand the user for 30s with no code delivered.
      expect(redis.del).toHaveBeenCalledWith('otp:inflight:+237670000000');
    });

    it('does NOT release the lock on the happy path', async () => {
      await service.requestOtp('670000000');
      // The lock naturally expires after 30s — keeping it held during the
      // window is what blocks double-taps.
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('verifyOtp + in-flight lock interaction', () => {
    it('releases the in-flight lock on successful verify so a fresh sign-in is not blocked', async () => {
      // Set up a happy-path verify: matching SENT row, code argon2-matches.
      const realHash = await argon2.hash('123456');
      prisma.otpLog.findFirst.mockResolvedValueOnce({
        id: 'log-1',
        phone: '+237670000000',
        codeHash: realHash,
        attempts: 0,
        status: OtpStatus.SENT,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await service.verifyOtp('670000000', '123456', TEST_META);

      // The whole point of releasing here: a user who verifies, logs out,
      // then tries to sign in again within 30s would otherwise be stuck
      // because the second request-otp would short-circuit but the old code
      // is already VERIFIED (no longer eligible for re-verify).
      expect(redis.del).toHaveBeenCalledWith('otp:inflight:+237670000000');
    });
  });

  // Top-level const so the assertion above reads cleanly. Mirrors the
  // OTP_TTL_MINUTES constant in auth.service.ts (5 minutes = 300 seconds).
  const OTP_TTL_MINUTES_SECONDS = 5 * 60;

  describe('verifyOtp', () => {
    it('looks up the OtpLog using the canonical phone form', async () => {
      prisma.otpLog.findFirst.mockResolvedValue(null);

      await expect(service.verifyOtp('670000000', '123456', TEST_META)).rejects.toThrow(
        UnauthorizedException,
      );

      const where = prisma.otpLog.findFirst.mock.calls[0][0].where;
      expect(where.phone).toBe('+237670000000');
    });

    it('accepts rows in SENT state (post-send, pre-webhook reconciliation)', async () => {
      // Real-world race: user receives WhatsApp + types code before Twilio's
      // delivery callback fires. Row is still SENT in DB. Verify must work.
      const code = '123456';
      const codeHash = await argon2.hash(code);
      prisma.otpLog.findFirst.mockResolvedValue({
        id: 'log-1',
        codeHash,
        attempts: 0,
        status: OtpStatus.SENT,
      });

      const result = await service.verifyOtp('+237670000000', code, TEST_META);

      expect(result).toMatchObject({
        accessToken: 'access-jwt',
        refreshToken: 'refresh-jwt',
        deviceId: 'dev-1',
      });
      const statusFilter = prisma.otpLog.findFirst.mock.calls[0][0].where.status;
      expect(statusFilter.in).toEqual(
        expect.arrayContaining([OtpStatus.PENDING, OtpStatus.SENT, OtpStatus.DELIVERED]),
      );
    });

    it('persists a RefreshToken row on successful verify (Story 1.2)', async () => {
      const code = '123456';
      prisma.otpLog.findFirst.mockResolvedValue({
        id: 'log-1',
        codeHash: await argon2.hash(code),
        attempts: 0,
        status: OtpStatus.SENT,
      });

      await service.verifyOtp('+237670000000', code, TEST_META);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
      const created = prisma.refreshToken.create.mock.calls[0][0].data;
      expect(created.userId).toBe('user-1');
      expect(typeof created.tokenHash).toBe('string');
      // argon2 hashes always start with $argon2 — guards against a SHA fallback creeping in.
      expect(created.tokenHash).toMatch(/^\$argon2/);
      expect(created.expiresAt).toBeInstanceOf(Date);
      // No replacesTokenId on the initial signup → no update on rotation chain.
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });
  });

  describe('refresh (Story 1.2)', () => {
    const userId = 'user-1';
    const incomingToken = 'incoming-refresh-jwt';

    async function row(overrides: Record<string, unknown> = {}) {
      return {
        id: 'rt-existing',
        userId,
        tokenHash: await argon2.hash(incomingToken),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null as Date | null,
        replacedBy: null as string | null,
        createdAt: new Date(),
        ...overrides,
      };
    }

    it('rotates: revokes old, inserts new, returns new pair', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        isActive: true,
        isDeleted: false,
      });
      prisma.refreshToken.findMany.mockResolvedValue([await row()]);

      const result = await service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META);

      expect(result).toMatchObject({
        accessToken: 'access-jwt',
        refreshToken: 'refresh-jwt',
        deviceId: 'dev-1',
      });
      // Old token marked revoked + linked to the replacement.
      expect(prisma.refreshToken.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rt-existing' },
          data: expect.objectContaining({ revokedAt: expect.any(Date), replacedBy: 'rt-new' }),
        }),
      );
    });

    // ─── Phase D2 — device-fingerprint mismatch auto-revoke ─────────
    it('Phase D2: refresh with a different chopnow_did revokes the family + fires the alert', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        isActive: true,
        isDeleted: false,
      });
      // The matching row was minted for device 'dev-original' (chopnow_did
      // cookie value at sign-in time).
      prisma.refreshToken.findMany.mockResolvedValue([await row({ deviceId: 'dev-original' })]);
      const devicesMock = (
        service as unknown as { devices: { sendDeviceMismatchAlert: jest.Mock } }
      ).devices;

      const incomingMeta = {
        deviceCookie: 'dev-attacker',
        ipAddress: '203.0.113.55',
        userAgent: 'curl/8.0',
      };

      await expect(
        service.refresh(userId, UserRole.CONSUMER, incomingToken, incomingMeta),
      ).rejects.toMatchObject({
        response: { code: 'refresh_device_mismatch' },
      });

      // Family wiped + alert email fired (fire-and-forget — synchronous
      // for the test because it's a Promise.resolve mock).
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(devicesMock.sendDeviceMismatchAlert).toHaveBeenCalledWith(userId, {
        ipAddress: '203.0.113.55',
        userAgent: 'curl/8.0',
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('Phase D2: pre-C1 row (deviceId=null) is exempt — rotation proceeds normally', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        isActive: true,
        isDeleted: false,
      });
      prisma.refreshToken.findMany.mockResolvedValue([await row({ deviceId: null })]);

      const incomingMeta = {
        deviceCookie: 'dev-whatever',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      };

      const result = await service.refresh(userId, UserRole.CONSUMER, incomingToken, incomingMeta);
      // No mismatch error — rotation succeeded.
      expect(result).toMatchObject({ accessToken: 'access-jwt' });
    });

    it('Phase D2: missing chopnow_did cookie is exempt — rotation proceeds normally', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        isActive: true,
        isDeleted: false,
      });
      prisma.refreshToken.findMany.mockResolvedValue([await row({ deviceId: 'dev-original' })]);

      const incomingMeta = {
        deviceCookie: null, // user cleared cookies but the refresh JWT survived
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      };

      const result = await service.refresh(userId, UserRole.CONSUMER, incomingToken, incomingMeta);
      // Rotation succeeded — the next response re-mints chopnow_did so
      // the protection is back in place for subsequent refreshes.
      expect(result).toMatchObject({ accessToken: 'access-jwt' });
    });

    it('reuse detection: replayed revoked token revokes the entire family', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        isActive: true,
        isDeleted: false,
      });
      // The presented token matches a row that's ALREADY been revoked.
      prisma.refreshToken.findMany.mockResolvedValue([
        await row({ revokedAt: new Date(Date.now() - 10_000) }),
      ]);

      await expect(
        service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META),
      ).rejects.toMatchObject({
        response: { code: 'refresh_reuse_detected' },
      });

      // Family wipe.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // No new pair issued.
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects with user_suspended when user.isActive=false (AC#5)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        isActive: false,
        isDeleted: false,
      });

      await expect(
        service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META),
      ).rejects.toMatchObject({
        response: { code: 'user_suspended' },
      });

      // All active tokens wiped even though we don't look at the candidates.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId, revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // Never reaches the rotation path.
      expect(prisma.refreshToken.findMany).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects with user_suspended when the user record is missing entirely', async () => {
      // JWT-signed user that has since been hard-deleted from the DB.
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META),
      ).rejects.toMatchObject({
        response: { code: 'user_suspended' },
      });
    });

    it('rejects with user_suspended when user.isDeleted=true', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        isActive: true,
        isDeleted: true,
      });

      await expect(
        service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META),
      ).rejects.toMatchObject({
        response: { code: 'user_suspended' },
      });
    });

    it('rejects with refresh_invalid_or_expired when no unexpired row matches', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        isActive: true,
        isDeleted: false,
      });
      // Either the DB is empty or every row's hash mismatches.
      prisma.refreshToken.findMany.mockResolvedValue([]);

      await expect(
        service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META),
      ).rejects.toMatchObject({
        response: { code: 'refresh_invalid_or_expired' },
      });

      // No revoke side-effects — we don't know which family to touch.
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('loads candidates INCLUDING revoked ones (so reuse detection works)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: userId,
        isActive: true,
        isDeleted: false,
      });
      prisma.refreshToken.findMany.mockResolvedValue([await row()]);

      await service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META);

      const where = prisma.refreshToken.findMany.mock.calls[0][0].where;
      // The presence of `revokedAt: null` in this filter would silently
      // break reuse detection by hiding already-rotated rows.
      expect(where).not.toHaveProperty('revokedAt');
      expect(where.userId).toBe(userId);
      expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
    });

    describe('in-flight lock (#175 — sub-second concurrent rotation race)', () => {
      it('acquires a Redis lock keyed on a SHA-256 fingerprint of the raw token (NOT the raw token)', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: userId,
          isActive: true,
          isDeleted: false,
        });
        prisma.refreshToken.findMany.mockResolvedValue([await row()]);

        await service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META);

        expect(redis.setNX).toHaveBeenCalledWith(
          expect.stringMatching(/^refresh:inflight:[a-f0-9]{32}$/),
          '1',
          5,
        );
        // Sanity: the raw token must NEVER appear in Redis keys (log/ops
        // surface). Hash-only.
        const calls = redis.setNX.mock.calls.map((c) => c[0] as string);
        for (const key of calls) {
          expect(key).not.toContain(incomingToken);
        }
      });

      it('losing the race throws refresh_in_flight (NOT refresh_reuse_detected) and DOES NOT revoke the family', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: userId,
          isActive: true,
          isDeleted: false,
        });
        // Simulate the winning concurrent request already holding the lock.
        redis.setNX.mockResolvedValueOnce(false);

        await expect(
          service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META),
        ).rejects.toMatchObject({ response: { code: 'refresh_in_flight' } });

        // Critical: no DB side-effects. The whole point of the lock is to
        // skip the candidates query (which is what would trip the false
        // reuse-detected branch) and to skip the family-revoke write.
        expect(prisma.refreshToken.findMany).not.toHaveBeenCalled();
        expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });

      it('releases the lock on success so a subsequent legitimate rotation can proceed', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: userId,
          isActive: true,
          isDeleted: false,
        });
        prisma.refreshToken.findMany.mockResolvedValue([await row()]);

        await service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META);

        expect(redis.del).toHaveBeenCalledWith(
          expect.stringMatching(/^refresh:inflight:[a-f0-9]{32}$/),
        );
      });

      it('releases the lock on actual reuse-detection (so a follow-up replay still trips the family wipe legitimately)', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: userId,
          isActive: true,
          isDeleted: false,
        });
        prisma.refreshToken.findMany.mockResolvedValue([
          await row({ revokedAt: new Date(Date.now() - 60_000) }), // genuinely-old revoke
        ]);

        await expect(
          service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META),
        ).rejects.toMatchObject({ response: { code: 'refresh_reuse_detected' } });

        expect(redis.del).toHaveBeenCalled();
      });

      it('does NOT acquire a lock when the user is suspended (rejected before reaching the rotation path)', async () => {
        prisma.user.findUnique.mockResolvedValue({
          id: userId,
          isActive: false,
          isDeleted: false,
        });

        await expect(
          service.refresh(userId, UserRole.CONSUMER, incomingToken, TEST_META),
        ).rejects.toMatchObject({ response: { code: 'user_suspended' } });

        // No lock work when we never reach the rotation path.
        expect(redis.setNX).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
      });
    });
  });
});
