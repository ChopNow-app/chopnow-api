import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { envSchema } from './infra/config/env.validation';
import { AppConfigModule } from './infra/config/config.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { TwilioModule } from './infra/twilio/twilio.module';
import { R2Module } from './infra/r2/r2.module';
import { MailModule } from './infra/mail/mail.module';

import { AuthModule } from './modules/auth/auth.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { UsersModule } from './modules/users/users.module';
import { OrdersModule } from './modules/orders/orders.module';
import { HealthModule } from './health/health.module';

import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';
import { RolesGuard } from './shared/guards/roles.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      validationOptions: { abortEarly: true },
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' },
              }
            : undefined,
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 50,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.THROTTLE_TTL_SECONDS ?? '60', 10) * 1000,
        limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
      },
    ]),
    // --- Infrastructure (global) ---
    AppConfigModule,
    PrismaModule,
    RedisModule,
    TwilioModule,
    R2Module,
    MailModule,
    // --- Domain modules ---
    AuthModule,
    UsersModule,
    OrdersModule,
    CatalogueModule,
    // PaymentsModule, DispatchModule,
    // NotificationsModule, FinanceModule, AdminModule — wired in per-epic
    // --- Cross-cutting ---
    HealthModule,
  ],
  providers: [
    // Global rate limiter (per-IP)
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global auth — every route is JWT-protected by default; mark public ones with @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global RBAC — only triggers when a route has @Roles(...)
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
