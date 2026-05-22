import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { Strategy } from 'passport-jwt';
import { EnvService } from '../../../infra/config/env.service';
import { JwtRevocationService } from '../jwt-revocation.service';
import { JwtPayload } from './jwt.strategy';

/**
 * Phase B1 — prefer the HttpOnly cookie, fall back to the JSON body.
 *
 * Cookie path: production clients send the refresh token via the
 * `chopnow_rt` cookie set at login / on previous refresh. JavaScript
 * cannot read it (HttpOnly), so XSS can't exfiltrate.
 *
 * Body path: retained for backwards compatibility while the consumer PWA
 * cuts over from `localStorage` storage to the cookie model. Once the
 * frontend ships its paired PR + cookie-only is the default everywhere,
 * the body extractor can be removed.
 */
function extractRefreshToken(req: Request): string | null {
  const cookieValue = (req?.cookies as { chopnow_rt?: unknown } | undefined)?.chopnow_rt;
  if (typeof cookieValue === 'string' && cookieValue.length > 0) {
    return cookieValue;
  }
  const body = req?.body as { refreshToken?: unknown } | undefined;
  return typeof body?.refreshToken === 'string' && body.refreshToken.length > 0
    ? body.refreshToken
    : null;
}

@Injectable()
export class RefreshJwtStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(
    env: EnvService,
    private readonly revocation: JwtRevocationService,
  ) {
    super({
      jwtFromRequest: extractRefreshToken,
      ignoreExpiration: false,
      secretOrKey: env.jwtRefreshSecret,
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload) {
    // Re-read — passport already used the extractor; validate() forwards
    // it onto req.user for the service.
    const refreshToken = extractRefreshToken(req);
    if (!refreshToken) {
      // Should be unreachable (extractor would have produced null and passport
      // would have rejected before reaching validate), but belt-and-braces.
      throw new UnauthorizedException({
        code: 'refresh_invalid_or_expired',
        message: 'Refresh token missing.',
      });
    }
    // Story 1.7 — even a valid-looking refresh token must be rejected if its
    // user is on the revocation list. Otherwise a suspended account could
    // mint a fresh access token via /auth/refresh.
    if (await this.revocation.isRevoked(payload.sub)) {
      throw new UnauthorizedException({
        code: 'account_suspended',
        message: 'This account has been suspended.',
      });
    }
    return { id: payload.sub, role: payload.role, refreshToken };
  }
}
