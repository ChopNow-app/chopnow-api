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
});
