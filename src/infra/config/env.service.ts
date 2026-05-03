import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Typed accessor over `process.env` / `ConfigService`.
 * Use this instead of `configService.get<string>('FOO')` or raw `process.env.FOO`
 * — IDE autocomplete catches typos, return types are right, missing required
 * vars throw at the access point instead of crashing later in business logic.
 *
 * Joi validation in `env.validation.ts` runs first and is authoritative for
 * required-vs-optional. This service trusts that schema.
 */
@Injectable()
export class EnvService {
  private readonly logger = new Logger(EnvService.name);

  constructor(private readonly raw: ConfigService) {}

  // --- App ---
  get nodeEnv(): 'development' | 'production' | 'test' {
    return this.raw.getOrThrow('NODE_ENV');
  }
  get port(): number {
    return this.raw.getOrThrow('PORT');
  }
  get appUrl(): string {
    return this.raw.getOrThrow('APP_URL');
  }
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }
  get corsOrigins(): string[] {
    return this.raw
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // --- Database ---
  get databaseUrl(): string {
    return this.raw.getOrThrow('DATABASE_URL');
  }

  // --- Redis ---
  get redisHost(): string {
    return this.raw.getOrThrow('REDIS_HOST');
  }
  get redisPort(): number {
    return this.raw.getOrThrow('REDIS_PORT');
  }
  get redisPassword(): string | undefined {
    const v = this.raw.get<string>('REDIS_PASSWORD');
    return v && v.length > 0 ? v : undefined;
  }

  // --- JWT ---
  get jwtAccessSecret(): string {
    return this.raw.getOrThrow('JWT_ACCESS_SECRET');
  }
  get jwtRefreshSecret(): string {
    return this.raw.getOrThrow('JWT_REFRESH_SECRET');
  }
  get jwtAccessTtl(): string {
    return this.raw.getOrThrow('JWT_ACCESS_TTL');
  }
  get jwtRefreshTtl(): string {
    return this.raw.getOrThrow('JWT_REFRESH_TTL');
  }

  // --- Twilio (Story 1.1) ---
  get twilio(): { sid?: string; authToken?: string; whatsappFrom?: string; smsFrom?: string } {
    return {
      sid: this.raw.get<string>('TWILIO_ACCOUNT_SID'),
      authToken: this.raw.get<string>('TWILIO_AUTH_TOKEN'),
      whatsappFrom: this.raw.get<string>('TWILIO_WHATSAPP_FROM'),
      smsFrom: this.raw.get<string>('TWILIO_SMS_FROM'),
    };
  }
  /** Throws if Twilio isn't configured — call from services that require it. */
  requireTwilio(): { sid: string; authToken: string; whatsappFrom: string; smsFrom: string } {
    const t = this.twilio;
    if (!t.sid || !t.authToken || !t.whatsappFrom || !t.smsFrom) {
      throw new Error('Twilio is not configured — set TWILIO_* env vars');
    }
    return t as { sid: string; authToken: string; whatsappFrom: string; smsFrom: string };
  }

  // --- Campay (Stories 3.3, 3.4, 7.x) ---
  get campay(): { apiUrl?: string; username?: string; password?: string; webhookSecret?: string } {
    return {
      apiUrl: this.raw.get<string>('CAMPAY_API_URL'),
      username: this.raw.get<string>('CAMPAY_USERNAME'),
      password: this.raw.get<string>('CAMPAY_PASSWORD'),
      webhookSecret: this.raw.get<string>('CAMPAY_WEBHOOK_SECRET'),
    };
  }
  requireCampay(): { apiUrl: string; username: string; password: string; webhookSecret: string } {
    const c = this.campay;
    if (!c.apiUrl || !c.username || !c.password || !c.webhookSecret) {
      throw new Error('Campay is not configured — set CAMPAY_* env vars');
    }
    return c as { apiUrl: string; username: string; password: string; webhookSecret: string };
  }

  // --- Web Push / VAPID (Story 1.11) ---
  get vapid(): { publicKey?: string; privateKey?: string; subject?: string } {
    return {
      publicKey: this.raw.get<string>('VAPID_PUBLIC_KEY'),
      privateKey: this.raw.get<string>('VAPID_PRIVATE_KEY'),
      subject: this.raw.get<string>('VAPID_SUBJECT'),
    };
  }
  requireVapid(): { publicKey: string; privateKey: string; subject: string } {
    const v = this.vapid;
    if (!v.publicKey || !v.privateKey || !v.subject) {
      throw new Error('VAPID is not configured — set VAPID_* env vars');
    }
    return v as { publicKey: string; privateKey: string; subject: string };
  }

  // --- Cloudflare R2 ---
  get r2(): {
    accountId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
  } {
    return {
      accountId: this.raw.get<string>('R2_ACCOUNT_ID'),
      accessKeyId: this.raw.get<string>('R2_ACCESS_KEY_ID'),
      secretAccessKey: this.raw.get<string>('R2_SECRET_ACCESS_KEY'),
      bucket: this.raw.get<string>('R2_BUCKET'),
    };
  }

  // --- Mail (Resend) ---
  get mail(): { resendApiKey?: string; from: string } {
    return {
      resendApiKey: this.raw.get<string>('RESEND_API_KEY'),
      from: this.raw.getOrThrow<string>('MAIL_FROM'),
    };
  }
  requireMail(): { resendApiKey: string; from: string } {
    const m = this.mail;
    if (!m.resendApiKey) throw new Error('RESEND_API_KEY is not set');
    return { resendApiKey: m.resendApiKey, from: m.from };
  }

  // --- Internal ---
  get openApiExport(): boolean {
    return this.raw.get<string>('OPENAPI_EXPORT') === 'true';
  }

  // --- Throttler ---
  get throttle(): { ttlSeconds: number; limit: number } {
    return {
      ttlSeconds: this.raw.getOrThrow('THROTTLE_TTL_SECONDS'),
      limit: this.raw.getOrThrow('THROTTLE_LIMIT'),
    };
  }
}
