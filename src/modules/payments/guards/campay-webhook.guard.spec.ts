import { UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { CampayWebhookGuard } from './campay-webhook.guard';

// Test-only secret; the JWT sign() calls below are in fixtures, not production code.
// nosemgrep: javascript.jsonwebtoken.security.jwt-hardcode.hardcoded-jwt-secret
const SECRET = 'guard-test-secret-9876543210';

const logger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  trace: jest.fn(),
  setContext: jest.fn(),
};

function makeCtx(body: unknown, ip = '1.2.3.4'): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ body, ip }) }),
  } as unknown as ExecutionContext;
}

function signValid(claims: object): string {
  // nosemgrep: javascript.jsonwebtoken.security.jwt-hardcode.hardcoded-jwt-secret
  return jwt.sign(claims, SECRET, { algorithm: 'HS256' });
}

describe('CampayWebhookGuard', () => {
  let guard: CampayWebhookGuard;

  beforeEach(() => {
    const env = { campay: { webhookSecret: SECRET } } as never;
    guard = new CampayWebhookGuard(logger as never, env);
    logger.warn.mockClear();
  });

  it('passes a request whose body.signature is a JWT signed with the secret', () => {
    const body = {
      status: 'SUCCESSFUL',
      reference: 'TC-ABCDE',
      signature: signValid({ status: 'SUCCESSFUL', reference: 'TC-ABCDE' }),
    };
    expect(guard.canActivate(makeCtx(body))).toBe(true);
  });

  it('rejects when body.signature is missing', () => {
    expect(() =>
      guard.canActivate(makeCtx({ status: 'SUCCESSFUL', reference: 'TC-ABCDE' })),
    ).toThrow(UnauthorizedException);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'campay_webhook_missing_signature' }),
      expect.any(String),
    );
  });

  it('rejects when body.signature was signed with a different secret', () => {
    // nosemgrep: javascript.jsonwebtoken.security.jwt-hardcode.hardcoded-jwt-secret
    const forged = jwt.sign({ status: 'SUCCESSFUL' }, 'wrong-secret', { algorithm: 'HS256' });
    expect(() => guard.canActivate(makeCtx({ reference: 'TC-X', signature: forged }))).toThrow(
      UnauthorizedException,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'campay_webhook_bad_signature' }),
      expect.any(String),
    );
  });

  it('rejects when body is missing entirely (malformed)', () => {
    expect(() => guard.canActivate(makeCtx(undefined))).toThrow(UnauthorizedException);
  });

  it('rejects when CAMPAY_WEBHOOK_SECRET is not configured (defensive)', () => {
    const envNoSecret = { campay: { webhookSecret: undefined } } as never;
    const g2 = new CampayWebhookGuard(logger as never, envNoSecret);
    const body = { signature: signValid({}) };
    expect(() => g2.canActivate(makeCtx(body))).toThrow(UnauthorizedException);
  });
});
