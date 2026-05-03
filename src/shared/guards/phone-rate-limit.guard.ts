import {
  CanActivate,
  ExecutionContext,
  Injectable,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RedisService } from '../../infra/redis/redis.service';
import {
  PHONE_RATE_LIMIT_KEY,
  PhoneRateLimitOptions,
} from '../decorators/phone-rate-limit.decorator';

/**
 * Per-phone rate limit. Reads the phone from the request body (configurable key)
 * and increments a Redis counter keyed by phone. If the counter exceeds the
 * limit within the window, returns 429.
 *
 * Apply explicitly via `@UseGuards(PhoneRateLimitGuard)` on routes that need it
 * — not registered globally. Pair with `@PhoneRateLimit({ limit, ttlSeconds })`.
 */
@Injectable()
export class PhoneRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<PhoneRateLimitOptions>(PHONE_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!opts) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const bodyKey = opts.bodyKey ?? 'phone';
    const phone = req.body?.[bodyKey];
    if (typeof phone !== 'string' || phone.length === 0) return true;

    const key = `phonerl:${req.route?.path ?? req.path}:${phone}`;
    const count = await this.redis.incrWithTTL(key, opts.ttlSeconds);
    if (count > opts.limit) {
      throw new HttpException(
        {
          statusCode: 429,
          message: 'too_many_requests_for_phone',
          retryAfterSeconds: opts.ttlSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
