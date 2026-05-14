import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { EnvService } from '../../../infra/config/env.service';
import { JwtRevocationService } from '../jwt-revocation.service';

export interface JwtPayload {
  sub: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    env: EnvService,
    private readonly revocation: JwtRevocationService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: env.jwtAccessSecret,
    });
  }

  async validate(payload: JwtPayload) {
    // Story 1.7 — check the per-user revocation list BEFORE returning a
    // populated `req.user`. A suspended account's tokens must stop working
    // on the very next request, not at natural expiry.
    if (await this.revocation.isRevoked(payload.sub)) {
      throw new UnauthorizedException({
        code: 'account_suspended',
        message: 'This account has been suspended.',
      });
    }
    return { id: payload.sub, role: payload.role };
  }
}
