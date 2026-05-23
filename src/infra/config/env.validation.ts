import * as Joi from 'joi';

export const envSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(3001),
  APP_URL: Joi.string().uri().required(),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  // Phase B1 — cut from 24h → 15m. Access tokens now live in PWA memory
  // (not localStorage), refresh tokens live in an HttpOnly cookie. A 15-min
  // access TTL bounds the XSS-stolen access token window; the refresh
  // cookie does the long-lived authentication. Worst case the user's API
  // call gets a 401 every 15 min and the client refreshes silently.
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL: Joi.string().default('30d'),
  // Phase D1 — admin refresh TTL. Tighter than consumer: an XSS or
  // stolen cookie buys at most 24h instead of 30 days. 24h is the
  // longest interval between admin work sessions we expect at pilot
  // scale; daily-active admins still get silent refresh, anyone less
  // active re-enters password + TOTP.
  JWT_ADMIN_REFRESH_TTL: Joi.string().default('24h'),

  // Passphrase for at-rest envelope encryption of TOTP shared secrets
  // (and any future secret we need to decrypt at runtime). Generate with
  // `openssl rand -hex 32`. Rotating this key invalidates every existing
  // ciphertext — affected admins must re-enroll via recovery codes.
  APP_SECRET_ENVELOPE_KEY: Joi.string().min(32).required(),

  TWILIO_ACCOUNT_SID: Joi.string().optional(),
  TWILIO_AUTH_TOKEN: Joi.string().optional(),
  TWILIO_WHATSAPP_FROM: Joi.string().optional(),
  TWILIO_SMS_FROM: Joi.string().optional(),
  // Story 4.17 voice proxy — Twilio caller ID number (e.g. +14155238886).
  TWILIO_VOICE_FROM: Joi.string().optional(),
  // Public URL Twilio POSTs delivery status updates to (e.g. https://api.example.com/api/twilio/status).
  // Leave unset in dev — rows then stay at SENT until reconciled.
  TWILIO_STATUS_CALLBACK_URL: Joi.string().uri().allow('').optional(),

  CAMPAY_API_URL: Joi.string().uri().optional(),
  CAMPAY_USERNAME: Joi.string().optional(),
  CAMPAY_PASSWORD: Joi.string().optional(),
  // Required in production (the webhook guard hard-fails any request whose
  // signature can't be verified against this secret — a missing secret in
  // prod means all real Campay webhooks would be rejected, so we'd rather
  // fail at boot). Optional in dev/test so contributors don't need a real
  // Campay account just to start the API.
  CAMPAY_WEBHOOK_SECRET: Joi.string().min(16).when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  VAPID_PUBLIC_KEY: Joi.string().optional(),
  VAPID_PRIVATE_KEY: Joi.string().optional(),
  VAPID_SUBJECT: Joi.string().optional(),

  R2_ACCOUNT_ID: Joi.string().allow('').optional(),
  R2_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  R2_BUCKET: Joi.string().optional(),

  RESEND_API_KEY: Joi.string().allow('').optional(),
  MAIL_FROM: Joi.string().default('ChopNow <noreply@chopnow.app>'),

  THROTTLE_TTL_SECONDS: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(100),

  // --- CAPTCHA (Cloudflare Turnstile) ---
  // Inert by default. Routes decorated with `@UseGuards(TurnstileGuard)`
  // (currently only `/auth/request-otp`) become protected when both
  // CAPTCHA_ENABLED=true AND TURNSTILE_SECRET_KEY is set. When disabled,
  // the guard short-circuits to `return true` — no overhead, no widget
  // expected from the client. Flip via GitHub `staging` env secrets +
  // matching Vercel envs on the PWA side; turnstile.cloudflare.com
  // issues both the site (frontend) and secret (backend) keys.
  CAPTCHA_ENABLED: Joi.string().valid('true', 'false').default('false'),
  TURNSTILE_SECRET_KEY: Joi.string().allow('').optional(),
  // Public Turnstile site key. Not a secret — embedded in the PWA — but
  // kept on the backend so it's the single source of truth alongside
  // CAPTCHA_ENABLED. The /auth/captcha-config endpoint serves it to the
  // PWA at runtime; flipping the flag never needs a frontend rebuild.
  TURNSTILE_SITE_KEY: Joi.string().allow('').optional(),

  // Number of reverse-proxy hops in front of the API. Read by
  // `app.set('trust proxy', N)` in main.ts so Express trusts the
  // X-Forwarded-* headers Caddy/Cloudflare set and `req.ip` resolves to
  // the real client.
  //
  //   0 — direct exposure (local dev). req.ip = socket peer.
  //   1 — one proxy (Caddy on the DO staging droplet, future nginx on Hetzner).
  //   2 — two proxies (Cloudflare → Caddy → API).
  //
  // Without this, every staging request looks like 127.0.0.1, and every
  // per-IP @Throttle decorator collapses into one global bucket.
  TRUST_PROXY: Joi.number().integer().min(0).max(5).default(0),

  CORS_ORIGINS: Joi.string().default('http://localhost:3000'),

  // Internal flag toggled by `npm run openapi:export`. Not for users.
  OPENAPI_EXPORT: Joi.string().valid('true', 'false').default('false'),

  // --- Sentry / observability (Phase O1) ---
  // All optional — the SDK no-ops cleanly when DSN is unset, which is
  // the right default for CI / local dev. Staging + production set
  // these via GitHub environment secrets.
  SENTRY_DSN: Joi.string().uri().allow('').optional(),
  SENTRY_ENVIRONMENT: Joi.string().allow('').optional(),
  SENTRY_RELEASE: Joi.string().allow('').optional(),
  SENTRY_TRACES_SAMPLE_RATE: Joi.string()
    .pattern(/^0(\.\d+)?$|^1(\.0+)?$/)
    .optional(),

  // --- Metrics auth (Phase O2 follow-up) ---
  // Optional. When set, `/metrics` requires `Authorization: Bearer <token>`
  // matching this value. When unset, /metrics is open — right for local
  // dev. Generate with `openssl rand -hex 32`.
  METRICS_AUTH_TOKEN: Joi.string().min(16).allow('').optional(),

  // --- Prisma slow query (Phase O4) ---
  // Threshold (ms) above which Prisma logs a `prisma_slow_query` event.
  // Default 500ms. Tighter (200ms) once we have a baseline; looser
  // (1000ms) only during incident triage to reduce log volume.
  PRISMA_SLOW_QUERY_MS: Joi.string().pattern(/^\d+$/).optional(),

  // --- Loki log shipping (Phase O3) ---
  // All optional — if LOKI_URL is unset, the pino-loki transport is
  // not added and logs continue to stdout only. To activate: sign up
  // at grafana.com, get the Loki endpoint + tenant ID + API token,
  // set as GitHub secrets. See deploy/.env.staging.example for the
  // staging shape.
  LOKI_URL: Joi.string().uri().allow('').optional(),
  LOKI_USERNAME: Joi.string().allow('').optional(),
  LOKI_TOKEN: Joi.string().allow('').optional(),
});
