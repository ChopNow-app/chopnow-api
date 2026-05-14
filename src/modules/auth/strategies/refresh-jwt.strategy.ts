import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { Strategy } from 'passport-jwt';
import { EnvService } from '../../../infra/config/env.service';
import { JwtRevocationService } from '../jwt-revocation.service';
import { JwtPayload } from './jwt.strategy';

// Pulls the refresh token out of the JSON body. The access strategy reads from
// the Authorization header, but /auth/refresh is the one route where the token
// lives in the body (the client might be sending an *expired* access in the
// header at the same time, which we deliberately ignore here).
function extractFromBody(req: Request): string | null {
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
      jwtFromRequest: extractFromBody,
      ignoreExpiration: false,
      secretOrKey: env.jwtRefreshSecret,
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload) {
    // Re-read the body — passport already used it via the extractor, but
    // validate() is where we forward it to the service (req.user).
    const refreshToken = extractFromBody(req);
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
