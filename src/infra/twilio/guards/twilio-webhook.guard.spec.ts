import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks';
import { TwilioWebhookGuard } from './twilio-webhook.guard';

const AUTH_TOKEN = 'test-twilio-auth-token-1234567890';
const APP_URL = 'https://api-staging.tchopnow.app';

const logger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  setContext: jest.fn(),
};

function makeCtx(opts: {
  originalUrl: string;
  body?: Record<string, string>;
  signature?: string;
  ip?: string;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        originalUrl: opts.originalUrl,
        body: opts.body ?? {},
        ip: opts.ip ?? '5.6.7.8',
        header: (name: string) =>
          name.toLowerCase() === 'x-twilio-signature' ? opts.signature : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

function envFor(nodeEnv: 'production' | 'development' | 'test', authToken: string | undefined) {
  return {
    nodeEnv,
    appUrl: APP_URL,
    twilio: { authToken },
  } as never;
}

describe('TwilioWebhookGuard', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes a real request signed with the same auth token', () => {
    const originalUrl = '/api/webhooks/twilio/voice/bridge?orderId=abc-123&to=rider';
    const url = `${APP_URL}${originalUrl}`;
    const body = { CallSid: 'CA-1', From: '+1234567890' };
    // Twilio's lib exposes the same signer it uses for validation.
    const signature = getExpectedTwilioSignature(AUTH_TOKEN, url, body);
    const guard = new TwilioWebhookGuard(logger as never, envFor('production', AUTH_TOKEN));

    expect(guard.canActivate(makeCtx({ originalUrl, body, signature }))).toBe(true);
  });

  it('rejects when X-Twilio-Signature header is missing in production', () => {
    const guard = new TwilioWebhookGuard(logger as never, envFor('production', AUTH_TOKEN));
    expect(() =>
      guard.canActivate(makeCtx({ originalUrl: '/api/twilio/status', body: {} })),
    ).toThrow(ForbiddenException);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'twilio_webhook_missing_signature' }),
      expect.any(String),
    );
  });

  it('rejects when the signature was computed with a different secret', () => {
    const originalUrl = '/api/webhooks/twilio/voice/bridge?orderId=x&to=consumer';
    const url = `${APP_URL}${originalUrl}`;
    const signature = getExpectedTwilioSignature('different-secret-xxxxxxxxxx', url, {});
    const guard = new TwilioWebhookGuard(logger as never, envFor('production', AUTH_TOKEN));

    expect(() => guard.canActivate(makeCtx({ originalUrl, signature }))).toThrow(
      ForbiddenException,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'twilio_webhook_bad_signature' }),
      expect.any(String),
    );
  });

  it('rejects when the signature was computed over a different URL (path tampering)', () => {
    const originalUrl = '/api/webhooks/twilio/voice/bridge?orderId=victim&to=rider';
    const otherUrl = `${APP_URL}/api/webhooks/twilio/voice/bridge?orderId=ATTACKER&to=rider`;
    const signature = getExpectedTwilioSignature(AUTH_TOKEN, otherUrl, {});
    const guard = new TwilioWebhookGuard(logger as never, envFor('production', AUTH_TOKEN));

    expect(() => guard.canActivate(makeCtx({ originalUrl, signature }))).toThrow(
      ForbiddenException,
    );
  });

  it('skips verification entirely when nodeEnv === "development"', () => {
    const guard = new TwilioWebhookGuard(logger as never, envFor('development', AUTH_TOKEN));
    // No signature header — would fail in production, passes in dev.
    expect(guard.canActivate(makeCtx({ originalUrl: '/api/twilio/status' }))).toBe(true);
  });

  it('skips verification entirely when nodeEnv === "test"', () => {
    const guard = new TwilioWebhookGuard(logger as never, envFor('test', AUTH_TOKEN));
    expect(guard.canActivate(makeCtx({ originalUrl: '/api/twilio/status' }))).toBe(true);
  });

  it('rejects when authToken is missing in production (config error)', () => {
    const guard = new TwilioWebhookGuard(logger as never, envFor('production', undefined));
    expect(() =>
      guard.canActivate(makeCtx({ originalUrl: '/api/twilio/status', signature: 'whatever' })),
    ).toThrow(ForbiddenException);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'twilio_webhook_missing_token' }),
      expect.any(String),
    );
  });
});
