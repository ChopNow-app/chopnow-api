import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { OtpChannel, OtpStatus, UserRole } from '@prisma/client';
import { startTestPostgres, TestPostgresContext } from './test-postgres';

/**
 * End-to-end auth flow against a real testcontainers PostGIS + the full
 * AppModule (global guards, validation pipe, /api prefix). Only the Twilio
 * delivery layer is overridden — we intercept the plaintext OTP via a spy
 * on `OtpDeliveryService.sendOtp` instead of going through Twilio.
 *
 * Single test today. Future Story 1.x flows append more `it(...)` blocks
 * using unique phone numbers to keep DB state isolated without truncate.
 */
describe('Auth flow (e2e)', () => {
  let app: INestApplication;
  let pgCtx: TestPostgresContext;
  let otpDelivery: { sendOtp: jest.Mock };
  let prismaModule: typeof import('@prisma/client');

  beforeAll(async () => {
    pgCtx = await startTestPostgres();

    // Env must be set before AppModule resolves — Joi validation runs at
    // module import time, and EnvService memoises off process.env.
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    process.env.APP_URL = 'http://localhost:3001';
    process.env.DATABASE_URL = pgCtx.url;
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(64);
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(64);
    process.env.JWT_ACCESS_TTL = '15m';
    process.env.JWT_REFRESH_TTL = '30d';
    // Phase A1 — AES-256-GCM envelope key for admin TOTP secrets at rest.
    // Not exercised by these tests but required by env validation now.
    process.env.APP_SECRET_ENVELOPE_KEY = 'c'.repeat(64);
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    process.env.MAIL_FROM = 'ChopNow <test@local>';
    process.env.THROTTLE_TTL_SECONDS = '60';
    // High enough that test parallelism / retries don't trip the global limiter.
    process.env.THROTTLE_LIMIT = '1000';

    // Lazy-import after env is set so AppModule sees the values.
    const { AppModule } = await import('../src/app.module');
    const { OtpDeliveryService } = await import('../src/infra/twilio/otp-delivery.service');
    prismaModule = await import('@prisma/client');

    // Unique SID per call — otp_logs.providerMessageId is @unique (added in
    // PR #100). A static value made the first test pass but every subsequent
    // request-otp threw Prisma's unique-constraint error.
    let sidCounter = 0;
    otpDelivery = {
      sendOtp: jest.fn().mockImplementation(() =>
        Promise.resolve({
          channel: OtpChannel.WHATSAPP,
          providerMessageId: `SMtest-e2e-${++sidCounter}`,
        }),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(OtpDeliveryService)
      .useValue(otpDelivery)
      .compile();

    app = moduleRef.createNestApplication();

    // Mirror main.ts wiring (helmet skipped — adds latency, no value in test).
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.setGlobalPrefix('api', { exclude: ['health', 'ready', 'metrics'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

    await app.init();
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pgCtx) await pgCtx.stop();
  });

  it('completes the full request-otp → verify-otp → /users/me flow', async () => {
    const phone = '670000001'; // unique-per-test convention
    const canonical = '+237670000001';
    const server = app.getHttpServer();

    // ── Step 1: request OTP ──────────────────────────────────────────
    const requestRes = await request(server)
      .post('/api/v1/auth/request-otp')
      .send({ phone })
      .expect(200);

    expect(requestRes.body).toEqual({ ok: true, expiresInSeconds: 300 });

    // The phone is canonicalised to E.164 *before* being passed to delivery —
    // exercising the normalizePhone util in AuthService end-to-end.
    expect(otpDelivery.sendOtp).toHaveBeenCalledWith(canonical, expect.stringMatching(/^\d{6}$/));
    const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];

    // OtpLog row should exist as SENT (not DELIVERED — that requires the
    // Twilio status webhook, which we don't fire in this test).
    const prisma = new prismaModule.PrismaClient({ datasources: { db: { url: pgCtx.url } } });
    try {
      const sentLog = await prisma.otpLog.findFirst({
        where: { phone: canonical },
        orderBy: { createdAt: 'desc' },
      });
      expect(sentLog).not.toBeNull();
      expect(sentLog!.status).toBe(OtpStatus.SENT);
      expect(sentLog!.providerMessageId).toMatch(/^SMtest-e2e-\d+$/);
      expect(sentLog!.channel).toBe(OtpChannel.WHATSAPP);

      // ── Step 2: verify OTP ─────────────────────────────────────────
      const verifyRes = await request(server)
        .post('/api/v1/auth/verify-otp')
        .send({ phone, code })
        .expect(200);

      expect(verifyRes.body).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });

      const verifiedLog = await prisma.otpLog.findUnique({ where: { id: sentLog!.id } });
      expect(verifiedLog!.status).toBe(OtpStatus.VERIFIED);
      expect(verifiedLog!.verifiedAt).toBeInstanceOf(Date);

      const user = await prisma.user.findUnique({ where: { phone: canonical } });
      expect(user).not.toBeNull();
      expect(user!.role).toBe(UserRole.CONSUMER);

      // ── Step 3: authenticated call to /users/me ────────────────────
      const meRes = await request(server)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
        .expect(200);

      expect(meRes.body).toMatchObject({
        id: user!.id,
        phone: canonical,
        role: UserRole.CONSUMER,
      });

      // Without the Authorization header the same route must reject —
      // proves the global JwtAuthGuard is wired and /users/me is not @Public.
      await request(server).get('/api/v1/users/me').expect(401);
    } finally {
      await prisma.$disconnect();
    }
  });

  // ─── Story 1.2 — refresh token rotation ─────────────────────────────
  it('rotates refresh tokens and detects reuse', async () => {
    const phone = '670000002';
    const canonical = '+237670000002';
    const server = app.getHttpServer();
    const prisma = new prismaModule.PrismaClient({ datasources: { db: { url: pgCtx.url } } });

    try {
      // Sign up.
      await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
      const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
      const verifyRes = await request(server)
        .post('/api/v1/auth/verify-otp')
        .send({ phone, code })
        .expect(200);
      const pairA = verifyRes.body as { accessToken: string; refreshToken: string };

      // verify-otp must have persisted the refresh row.
      const user = await prisma.user.findUnique({ where: { phone: canonical } });
      const initialRows = await prisma.refreshToken.findMany({ where: { userId: user!.id } });
      expect(initialRows).toHaveLength(1);
      expect(initialRows[0].revokedAt).toBeNull();

      // ── Happy path: rotate ─────────────────────────────────────────
      const refreshRes = await request(server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: pairA.refreshToken })
        .expect(200);
      const pairB = refreshRes.body as { accessToken: string; refreshToken: string };

      expect(pairB.accessToken).not.toBe(pairA.accessToken);
      expect(pairB.refreshToken).not.toBe(pairA.refreshToken);

      // DB state: pairA's row revoked + replacedBy set; pairB's row inserted.
      const rowsAfterRefresh = await prisma.refreshToken.findMany({
        where: { userId: user!.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(rowsAfterRefresh).toHaveLength(2);
      expect(rowsAfterRefresh[0].revokedAt).not.toBeNull();
      expect(rowsAfterRefresh[0].replacedBy).toBe(rowsAfterRefresh[1].id);
      expect(rowsAfterRefresh[1].revokedAt).toBeNull();

      // pairB.accessToken authorizes /users/me.
      await request(server)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${pairB.accessToken}`)
        .expect(200);

      // ── Reuse detection: replay pairA → 401 + family revoke ────────
      const reuseRes = await request(server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: pairA.refreshToken })
        .expect(401);
      expect(reuseRes.body.code).toBe('refresh_reuse_detected');

      const familyAfterReuse = await prisma.refreshToken.findMany({
        where: { userId: user!.id, revokedAt: null },
      });
      expect(familyAfterReuse).toHaveLength(0);

      // pairB now also fails — its row was revoked by the family wipe.
      const followupRes = await request(server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: pairB.refreshToken })
        .expect(401);
      // Could be reuse_detected (if it matches a revoked row) — both codes
      // correctly signal "this session is over". Accept either.
      expect(['refresh_invalid_or_expired', 'refresh_reuse_detected']).toContain(
        followupRes.body.code,
      );
    } finally {
      await prisma.$disconnect();
    }
  });

  // ─── Story 1.2 AC#1 — re-verifying same phone reuses the same user row ─
  it('returns the same userId when an existing phone re-verifies', async () => {
    const phone = '670000003';
    const canonical = '+237670000003';
    const server = app.getHttpServer();
    const prisma = new prismaModule.PrismaClient({ datasources: { db: { url: pgCtx.url } } });

    try {
      // First signup.
      await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
      const code1: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
      const verify1 = await request(server)
        .post('/api/v1/auth/verify-otp')
        .send({ phone, code: code1 })
        .expect(200);

      const userAfter1 = await prisma.user.findUnique({ where: { phone: canonical } });
      const userCount1 = await prisma.user.count({ where: { phone: canonical } });
      expect(userCount1).toBe(1);

      // Second flow on the same phone — must reuse the user row.
      await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
      const code2: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
      const verify2 = await request(server)
        .post('/api/v1/auth/verify-otp')
        .send({ phone, code: code2 })
        .expect(200);

      const userCount2 = await prisma.user.count({ where: { phone: canonical } });
      expect(userCount2).toBe(1);

      // The JWT subject should be the same user.id across both verifies.
      const subFromToken = (jwt: string) =>
        JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).sub;
      expect(subFromToken(verify2.body.accessToken)).toBe(userAfter1!.id);
      expect(subFromToken(verify1.body.accessToken)).toBe(userAfter1!.id);

      // Both refresh tokens are valid and present in the DB.
      const tokens = await prisma.refreshToken.findMany({
        where: { userId: userAfter1!.id, revokedAt: null },
      });
      expect(tokens).toHaveLength(2);
    } finally {
      await prisma.$disconnect();
    }
  });

  // ─── Phase B1 — refresh cookie + logout ─────────────────────────────
  describe('Phase B1 — refresh cookie + logout', () => {
    it('verify-otp sets the chopnow_rt HttpOnly cookie alongside the body refresh token', async () => {
      const phone = '670000010';
      const server = app.getHttpServer();
      await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
      const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];

      const verifyRes = await request(server)
        .post('/api/v1/auth/verify-otp')
        .send({ phone, code })
        .expect(200);

      const setCookie = verifyRes.headers['set-cookie'] as unknown as string[] | string;
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const refreshCookie = cookies.find((c) => c.startsWith('chopnow_rt='));
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie!.toLowerCase()).toContain('httponly');
      expect(refreshCookie!.toLowerCase()).toContain('samesite=strict');
      expect(refreshCookie!.toLowerCase()).toContain('path=/api/v1/auth');
      // Cookie value === the body refreshToken (during the cutover both surfaces carry it)
      const cookieValue = decodeURIComponent(refreshCookie!.split(';')[0].split('=')[1]);
      expect(cookieValue).toBe(verifyRes.body.refreshToken);
    });

    it('refresh works with only the cookie — body refreshToken omitted', async () => {
      const phone = '670000011';
      const server = app.getHttpServer();
      await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
      const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];

      const verifyRes = await request(server)
        .post('/api/v1/auth/verify-otp')
        .send({ phone, code })
        .expect(200);

      const setCookie = verifyRes.headers['set-cookie'] as unknown as string[];
      const refreshCookie = setCookie.find((c) => c.startsWith('chopnow_rt='))!;
      const cookieValue = refreshCookie.split(';')[0]; // "chopnow_rt=<token>"

      // Refresh with cookie only — DTO still allows an empty body
      const refreshRes = await request(server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookieValue)
        .send({})
        .expect(200);

      expect(refreshRes.body.accessToken).toBeDefined();
      expect(refreshRes.body.refreshToken).toBeDefined();
      expect(refreshRes.body.refreshToken).not.toBe(verifyRes.body.refreshToken);
      // New cookie issued (rotation)
      const newSetCookie = refreshRes.headers['set-cookie'] as unknown as string[];
      expect(newSetCookie.some((c) => c.startsWith('chopnow_rt='))).toBe(true);
    });

    it('logout revokes the row + clears the cookie + the token cannot be replayed', async () => {
      const phone = '670000012';
      const canonical = '+237670000012';
      const server = app.getHttpServer();
      const prisma = new prismaModule.PrismaClient({ datasources: { db: { url: pgCtx.url } } });

      try {
        await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
        const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
        const verifyRes = await request(server)
          .post('/api/v1/auth/verify-otp')
          .send({ phone, code })
          .expect(200);
        const refreshToken = verifyRes.body.refreshToken as string;

        const user = await prisma.user.findUnique({ where: { phone: canonical } });
        const rowsBefore = await prisma.refreshToken.findMany({
          where: { userId: user!.id, revokedAt: null },
        });
        expect(rowsBefore).toHaveLength(1);

        // Logout — 204 No Content, no body
        const logoutRes = await request(server)
          .post('/api/v1/auth/logout')
          .set('Cookie', `chopnow_rt=${refreshToken}`)
          .expect(204);

        // Clear-Cookie response header
        const setCookie = logoutRes.headers['set-cookie'] as unknown as string[];
        const cleared = setCookie.find((c) => c.startsWith('chopnow_rt='))!;
        // Max-Age=0 or Expires= in the past — either way the browser drops it
        expect(cleared.toLowerCase()).toMatch(/max-age=0|expires=.+1970/);

        // DB row revoked
        const rowsAfter = await prisma.refreshToken.findMany({
          where: { userId: user!.id, revokedAt: null },
        });
        expect(rowsAfter).toHaveLength(0);

        // Refresh with the now-revoked token fails 401
        await request(server).post('/api/v1/auth/refresh').send({ refreshToken }).expect(401);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('logout is idempotent — calling with an unknown/expired token still 204s', async () => {
      const server = app.getHttpServer();
      // No Cookie header, no body — still succeeds, still clears
      await request(server).post('/api/v1/auth/logout').expect(204);
      // Bogus cookie value — also fine
      await request(server)
        .post('/api/v1/auth/logout')
        .set('Cookie', 'chopnow_rt=not.a.valid.jwt')
        .expect(204);
    });
  });

  // ─── Phase C1+C2 — device fingerprint + revoke-all ─────────────────
  describe('Phase C1+C2 — device fingerprint + revoke-all sessions', () => {
    it('verify-otp sets a chopnow_did cookie + creates a Device row linked to the refresh token', async () => {
      const phone = '670000020';
      const canonical = '+237670000020';
      const server = app.getHttpServer();
      const prisma = new prismaModule.PrismaClient({
        datasources: { db: { url: pgCtx.url } },
      });

      try {
        await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
        const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];

        const verifyRes = await request(server)
          .post('/api/v1/auth/verify-otp')
          .set('User-Agent', 'Mozilla/5.0 (iPhone) Safari/604.1')
          .send({ phone, code })
          .expect(200);

        const setCookie = verifyRes.headers['set-cookie'] as unknown as string[];
        const deviceCookie = setCookie.find((c) => c.startsWith('chopnow_did='))!;
        expect(deviceCookie).toBeDefined();
        expect(deviceCookie.toLowerCase()).toContain('httponly');
        expect(deviceCookie.toLowerCase()).toContain('samesite=strict');
        const deviceId = decodeURIComponent(deviceCookie.split(';')[0].split('=')[1]);

        const user = await prisma.user.findUnique({ where: { phone: canonical } });
        const devices = await prisma.device.findMany({ where: { userId: user!.id } });
        expect(devices).toHaveLength(1);
        expect(devices[0].id).toBe(deviceId);
        expect(devices[0].userAgentLabel).toBe('Safari sur iPhone/iPad');

        const tokens = await prisma.refreshToken.findMany({
          where: { userId: user!.id, revokedAt: null },
        });
        expect(tokens).toHaveLength(1);
        expect(tokens[0].deviceId).toBe(deviceId);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('refresh keeps the same Device row when chopnow_did is sent back', async () => {
      const phone = '670000021';
      const canonical = '+237670000021';
      const server = app.getHttpServer();
      const prisma = new prismaModule.PrismaClient({
        datasources: { db: { url: pgCtx.url } },
      });

      try {
        await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
        const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
        const verifyRes = await request(server)
          .post('/api/v1/auth/verify-otp')
          .send({ phone, code })
          .expect(200);

        const setCookie = verifyRes.headers['set-cookie'] as unknown as string[];
        const cookieHeader = setCookie
          .map((c) => c.split(';')[0])
          .filter((c) => c.startsWith('chopnow_rt=') || c.startsWith('chopnow_did='))
          .join('; ');

        await request(server)
          .post('/api/v1/auth/refresh')
          .set('Cookie', cookieHeader)
          .send({})
          .expect(200);

        const user = await prisma.user.findUnique({ where: { phone: canonical } });
        const devices = await prisma.device.findMany({ where: { userId: user!.id } });
        // Same chopnow_did was presented → still exactly one Device row.
        expect(devices).toHaveLength(1);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('POST /auth/sessions/revoke-all kills every active refresh row for the user', async () => {
      const phone = '670000022';
      const canonical = '+237670000022';
      const server = app.getHttpServer();
      const prisma = new prismaModule.PrismaClient({
        datasources: { db: { url: pgCtx.url } },
      });

      try {
        await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
        const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
        const verifyRes = await request(server)
          .post('/api/v1/auth/verify-otp')
          .send({ phone, code })
          .expect(200);
        const accessToken = verifyRes.body.accessToken as string;

        // Open a "second device" by verifying again without the cookie.
        await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
        const code2: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
        await request(server)
          .post('/api/v1/auth/verify-otp')
          .send({ phone, code: code2 })
          .expect(200);

        const user = await prisma.user.findUnique({ where: { phone: canonical } });
        const before = await prisma.refreshToken.count({
          where: { userId: user!.id, revokedAt: null },
        });
        expect(before).toBe(2);

        await request(server)
          .post('/api/v1/auth/sessions/revoke-all')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(204);

        const after = await prisma.refreshToken.count({
          where: { userId: user!.id, revokedAt: null },
        });
        expect(after).toBe(0);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('POST /auth/sessions/revoke-all requires a valid access token', async () => {
      const server = app.getHttpServer();
      await request(server).post('/api/v1/auth/sessions/revoke-all').expect(401);
    });

    // ─── Phase D2 — auto-revoke on chopnow_did mismatch ───────────────
    it('Phase D2: refresh with a different chopnow_did 401s + revokes the family', async () => {
      const phone = '670000023';
      const canonical = '+237670000023';
      const server = app.getHttpServer();
      const prisma = new prismaModule.PrismaClient({
        datasources: { db: { url: pgCtx.url } },
      });

      try {
        // Sign in on "browser A" — get a refresh JWT + chopnow_did cookie.
        await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
        const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
        const verifyRes = await request(server)
          .post('/api/v1/auth/verify-otp')
          .send({ phone, code })
          .expect(200);

        const setCookie = verifyRes.headers['set-cookie'] as unknown as string[];
        const rtCookie = setCookie.find((c) => c.startsWith('chopnow_rt='))!.split(';')[0];
        // Build a "browser B" cookie header: same refresh token (lifted by
        // an attacker) but a fabricated chopnow_did.
        const attackerCookie = `${rtCookie}; chopnow_did=dev-attacker-fake`;

        const refreshRes = await request(server)
          .post('/api/v1/auth/refresh')
          .set('Cookie', attackerCookie)
          .send({})
          .expect(401);
        expect(refreshRes.body.code).toBe('refresh_device_mismatch');

        // Family wiped — no active refresh rows left for this user.
        const user = await prisma.user.findUnique({ where: { phone: canonical } });
        const active = await prisma.refreshToken.count({
          where: { userId: user!.id, revokedAt: null },
        });
        expect(active).toBe(0);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('Phase D2: refresh without chopnow_did still works (exempt when cookie missing)', async () => {
      const phone = '670000024';
      const server = app.getHttpServer();
      await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
      const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
      const verifyRes = await request(server)
        .post('/api/v1/auth/verify-otp')
        .send({ phone, code })
        .expect(200);

      const setCookie = verifyRes.headers['set-cookie'] as unknown as string[];
      const rtCookieOnly = setCookie.find((c) => c.startsWith('chopnow_rt='))!.split(';')[0];

      // Send only chopnow_rt, no chopnow_did → rotation proceeds.
      await request(server)
        .post('/api/v1/auth/refresh')
        .set('Cookie', rtCookieOnly)
        .send({})
        .expect(200);
    });
  });

  // ─── Story 1.2 AC#5 — suspension forces a structured 401 ────────────
  it('blocks refresh with user_suspended when user.isActive=false', async () => {
    const phone = '670000004';
    const canonical = '+237670000004';
    const server = app.getHttpServer();
    const prisma = new prismaModule.PrismaClient({ datasources: { db: { url: pgCtx.url } } });

    try {
      await request(server).post('/api/v1/auth/request-otp').send({ phone }).expect(200);
      const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
      const verifyRes = await request(server)
        .post('/api/v1/auth/verify-otp')
        .send({ phone, code })
        .expect(200);
      const { refreshToken } = verifyRes.body as { refreshToken: string };

      await prisma.user.update({ where: { phone: canonical }, data: { isActive: false } });

      const refreshRes = await request(server)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(401);
      expect(refreshRes.body.code).toBe('user_suspended');

      const user = await prisma.user.findUnique({ where: { phone: canonical } });
      const active = await prisma.refreshToken.count({
        where: { userId: user!.id, revokedAt: null },
      });
      expect(active).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  // ─── Phase O5 — deep readiness probe ──────────────────────────────
  describe('Phase O5 — /ready deep probe', () => {
    it('reports db + redis + campay state when all healthy', async () => {
      const server = app.getHttpServer();
      const res = await request(server).get('/ready').expect(200);

      expect(res.body).toMatchObject({
        status: 'ready',
        db: 'up',
        redis: 'up',
        // Campay breaker is CLOSED at boot since no calls have failed.
        campay: 'CLOSED',
      });
    });

    it('liveness /health stays minimal (no external deps probed)', async () => {
      const server = app.getHttpServer();
      const res = await request(server).get('/health').expect(200);

      expect(res.body).toMatchObject({
        status: 'ok',
        uptime: expect.any(Number),
      });
      // Confirm we didn't accidentally add db/redis/campay to /health —
      // those belong on /ready.
      expect(res.body.db).toBeUndefined();
      expect(res.body.redis).toBeUndefined();
    });
  });

  // ─── Phase O2 — Prometheus /metrics endpoint smoke ─────────────────
  describe('Phase O2 — /metrics endpoint', () => {
    it('serves Prometheus text format without auth + includes the HTTP histogram', async () => {
      const server = app.getHttpServer();

      // Public route — no Authorization header. Should not 401.
      const res = await request(server).get('/metrics').expect(200);

      // Prometheus text format: lines like `# HELP ...`, `# TYPE ...`,
      // then `metric_name{labels} value timestamp?`.
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('# HELP http_request_duration_seconds');
      expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
      // Default Node.js process metrics from prom-client.
      expect(res.text).toContain('process_cpu_user_seconds_total');
      expect(res.text).toContain('nodejs_heap_size_total_bytes');

      // The interceptor has observed at least one request by now (all
      // the earlier e2e specs went through it).
      expect(res.text).toMatch(/http_request_duration_seconds_count\{[^}]+\}\s+\d+/);
    });
  });
});
