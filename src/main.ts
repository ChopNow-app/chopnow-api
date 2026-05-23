// Sentry init MUST run before anything else can throw. Top-of-file
// import + immediate invocation before NestFactory.create gives the
// SDK the chance to monkey-patch Node's http/express internals first.
import { initSentry } from './infra/observability/sentry';
const sentryEnabled = initSentry();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import * as express from 'express';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from './app.module';
import { APP_VERSION } from './app.version';
import { EnvService } from './infra/config/env.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  if (sentryEnabled) {
    // One-line confirmation at boot — useful for confirming the DSN
    // env-var actually reached the container. Not via the SDK; just
    // console so it appears even if pino isn't configured yet.
    console.log('[sentry] error tracking enabled');
  }

  app.useLogger(app.get(Logger));
  const env = app.get(EnvService);

  // --- HTTP security headers ---
  app.use(helmet());

  // --- Body size limit (prevents payload bombs / DoS via large JSON) ---
  // 1 MB is plenty for any auth / order / vendor payload. Image uploads go to R2 directly.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // --- Cookies (Phase B1) ---
  // Used for HttpOnly refresh-token storage on /auth/refresh + /auth/logout.
  // Parses `Cookie` header into `req.cookies`. No secret/signing — refresh
  // tokens are signed JWTs verified server-side, so the cookie value itself
  // doesn't need additional integrity protection beyond HttpOnly + Secure +
  // SameSite=Strict at issue time.
  app.use(cookieParser());

  // --- CORS allow-list ---
  app.enableCors({
    origin: env.corsOrigins,
    credentials: true,
  });

  // --- Input validation: strip unknown props, fail on extras, transform types ---
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // AllExceptionsFilter is registered via APP_FILTER in AppModule so it can
  // inject PinoLogger for structured 5xx logs.

  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });

  // URI versioning — every consumer-facing route gets `/api/v1/*`. Routes
  // that must stay at unversioned paths (machine-to-machine webhooks where
  // an external party has the URL registered, infra probes) opt out per
  // controller / per method with `@Version(VERSION_NEUTRAL)`. Future v2 can
  // be added per-controller via `@Version('2')` without disturbing v1.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // --- OpenAPI / Swagger ---
  // Built when available; failures during introspection (e.g. circular enum
  // refs in @nestjs/swagger 11.4+) must NOT block the actual API from booting.
  // Docs are useful but not load-bearing.
  try {
    const openApiConfig = new DocumentBuilder()
      .setTitle('ChopNow API')
      .setDescription(
        'Backend HTTP contract for chopnow-app (consumer / livreur / vendeur / admin).',
      )
      .setVersion(APP_VERSION)
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addTag('auth', 'OTP, JWT, sessions')
      .addTag('users', 'Profile, role lookups')
      .addTag('catalogue', 'Vendors, items, availability')
      .addTag('orders', 'Cart and order lifecycle')
      .addTag('payments', 'Campay MoMo + Orange Money')
      .addTag('dispatch', 'Rider assignment, GPS, voice proxy')
      .addTag('finance', 'Payouts, settlement, KYC')
      .addTag('admin', 'Ops console, audit')
      .build();

    const document = SwaggerModule.createDocument(app, openApiConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });

    if (env.openApiExport) {
      const out = resolve(process.cwd(), 'openapi.json');
      writeFileSync(out, JSON.stringify(document, null, 2));
      console.log(`OpenAPI spec written to ${out}`);
      process.exit(0);
    }
  } catch (err) {
    console.warn(
      `[swagger] OpenAPI doc build failed (${(err as Error).message.split('\n')[0]}). ` +
        `Continuing without /api/docs — fix the offending decorator and restart.`,
    );
    if (env.openApiExport) {
      // openapi:export requires a working doc — fail fast in that mode.
      throw err;
    }
  }

  await app.listen(env.port);
}

bootstrap();
