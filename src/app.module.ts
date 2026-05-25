import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { envSchema } from './infra/config/env.validation';
import { AppConfigModule } from './infra/config/config.module';
import { EnvService } from './infra/config/env.service';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { RedisService } from './infra/redis/redis.service';
import { QueueModule } from './infra/queue/queue.module';
import { TwilioModule } from './infra/twilio/twilio.module';
import { R2Module } from './infra/r2/r2.module';
import { MailModule } from './infra/mail/mail.module';

import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RidersModule } from './modules/riders/riders.module';
import { UsersModule } from './modules/users/users.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { OrdersModule } from './modules/orders/orders.module';
import { VoiceProxyModule } from './modules/voice-proxy/voice-proxy.module';
import { FinanceModule } from './modules/finance/finance.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './infra/observability/metrics.module';
import { OpenApiModule } from './infra/openapi/openapi.module';

import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';
import { RolesGuard } from './shared/guards/roles.guard';
import { buildPinoTransport } from './infra/observability/pino-transport';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      validationOptions: { abortEarly: true },
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        // Phase O3 — when LOKI_URL is set, ship logs to Grafana Cloud
        // Loki in addition to / instead of stdout. Inert when LOKI_URL
        // is empty so local dev + CI keep their existing behavior.
        // See `buildPinoTransport` below for the matrix.
        transport: buildPinoTransport(),
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 50,
    }),
    ScheduleModule.forRoot(),
    // Throttler storage runs over Redis so per-IP + per-route counters
    // stay consistent across replicas. The in-memory default would let
    // each container keep its own bucket — fine for a single staging
    // container, broken the moment we horizontally scale on Hetzner
    // (or even during a rolling redeploy with brief 2-container overlap).
    //
    // RedisModule is @Global, so the EnvService + RedisService can be
    // injected here without extra `imports`. The Redis client is shared
    // with OTP rate-limits, JWT revocation, idempotency cache, etc. —
    // one connection pool, multiple consumers.
    ThrottlerModule.forRootAsync({
      inject: [EnvService, RedisService],
      useFactory: (env: EnvService, redis: RedisService) => ({
        throttlers: [
          {
            ttl: env.throttle.ttlSeconds * 1000,
            limit: env.throttle.limit,
          },
        ],
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
    // --- Infrastructure (global) ---
    AppConfigModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    TwilioModule,
    R2Module,
    MailModule,
    // --- Domain modules ---
    AuthModule,
    UsersModule,
    OrdersModule,
    CatalogueModule,
    RidersModule,
    AdminModule,
    PaymentsModule,
    DispatchModule,
    NotificationsModule,
    VoiceProxyModule,
    FinanceModule,
    CouponsModule,
    // --- Cross-cutting ---
    HealthModule,
    MetricsModule,
    OpenApiModule,
  ],
  providers: [
    // Global rate limiter (per-IP)
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global auth — every route is JWT-protected by default; mark public ones with @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global RBAC — only triggers when a route has @Roles(...)
    { provide: APP_GUARD, useClass: RolesGuard },
    // Structured 5xx logging via PinoLogger — must be DI-registered (not `new
    // AllExceptionsFilter()` in main.ts) so InjectPinoLogger resolves.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
