import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Request } from 'express';
import { EnvService } from '../../infra/config/env.service';

/**
 * Cloudflare Turnstile bot-protection guard.
 *
 * Inert by default — when `CAPTCHA_ENABLED=false` (or `TURNSTILE_SECRET_KEY`
 * is empty), this guard returns `true` immediately and adds ~one nanosecond
 * of overhead. Same pattern as the inert Sentry / Loki / Metrics integrations
 * already in the codebase: ship pre-wired, flip the env flag if a signal
 * appears (SIM-farm on /auth/request-otp, unverified-OTP rate climbs, etc.).
 *
 * When enabled:
 *   1. Reads `cf-turnstile-response` from the request body
 *   2. POSTs it to https://challenges.cloudflare.com/turnstile/v0/siteverify
 *      with `secret` + `remoteip`
 *   3. Throws 403 ForbiddenException on missing / failed token
 *   4. Logs each rejection with the Cloudflare error-codes for triage
 *
 * Pair with the existing @PhoneRateLimit guard by ordering this one FIRST —
 * captcha gates the rate-limit budget so a bot can't burn the phone's
 * 5/15min budget without solving the challenge.
 *
 * Tokens are single-use and expire 5 min after issue (Cloudflare-enforced).
 */
@Injectable()
export class TurnstileGuard implements CanActivate {
  private readonly SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

  constructor(
    private readonly env: EnvService,
    @InjectPinoLogger(TurnstileGuard.name) private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { enabled, turnstileSecret } = this.env.captcha;
    if (!enabled || !turnstileSecret) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(req);

    if (!token) {
      this.logger.warn(
        { event: 'captcha_missing_token', ip: req.ip, path: req.path },
        'turnstile token missing',
      );
      throw new ForbiddenException('captcha_required');
    }

    const result = await this.verify(token, req.ip);
    if (!result.success) {
      this.logger.warn(
        {
          event: 'captcha_verify_failed',
          ip: req.ip,
          path: req.path,
          errorCodes: result['error-codes'],
        },
        'turnstile reject',
      );
      throw new ForbiddenException('captcha_failed');
    }

    return true;
  }

  private extractToken(req: Request): string | undefined {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Accept both the camelCase form used by our JSON DTOs and the
    // hyphenated form Cloudflare's widget uses on classic HTML forms
    // (for any caller that posts form-encoded data).
    const raw = body.cfTurnstileResponse ?? body['cf-turnstile-response'];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  }

  /**
   * Calls Cloudflare's siteverify endpoint. Network failures (timeout,
   * DNS, 5xx from Cloudflare) are treated as verification failures —
   * fail-closed rather than fail-open, because the whole point of the
   * guard is to be reliable when activated. If Cloudflare goes down,
   * the operator can flip CAPTCHA_ENABLED=false within minutes.
   */
  private async verify(
    token: string,
    remoteIp: string | undefined,
  ): Promise<TurnstileVerifyResponse> {
    const secret = this.env.captcha.turnstileSecret;
    if (!secret) return { success: false, 'error-codes': ['missing-secret'] };

    const params = new URLSearchParams({ secret, response: token });
    if (remoteIp) params.set('remoteip', remoteIp);

    try {
      const res = await fetch(this.SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return { success: false, 'error-codes': [`siteverify-http-${res.status}`] };
      }
      return (await res.json()) as TurnstileVerifyResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ event: 'captcha_siteverify_error', err: msg }, 'siteverify call failed');
      return { success: false, 'error-codes': ['siteverify-network-error'] };
    }
  }
}

/** Cloudflare Turnstile siteverify response. Other fields (hostname, action, …) ignored. */
interface TurnstileVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
}
