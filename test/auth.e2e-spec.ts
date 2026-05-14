import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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
    process.env.JWT_ACCESS_TTL = '24h';
    process.env.JWT_REFRESH_TTL = '30d';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    process.env.MAIL_FROM = 'ChopNow <test@local>';
    process.env.THROTTLE_TTL_SECONDS = '60';
    // High enough that test parallelism / retries don't trip the global limiter.
    process.env.THROTTLE_LIMIT = '1000';

    // Lazy-import after env is set so AppModule sees the values.
    const { AppModule } = await import('../src/app.module');
    const { OtpDeliveryService } = await import('../src/infra/twilio/otp-delivery.service');
    prismaModule = await import('@prisma/client');

    otpDelivery = {
      sendOtp: jest
        .fn()
        .mockResolvedValue({ channel: OtpChannel.WHATSAPP, providerMessageId: 'SMtest-e2e' }),
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
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });

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
      .post('/api/auth/request-otp')
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
      expect(sentLog!.providerMessageId).toBe('SMtest-e2e');
      expect(sentLog!.channel).toBe(OtpChannel.WHATSAPP);

      // ── Step 2: verify OTP ─────────────────────────────────────────
      const verifyRes = await request(server)
        .post('/api/auth/verify-otp')
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
        .get('/api/users/me')
        .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
        .expect(200);

      expect(meRes.body).toMatchObject({
        id: user!.id,
        phone: canonical,
        role: UserRole.CONSUMER,
      });

      // Without the Authorization header the same route must reject —
      // proves the global JwtAuthGuard is wired and /users/me is not @Public.
      await request(server).get('/api/users/me').expect(401);
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
      await request(server).post('/api/auth/request-otp').send({ phone }).expect(200);
      const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
      const verifyRes = await request(server)
        .post('/api/auth/verify-otp')
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
        .post('/api/auth/refresh')
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
        .get('/api/users/me')
        .set('Authorization', `Bearer ${pairB.accessToken}`)
        .expect(200);

      // ── Reuse detection: replay pairA → 401 + family revoke ────────
      const reuseRes = await request(server)
        .post('/api/auth/refresh')
        .send({ refreshToken: pairA.refreshToken })
        .expect(401);
      expect(reuseRes.body.code).toBe('refresh_reuse_detected');

      const familyAfterReuse = await prisma.refreshToken.findMany({
        where: { userId: user!.id, revokedAt: null },
      });
      expect(familyAfterReuse).toHaveLength(0);

      // pairB now also fails — its row was revoked by the family wipe.
      const followupRes = await request(server)
        .post('/api/auth/refresh')
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
      await request(server).post('/api/auth/request-otp').send({ phone }).expect(200);
      const code1: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
      const verify1 = await request(server)
        .post('/api/auth/verify-otp')
        .send({ phone, code: code1 })
        .expect(200);

      const userAfter1 = await prisma.user.findUnique({ where: { phone: canonical } });
      const userCount1 = await prisma.user.count({ where: { phone: canonical } });
      expect(userCount1).toBe(1);

      // Second flow on the same phone — must reuse the user row.
      await request(server).post('/api/auth/request-otp').send({ phone }).expect(200);
      const code2: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
      const verify2 = await request(server)
        .post('/api/auth/verify-otp')
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

  // ─── Story 1.2 AC#5 — suspension forces a structured 401 ────────────
  it('blocks refresh with user_suspended when user.isActive=false', async () => {
    const phone = '670000004';
    const canonical = '+237670000004';
    const server = app.getHttpServer();
    const prisma = new prismaModule.PrismaClient({ datasources: { db: { url: pgCtx.url } } });

    try {
      await request(server).post('/api/auth/request-otp').send({ phone }).expect(200);
      const code: string = otpDelivery.sendOtp.mock.calls.at(-1)![1];
      const verifyRes = await request(server)
        .post('/api/auth/verify-otp')
        .send({ phone, code })
        .expect(200);
      const { refreshToken } = verifyRes.body as { refreshToken: string };

      await prisma.user.update({ where: { phone: canonical }, data: { isActive: false } });

      const refreshRes = await request(server)
        .post('/api/auth/refresh')
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
});
