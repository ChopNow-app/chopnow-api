import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { TurnstileGuard } from './turnstile.guard';

const logger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  setContext: jest.fn(),
};

function makeCtx(body: Record<string, unknown> = {}, ip = '5.6.7.8'): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ body, ip, path: '/api/v1/auth/request-otp' }),
    }),
  } as unknown as ExecutionContext;
}

function envFor(opts: { enabled: boolean; secret?: string }) {
  return {
    captcha: {
      enabled: opts.enabled,
      turnstileSecret: opts.secret,
    },
  } as never;
}

describe('TurnstileGuard', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  // ------------------------------------------------------------------
  // Inert-by-default — the cheapest and most important property
  // ------------------------------------------------------------------

  it('returns true immediately when CAPTCHA_ENABLED is false', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const guard = new TurnstileGuard(envFor({ enabled: false }), logger as never);
    await expect(guard.canActivate(makeCtx({}))).resolves.toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns true when enabled but secret is missing (mis-config fails open to avoid bricking auth)', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const guard = new TurnstileGuard(envFor({ enabled: true, secret: undefined }), logger as never);
    await expect(guard.canActivate(makeCtx({ cfTurnstileResponse: 'tok' }))).resolves.toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Active path
  // ------------------------------------------------------------------

  it('throws 403 when token is missing', async () => {
    const guard = new TurnstileGuard(
      envFor({ enabled: true, secret: 'srv-secret' }),
      logger as never,
    );

    await expect(guard.canActivate(makeCtx({}))).rejects.toBeInstanceOf(ForbiddenException);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'captcha_missing_token' }),
      expect.any(String),
    );
  });

  it('passes when siteverify returns success', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const guard = new TurnstileGuard(
      envFor({ enabled: true, secret: 'srv-secret' }),
      logger as never,
    );

    await expect(guard.canActivate(makeCtx({ cfTurnstileResponse: 'tok-123' }))).resolves.toBe(
      true,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );

    // body includes secret + token + remoteip
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.body).toContain('secret=srv-secret');
    expect(init.body).toContain('response=tok-123');
    expect(init.body).toContain('remoteip=5.6.7.8');
  });

  it('accepts the hyphenated cf-turnstile-response key as well as camelCase', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const guard = new TurnstileGuard(
      envFor({ enabled: true, secret: 'srv-secret' }),
      logger as never,
    );

    await expect(
      guard.canActivate(makeCtx({ 'cf-turnstile-response': 'tok-from-form' })),
    ).resolves.toBe(true);

    expect(fetchSpy.mock.calls[0][1].body).toContain('response=tok-from-form');
  });

  it('throws 403 with structured warn when siteverify rejects the token', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const guard = new TurnstileGuard(
      envFor({ enabled: true, secret: 'srv-secret' }),
      logger as never,
    );

    await expect(
      guard.canActivate(makeCtx({ cfTurnstileResponse: 'tok-bad' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'captcha_verify_failed',
        errorCodes: ['invalid-input-response'],
      }),
      expect.any(String),
    );
  });

  it('fails closed (throws 403) when siteverify returns 5xx', async () => {
    const fetchSpy = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const guard = new TurnstileGuard(
      envFor({ enabled: true, secret: 'srv-secret' }),
      logger as never,
    );

    await expect(guard.canActivate(makeCtx({ cfTurnstileResponse: 'tok' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'captcha_verify_failed',
        errorCodes: ['siteverify-http-502'],
      }),
      expect.any(String),
    );
  });

  it('fails closed (throws 403) on network error', async () => {
    const fetchSpy = jest.fn().mockRejectedValue(new Error('connect ETIMEDOUT'));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const guard = new TurnstileGuard(
      envFor({ enabled: true, secret: 'srv-secret' }),
      logger as never,
    );

    await expect(guard.canActivate(makeCtx({ cfTurnstileResponse: 'tok' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'captcha_siteverify_error' }),
      expect.any(String),
    );
  });
});
