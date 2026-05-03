import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { EnvService } from '../config/env.service';

/**
 * Thin wrapper around ioredis. Other modules inject this service rather than
 * instantiating clients directly so we have a single connection pool.
 *
 * Used by:
 *   - JWT blacklist (Story 1.7)
 *   - Idempotency interceptor (Story 3.14)
 *   - Phone-based rate limit guard (Story 1.1)
 *   - Future: distributed throttler, dispatch heartbeats, locks
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(env: EnvService) {
    this.client = new Redis({
      host: env.redisHost,
      port: env.redisPort,
      password: env.redisPassword,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log(`Redis connected (${this.client.options.host}:${this.client.options.port})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  // --- Convenience helpers ---

  /** SET with TTL (seconds). Returns 'OK' on success. */
  async setWithTTL(key: string, value: string, ttlSeconds: number): Promise<'OK'> {
    return this.client.set(key, value, 'EX', ttlSeconds);
  }

  /** SET only if not exists (NX) with TTL. Returns true if the key was set. */
  async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const res = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  /** Atomic increment with TTL on first set — used for rate limiters. */
  async incrWithTTL(key: string, ttlSeconds: number): Promise<number> {
    const pipeline = this.client.multi();
    pipeline.incr(key);
    pipeline.expire(key, ttlSeconds, 'NX'); // TTL only on first hit
    const results = await pipeline.exec();
    if (!results) return 0;
    return results[0][1] as number;
  }

  /** GET wrapper that returns null if absent. */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /** DEL wrapper. */
  async del(...keys: string[]): Promise<number> {
    return keys.length === 0 ? 0 : this.client.del(...keys);
  }
}
