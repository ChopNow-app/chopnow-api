import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { envSchema } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { HealthModule } from './health/health.module';

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
    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.THROTTLE_TTL_SECONDS ?? '60', 10) * 1000,
        limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
      },
    ]),
    PrismaModule,
    AuthModule,
    UsersModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
