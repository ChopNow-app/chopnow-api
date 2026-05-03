import { SetMetadata } from '@nestjs/common';

export const PHONE_RATE_LIMIT_KEY = 'phoneRateLimit';

export interface PhoneRateLimitOptions {
  /** Max requests per window. */
  limit: number;
  /** Sliding window length in seconds. */
  ttlSeconds: number;
  /** Body key holding the phone — defaults to 'phone'. */
  bodyKey?: string;
}

/**
 * Rate limits by phone (in addition to the global IP throttler).
 * Used on `/auth/request-otp` to prevent enumeration of a single phone
 * (Story 1.1 spec — 5 OTPs per 15 min per phone).
 *
 * @example
 *   @PhoneRateLimit({ limit: 5, ttlSeconds: 900 })
 *   @Post('request-otp')
 *   requestOtp(...) { ... }
 */
export const PhoneRateLimit = (opts: PhoneRateLimitOptions): MethodDecorator =>
  SetMetadata(PHONE_RATE_LIMIT_KEY, opts);
