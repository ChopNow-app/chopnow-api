import { Injectable } from '@nestjs/common';
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

  /**
   * Passphrase for at-rest envelope encryption of TOTP shared secrets
   * (and any future secret we need to decrypt at runtime). Generate with
   * `openssl rand -hex 32`. Rotating this key invalidates every existing
   * ciphertext — affected admins must re-enroll via recovery codes.
   */
  get secretEnvelopeKey(): string {
    return this.raw.getOrThrow('APP_SECRET_ENVELOPE_KEY');
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
  // Phase D1 — admin sessions use a tighter refresh window than consumer
  // (consumer = 30d, admin = 24h). Default-set in env.validation so
  // existing deploys don't need a redeploy to pick this up.
  get jwtAdminRefreshTtl(): string {
    return this.raw.getOrThrow('JWT_ADMIN_REFRESH_TTL');
  }

  // --- Twilio (Story 1.1) ---
  get twilio(): {
    sid?: string;
    authToken?: string;
    whatsappFrom?: string;
    smsFrom?: string;
    voiceFrom?: string;
    statusCallbackUrl?: string;
    otpContentSid?: string;
  } {
    const cb = this.raw.get<string>('TWILIO_STATUS_CALLBACK_URL');
    const contentSid = this.raw.get<string>('TWILIO_OTP_CONTENT_SID');
    return {
      sid: this.raw.get<string>('TWILIO_ACCOUNT_SID'),
      authToken: this.raw.get<string>('TWILIO_AUTH_TOKEN'),
      whatsappFrom: this.raw.get<string>('TWILIO_WHATSAPP_FROM'),
      smsFrom: this.raw.get<string>('TWILIO_SMS_FROM'),
      voiceFrom: this.raw.get<string>('TWILIO_VOICE_FROM'),
      statusCallbackUrl: cb && cb.length > 0 ? cb : undefined,
      // Approved WhatsApp Authentication template (Content SID, HX…). When set,
      // OTPs are sent via the template instead of freeform text — required for
      // production WhatsApp (business-initiated messages can't be freeform).
      otpContentSid: contentSid && contentSid.length > 0 ? contentSid : undefined,
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
  get campay(): {
    apiUrl?: string;
    username?: string;
    password?: string;
    webhookSecret?: string;
    transfersEnabled?: boolean;
    refundsEnabled?: boolean;
  } {
    return {
      apiUrl: this.raw.get<string>('CAMPAY_API_URL'),
      username: this.raw.get<string>('CAMPAY_USERNAME'),
      password: this.raw.get<string>('CAMPAY_PASSWORD'),
      webhookSecret: this.raw.get<string>('CAMPAY_WEBHOOK_SECRET'),
      // Outbound transfers are blocked on Campay Go-Live + RCCM. Until
      // then the worker queries PENDING rows but skips the network call
      // and leaves rows for manual fire via the admin dashboard.
      transfersEnabled: this.raw.get<string>('CAMPAY_TRANSFERS_ENABLED') === 'true',
      // Same kill-switch shape for refunds (#90). RefundProcessor logs
      // awareness but doesn't fire when this is false. Admin can refund
      // manually via the Campay UI and mark the order REFUNDED through
      // the admin endpoint.
      refundsEnabled: this.raw.get<string>('CAMPAY_REFUNDS_ENABLED') === 'true',
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

  /**
   * Number of reverse-proxy hops to trust. Fed to `app.set('trust proxy', N)`
   * in main.ts. 0 in dev (direct exposure), 1 on staging (Caddy), 1+ in prod.
   */
  get trustProxy(): number {
    return this.raw.getOrThrow('TRUST_PROXY');
  }

  /**
   * Cloudflare Turnstile bot-protection. When `captcha.enabled` is false
   * (default), TurnstileGuard short-circuits and routes behave as if the
   * guard weren't there. When true, the guard requires a valid
   * `cf-turnstile-response` token and verifies it against Cloudflare's
   * siteverify endpoint before passing the request through. Pre-wired
   * for fast mid-pilot activation if abuse appears; see audit table.
   */
  get captcha(): { enabled: boolean; turnstileSecret?: string; turnstileSiteKey?: string } {
    const secret = this.raw.get<string>('TURNSTILE_SECRET_KEY');
    const siteKey = this.raw.get<string>('TURNSTILE_SITE_KEY');
    return {
      enabled: this.raw.get<string>('CAPTCHA_ENABLED') === 'true',
      turnstileSecret: secret && secret.length > 0 ? secret : undefined,
      turnstileSiteKey: siteKey && siteKey.length > 0 ? siteKey : undefined,
    };
  }
}
