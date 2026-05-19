import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { OtpStatus } from '@prisma/client';
import request from 'supertest';
import express from 'express';
// Deep import: the SDK's public surface only exposes `validateRequest`. To
// generate a *valid* signature in tests we need its companion helper, which
// lives in the same internal module. If Twilio reorganises this path on a
// major bump, the test will fail loudly — fix here, no production impact.
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks';
import { TwilioWebhookController } from '../src/infra/twilio/twilio-webhook.controller';
import { pinoLoggerProvider } from '../src/shared/testing/pino-mock';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { EnvService } from '../src/infra/config/env.service';

/**
 * Integration test for the Twilio status callback endpoint (TD-1, TD-4).
 *
 * Real Nest HTTP layer + supertest; Prisma mocked at the provider boundary
 * (no Docker required, runs in CI). Covers:
 *   - happy path delivered → DELIVERED + deliveredAt
 *   - failed/undelivered → FAILED + failedReason
 *   - intermediate sent/queued → no DB change
 *   - unknown SID → 204 silent drop
 *   - VERIFIED rows are not downgraded
 *   - production signature validation (TD-4)
 *
 * The matching unit specs in src/ cover individual service logic; this file
 * specifically defends the HTTP contract Twilio depends on.
 */
describe('POST /twilio/status (integration)', () => {
  let app: INestApplication;
  let prisma: { otpLog: { findUnique: jest.Mock; update: jest.Mock } };

  // Build a fresh app per test so we can flip nodeEnv between dev and prod
  // without TestingModule caching getting in the way.
  async function buildApp(env: Partial<EnvService>): Promise<INestApplication> {
    prisma = {
      otpLog: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [TwilioWebhookController],
      providers: [
        pinoLoggerProvider(TwilioWebhookController.name),
        { provide: PrismaService, useValue: prisma },
        {
          provide: EnvService,
          useValue: {
            nodeEnv: 'development',
            twilio: {},
            ...env,
          },
        },
      ],
    }).compile();

    const built = moduleRef.createNestApplication();
    // Twilio POSTs application/x-www-form-urlencoded — replicate main.ts wiring.
    built.use(express.urlencoded({ extended: true, limit: '1mb' }));
    await built.init();
    return built;
  }

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('dev mode (signature check skipped)', () => {
    beforeEach(async () => {
      app = await buildApp({ nodeEnv: 'development' });
    });

    it('upgrades a SENT row to DELIVERED on MessageStatus=delivered', async () => {
      prisma.otpLog.findUnique.mockResolvedValue({
        id: 'log-1',
        status: OtpStatus.SENT,
        providerMessageId: 'SMxxx',
      });

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({ MessageSid: 'SMxxx', MessageStatus: 'delivered' })
        .expect(204);

      expect(prisma.otpLog.findUnique).toHaveBeenCalledWith({
        where: { providerMessageId: 'SMxxx' },
      });
      const upd = prisma.otpLog.update.mock.calls[0][0];
      expect(upd.where).toEqual({ id: 'log-1' });
      expect(upd.data.status).toBe(OtpStatus.DELIVERED);
      expect(upd.data.deliveredAt).toBeInstanceOf(Date);
    });

    it('treats MessageStatus=read like delivered (WhatsApp blue ticks)', async () => {
      prisma.otpLog.findUnique.mockResolvedValue({
        id: 'log-1',
        status: OtpStatus.SENT,
      });

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({ MessageSid: 'SMxxx', MessageStatus: 'read' })
        .expect(204);

      expect(prisma.otpLog.update.mock.calls[0][0].data.status).toBe(OtpStatus.DELIVERED);
    });

    it('marks FAILED with the explicit ErrorMessage when present', async () => {
      prisma.otpLog.findUnique.mockResolvedValue({
        id: 'log-1',
        status: OtpStatus.SENT,
      });

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({
          MessageSid: 'SMxxx',
          MessageStatus: 'failed',
          ErrorCode: '63015',
          ErrorMessage: 'Channel could not deliver',
        })
        .expect(204);

      const upd = prisma.otpLog.update.mock.calls[0][0];
      expect(upd.data.status).toBe(OtpStatus.FAILED);
      expect(upd.data.failedReason).toBe('Channel could not deliver');
    });

    it('falls back to twilio_error_<code> when ErrorMessage is missing', async () => {
      prisma.otpLog.findUnique.mockResolvedValue({
        id: 'log-1',
        status: OtpStatus.SENT,
      });

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({ MessageSid: 'SMxxx', MessageStatus: 'undelivered', ErrorCode: '30008' })
        .expect(204);

      expect(prisma.otpLog.update.mock.calls[0][0].data.failedReason).toBe('twilio_error_30008');
    });

    it('does nothing on intermediate statuses like queued/sent', async () => {
      prisma.otpLog.findUnique.mockResolvedValue({
        id: 'log-1',
        status: OtpStatus.SENT,
      });

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({ MessageSid: 'SMxxx', MessageStatus: 'queued' })
        .expect(204);

      expect(prisma.otpLog.update).not.toHaveBeenCalled();
    });

    it('returns 204 and skips DB write when the SID is unknown', async () => {
      prisma.otpLog.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({ MessageSid: 'SM-not-ours', MessageStatus: 'delivered' })
        .expect(204);

      expect(prisma.otpLog.update).not.toHaveBeenCalled();
    });

    it('does not downgrade a row that is already VERIFIED', async () => {
      // Race: user typed the OTP and verifyOtp won, then Twilio's
      // late status callback arrives claiming "delivered" or "failed".
      // The webhook must not flip the row away from VERIFIED.
      prisma.otpLog.findUnique.mockResolvedValue({
        id: 'log-1',
        status: OtpStatus.VERIFIED,
      });

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({ MessageSid: 'SMxxx', MessageStatus: 'failed', ErrorCode: '63015' })
        .expect(204);

      expect(prisma.otpLog.update).not.toHaveBeenCalled();
    });

    it('does not re-write a row that is already FAILED (idempotent terminal state)', async () => {
      // Twilio sometimes retries status callbacks. If a row is already FAILED,
      // a second 'delivered' callback (theoretically impossible but seen in the
      // wild during sandbox flakiness) must not flip it back.
      prisma.otpLog.findUnique.mockResolvedValue({
        id: 'log-1',
        status: OtpStatus.FAILED,
      });

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({ MessageSid: 'SMxxx', MessageStatus: 'delivered' })
        .expect(204);

      expect(prisma.otpLog.update).not.toHaveBeenCalled();
    });

    it('returns 204 and ignores payloads missing MessageSid or MessageStatus', async () => {
      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({ MessageStatus: 'delivered' })
        .expect(204);

      expect(prisma.otpLog.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('production mode (signature enforced — TD-4)', () => {
    const authToken = 'test-twilio-auth-token';
    const callbackUrl = 'https://api.example.com/api/twilio/status';

    beforeEach(async () => {
      app = await buildApp({
        nodeEnv: 'production',
        twilio: {
          authToken,
          statusCallbackUrl: callbackUrl,
        } as EnvService['twilio'],
      });
    });

    it('rejects with 403 when X-Twilio-Signature is missing', async () => {
      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .send({ MessageSid: 'SMxxx', MessageStatus: 'delivered' })
        .expect(403);

      expect(prisma.otpLog.findUnique).not.toHaveBeenCalled();
    });

    it('rejects with 403 when the signature is invalid', async () => {
      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .set('x-twilio-signature', 'definitely-not-a-real-signature')
        .send({ MessageSid: 'SMxxx', MessageStatus: 'delivered' })
        .expect(403);

      expect(prisma.otpLog.findUnique).not.toHaveBeenCalled();
    });

    it('accepts a request signed with the configured auth token', async () => {
      const params = { MessageSid: 'SMxxx', MessageStatus: 'delivered' };
      // Twilio's signature: HMAC-SHA1 of (callbackUrl + sortedKeys.map(k => k+v).join(''))
      // Use the SDK helper itself rather than reimplementing the algorithm.
      const signature = getExpectedTwilioSignature(authToken, callbackUrl, params);

      prisma.otpLog.findUnique.mockResolvedValue({
        id: 'log-1',
        status: OtpStatus.SENT,
      });

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .set('x-twilio-signature', signature)
        .send(params)
        .expect(204);

      expect(prisma.otpLog.update).toHaveBeenCalled();
    });

    it('rejects with 403 when twilio config is incomplete (no authToken)', async () => {
      // Misconfigured prod: nodeEnv=production but no auth token. Failing closed.
      await app.close();
      app = await buildApp({
        nodeEnv: 'production',
        twilio: { statusCallbackUrl: callbackUrl } as EnvService['twilio'],
      });

      await request(app.getHttpServer())
        .post('/twilio/status')
        .type('form')
        .set('x-twilio-signature', 'whatever')
        .send({ MessageSid: 'SMxxx', MessageStatus: 'delivered' })
        .expect(403);
    });
  });
});
