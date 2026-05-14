import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

// Wraps the passport 'jwt-refresh' strategy so every failure path emits the
// same structured 401 body shape `{ code, message }`. Without this, strategy-
// level rejections (missing token, bad signature, expired JWT) fall back to
// Nest's default `{ statusCode: 401, message: 'Unauthorized' }`, which would
// force the consumer PWA to string-match.
@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context) as Promise<boolean>;
  }

  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new UnauthorizedException({
        code: 'refresh_invalid_or_expired',
        message: 'Session expired. Please sign in again.',
      });
    }
    return user;
  }
}
