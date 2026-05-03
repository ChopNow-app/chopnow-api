import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { Request } from 'express';
import { RedisService } from '../../infra/redis/redis.service';
import { IDEMPOTENT_KEY, IdempotencyOptions } from '../decorators/idempotent.decorator';

const DEFAULT_TTL = 24 * 60 * 60; // 24h

/**
 * Story 3.14 — payment idempotency.
 * For routes marked with @Idempotent(), reads `Idempotency-Key` header.
 *   - first call: stores response (status + body) in Redis, then returns it
 *   - duplicate call (same key): returns cached response, never re-runs handler
 *   - missing header: 400
 *   - in-flight duplicate (same key, no response yet): 409
 *
 * Key format: `idem:<route>:<key>`. Per-user scoping should be added by the
 * caller as a prefix in the header value if needed.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.getAllAndOverride<IdempotencyOptions>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!opts) return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const key = req.header('idempotency-key');
    if (!key) throw new BadRequestException('missing_idempotency_key');
    if (key.length > 200) throw new BadRequestException('idempotency_key_too_long');

    const cacheKey = `idem:${req.method}:${req.route?.path ?? req.path}:${key}`;
    const ttl = opts.ttlSeconds ?? DEFAULT_TTL;

    return from(this.redis.get(cacheKey)).pipe(
      switchMap((cached) => {
        if (cached === 'IN_FLIGHT') {
          throw new ConflictException('idempotency_in_flight');
        }
        if (cached) {
          const parsed = JSON.parse(cached) as { body: unknown };
          return of(parsed.body);
        }
        // mark in-flight before running handler
        return from(this.redis.setNX(cacheKey, 'IN_FLIGHT', ttl)).pipe(
          switchMap(() =>
            next.handle().pipe(
              tap(async (body) => {
                await this.redis.setWithTTL(cacheKey, JSON.stringify({ body }), ttl);
              }),
            ),
          ),
        );
      }),
    );
  }
}
