import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EnvService } from '../config/env.service';

/**
 * Shared BullMQ wiring. Provides the Redis connection used by every queue +
 * worker in the app via `BullModule.forRoot()`. Individual modules register
 * their queues with `BullModule.registerQueue({ name })`.
 *
 * Connection note: BullMQ workers issue blocking commands (BRPOPLPUSH etc.)
 * which require `maxRetriesPerRequest: null`. That setting would break
 * `RedisService`'s one-shot callers (OTP, rate-limit, idempotency) which
 * benefit from fast-fail retries, so this module spins up a separate
 * ioredis client on the same Redis server — same host/port/password env,
 * different per-connection options. Two TCP connections, isolated failure
 * semantics.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        connection: {
          host: env.redisHost,
          port: env.redisPort,
          password: env.redisPassword,
          // BullMQ requirement — workers' blocking commands break otherwise.
          maxRetriesPerRequest: null,
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
