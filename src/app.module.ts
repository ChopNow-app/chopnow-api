import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { envSchema } from './infra/config/env.validation';
import { PrismaModule } from './infra/prisma/prisma.module';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { OrdersModule } from './modules/orders/orders.module';
import { HealthModule } from './health/health.module';

import { JwtAuthGuard } from './shared/guards/jwt-auth.guard';

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
            ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } }
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
    PrismaModule,
    // --- Domain modules ---
    AuthModule,
    UsersModule,
    OrdersModule,
    // CatalogueModule, PaymentsModule, DispatchModule,
    // NotificationsModule, FinanceModule, AdminModule — wired in per-epic
    // --- Cross-cutting ---
    HealthModule,
  ],
  providers: [
    // Global rate limiter
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global auth — every route is JWT-protected by default; mark public ones with @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
