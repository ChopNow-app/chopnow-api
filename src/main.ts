import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import * as express from 'express';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { AppModule } from './app.module';
import { EnvService } from './infra/config/env.service';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  const env = app.get(EnvService);

  // --- HTTP security headers ---
  app.use(helmet());

  // --- Body size limit (prevents payload bombs / DoS via large JSON) ---
  // 1 MB is plenty for any auth / order / vendor payload. Image uploads go to R2 directly.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

  app.useGlobalFilters(new AllExceptionsFilter());

  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });

  // --- OpenAPI / Swagger ---
  // Always built (cheap) so the frontend team can grab the spec at /api/docs-json,
  // or run `npm run openapi:export` to regenerate openapi.json.
  const openApiConfig = new DocumentBuilder()
    .setTitle('ChopNow API')
    .setDescription('Backend HTTP contract for chopnow-app (consumer / livreur / vendeur / admin).')
    .setVersion(process.env.npm_package_version ?? '0.1.0')
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

  // Optional: dump openapi.json for `npm run openapi:export`
  if (process.env.OPENAPI_EXPORT === 'true') {
    const out = resolve(process.cwd(), 'openapi.json');
    writeFileSync(out, JSON.stringify(document, null, 2));
    console.log(`OpenAPI spec written to ${out}`);
    process.exit(0);
  }

  await app.listen(env.port);
}

bootstrap();
