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
  JWT_ACCESS_TTL: Joi.string().default('24h'),
  JWT_REFRESH_TTL: Joi.string().default('30d'),

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

  CORS_ORIGINS: Joi.string().default('http://localhost:3000'),

  // Internal flag toggled by `npm run openapi:export`. Not for users.
  OPENAPI_EXPORT: Joi.string().valid('true', 'false').default('false'),
});
