import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marks a route as idempotent. The IdempotencyInterceptor reads `Idempotency-Key`
 * from the request header, caches the response in Redis for the configured TTL,
 * and returns the cached response on duplicate calls.
 *
 * @example
 *   @Idempotent({ ttlSeconds: 86400 })
 *   @Post('/orders')
 *   create(...) { ... }
 */
export interface IdempotencyOptions {
  ttlSeconds?: number;
}

export const Idempotent = (opts: IdempotencyOptions = {}): MethodDecorator =>
  SetMetadata(IDEMPOTENT_KEY, opts);
