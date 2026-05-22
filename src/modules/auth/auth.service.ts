import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { OtpStatus, UserRole } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { OtpDeliveryService } from '../../infra/twilio/otp-delivery.service';
import { normalizePhone } from '../../shared/phone/phone.util';
import { parseDurationMs } from '../../shared/time/duration.util';

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 3;

// In-flight idempotency window. A second request-otp for the same phone
// within this window short-circuits — no fresh code generated, no second
// Twilio send, no orphaned OtpLog row. Chosen at 30s because:
//   - shorter than the 5min code TTL (the original code is still valid)
//   - long enough to absorb a double-tap + a "didn't see it, tap again"
//   - short enough that a legitimate "the SMS truly never arrived" retry
//     within ~minute still works on the second try (legit Twilio outage
//     resolves the lock on failure, see below)
const OTP_INFLIGHT_LOCK_SECONDS = 30;

// Per-token in-flight lock for refresh-token rotation (#175). Two
// concurrent /auth/refresh calls carrying the same raw token race on the
// revokedAt write: the first request's transaction revokes the row, the
// second request's candidates query sees revokedAt != null and trips
// reuse detection — which then revokes the entire family and logs the
// legitimate user out of every device. The lock serialises these so only
// one rotation proceeds; the loser bails benignly without triggering
// reuse detection.
// 5s is more than enough for a single rotation (argon2 hashes + a small
// transaction); short enough that a hard-killed pod can't strand a token
// for long.
const REFRESH_INFLIGHT_LOCK_SECONDS = 5;

@Injectable()
export class AuthService {
  constructor(
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
    private readonly otpDelivery: OtpDeliveryService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Story 1.1 — request an OTP.
   * 1) acquire a 30s per-phone in-flight lock; a second concurrent request
   *    short-circuits with the same shape so there's no duplicate Twilio
   *    send + no orphaned OtpLog row
   * 2) generate 6-digit code, hash with argon2id, persist OtpLog row with channel=WHATSAPP/PENDING
   * 3) attempt delivery (WhatsApp → SMS fallback)
   * 4) update the row with the channel actually used + SENT status
   *
   * If delivery fails, the lock is RELEASED so the legitimate "I truly
   * didn't get it" retry isn't blocked for 30s. The IP + per-phone rate
   * limiters still apply on top of that (5/15min each) — the lock is the
   * sub-second double-tap guard, not a substitute for them.
   */
  async requestOtp(phone: string): Promise<{ ok: true; expiresInSeconds: number }> {
    phone = normalizePhone(phone);

    // Sub-second idempotency. Returning the same shape (rather than a
    // 429-style error) is deliberate: the user just tapped twice, the OTP
    // is already on the way, no need to surface a confusing error.
    const acquired = await this.redis.setNX(
      `otp:inflight:${phone}`,
      String(Date.now()),
      OTP_INFLIGHT_LOCK_SECONDS,
    );
    if (!acquired) {
      this.logger.info(
        { event: 'otp_inflight_lock_held', phone },
        'OTP in-flight lock held — skipping duplicate send',
      );
      return { ok: true, expiresInSeconds: OTP_TTL_MINUTES * 60 };
    }

    const code = this.generateCode();
    const codeHash = await argon2.hash(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    const log = await this.prisma.otpLog.create({
      data: { phone, channel: 'WHATSAPP', status: 'PENDING', codeHash, expiresAt },
    });

    try {
      const { channel, providerMessageId } = await this.otpDelivery.sendOtp(phone, code);
      // SENT (not DELIVERED): Twilio's messages.create() returns a SID before
      // actual delivery. The /api/twilio/status webhook reconciles this row to
      // DELIVERED or FAILED when Twilio reports the real outcome. In dev, where
      // no public callback URL is configured, the row remains SENT — verifyOtp
      // accepts that as a valid pre-verification state.
      await this.prisma.otpLog.update({
        where: { id: log.id },
        data: { channel, status: OtpStatus.SENT, providerMessageId },
      });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(
        { event: 'otp_delivery_failed', phone, otpLogId: log.id, error: reason },
        'OTP delivery failed',
      );
      await this.prisma.otpLog.update({
        where: { id: log.id },
        data: { status: OtpStatus.FAILED, failedReason: reason },
      });
      // Release the in-flight lock so the user isn't stuck for 30s with
      // no code delivered. The IP + per-phone count limiters still bound
      // overall abuse.
      await this.redis.del(`otp:inflight:${phone}`);
      // Surface a generic error — don't leak provider internals to the client.
      throw new UnauthorizedException('otp_delivery_failed');
    }

    return { ok: true, expiresInSeconds: OTP_TTL_MINUTES * 60 };
  }

  async verifyOtp(
    phone: string,
    code: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    phone = normalizePhone(phone);
    const log = await this.prisma.otpLog.findFirst({
      where: {
        phone,
        // PENDING covers the brief window before sendOtp resolves; SENT is the normal post-send
        // state until the Twilio webhook upgrades it to DELIVERED. All three are valid for verify.
        status: { in: [OtpStatus.PENDING, OtpStatus.SENT, OtpStatus.DELIVERED] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!log) throw new UnauthorizedException('otp_invalid_or_expired');

    if (log.attempts >= OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('otp_too_many_attempts');
    }

    const valid = await argon2.verify(log.codeHash, code);
    if (!valid) {
      await this.prisma.otpLog.update({
        where: { id: log.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('otp_invalid_or_expired');
    }

    await this.prisma.otpLog.update({
      where: { id: log.id },
      data: { status: OtpStatus.VERIFIED, verifiedAt: new Date() },
    });

    // Release the in-flight lock now that this code has been consumed.
    // Without this, a user who signs in, logs out, then tries to sign in
    // again within 30s gets stuck because the second request-otp would
    // short-circuit but no fresh code exists (the old one is VERIFIED
    // and no longer eligible).
    await this.redis.del(`otp:inflight:${phone}`);

    const user = await this.prisma.user.upsert({
      where: { phone },
      update: {},
      create: { phone, role: UserRole.CONSUMER },
    });

    return this.signTokens(user.id, user.role);
  }

  /**
   * Story 1.2 — rotate the refresh token.
   *
   * Returns a fresh access+refresh pair if the presented refresh token is
   * valid, unrevoked, and the user is still active. Reuse of an already-
   * rotated token triggers a family-wide revoke (defense against stolen
   * tokens). All failure codes are structured so the consumer PWA can
   * branch on `body.code` instead of message-matching.
   */
  async refresh(
    userId: string,
    role: UserRole,
    rawRefreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive || user.isDeleted) {
      // Suspended/deleted user. Wipe whatever refresh tokens they had so the
      // next refresh attempt — even if somehow valid — also fails.
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({
        code: 'user_suspended',
        message: 'Account suspended.',
      });
    }

    // Per-token in-flight lock (#175). Stops two concurrent refreshes of the
    // same token from race-tripping reuse detection. We hash the raw token
    // for the Redis key so the actual secret never appears in Redis logs,
    // keyspace dumps, or ops queries. The lock is scoped per-token (not
    // per-user) so a user refreshing on two different devices in parallel
    // each get their own slot.
    const tokenFp = createHash('sha256').update(rawRefreshToken).digest('hex').slice(0, 32);
    const lockKey = `refresh:inflight:${tokenFp}`;
    const acquired = await this.redis.setNX(lockKey, '1', REFRESH_INFLIGHT_LOCK_SECONDS);
    if (!acquired) {
      // Another /auth/refresh with this exact token is rotating right now.
      // Bail with a benign code — DO NOT fall through to the reuse-detection
      // branch below, which would falsely revoke the entire token family
      // and log the user out of every device. The client retries once the
      // winner finishes; the winner returns the freshly-rotated pair.
      throw new UnauthorizedException({
        code: 'refresh_in_flight',
        message: 'Session refresh in progress, please retry.',
      });
    }

    try {
      // Load unexpired rows INCLUDING revoked ones — reuse detection depends on
      // matching the presented token to an already-rotated row. Filtering
      // revokedAt: null here would silently turn a replay into a generic
      // "not found" and lose the signal.
      const candidates = await this.prisma.refreshToken.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });

      let matched: (typeof candidates)[number] | null = null;
      for (const row of candidates) {
        if (await argon2.verify(row.tokenHash, rawRefreshToken)) {
          matched = row;
          break;
        }
      }
      if (!matched) {
        throw new UnauthorizedException({
          code: 'refresh_invalid_or_expired',
          message: 'Session expired. Please sign in again.',
        });
      }

      if (matched.revokedAt) {
        // REUSE DETECTED — an already-rotated token was presented again. Either
        // the user's device cloned state or an attacker captured an old token.
        // Revoke every active token in the family to force a clean re-auth.
        // (Note: with the in-flight lock above, this can no longer be triggered
        // by a benign sub-second race; reaching here means the token was
        // genuinely revoked > 5s ago.)
        await this.prisma.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        this.logger.warn(
          { event: 'refresh_reuse_detected', userId, role },
          'Refresh token reuse detected — token family revoked',
        );
        throw new UnauthorizedException({
          code: 'refresh_reuse_detected',
          message: 'Session compromised. Please sign in again.',
        });
      }

      return await this.signTokens(userId, role, matched.id);
    } finally {
      // Release on every exit — success, refresh_invalid_or_expired, or
      // refresh_reuse_detected. The natural 5s TTL is the safety net for
      // a hard kill mid-rotation. Holding the lock past success buys
      // nothing: the row is now revokedAt != null, so a true replay > 5s
      // later still trips reuse detection legitimately.
      await this.redis.del(lockKey);
    }
  }

  private async signTokens(userId: string, role: UserRole, replacesTokenId?: string) {
    const accessTtl = this.env.jwtAccessTtl as `${number}${'s' | 'm' | 'h' | 'd'}`;
    const refreshTtl = this.env.jwtRefreshTtl as `${number}${'s' | 'm' | 'h' | 'd'}`;
    // Unique JWT IDs per token. Without `jti`, two tokens minted in the same
    // second for the same user produce identical signatures (`iat` is second-
    // resolution) — which makes Story 1.2's rotation indistinguishable from
    // no-op. `jti` also gives us a stable handle for per-session audit logs.
    const accessJti = randomUUID();
    const refreshJti = randomUUID();
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { sub: userId, role },
        { secret: this.env.jwtAccessSecret, expiresIn: accessTtl, jwtid: accessJti },
      ),
      this.jwt.signAsync(
        { sub: userId, role },
        { secret: this.env.jwtRefreshSecret, expiresIn: refreshTtl, jwtid: refreshJti },
      ),
    ]);

    const refreshTokenHash = await argon2.hash(refreshToken);
    const expiresAt = new Date(Date.now() + parseDurationMs(refreshTtl));

    // Insert-new + revoke-old must be atomic. Without the transaction a crash
    // mid-rotation can leave the user with two valid tokens (both readable in
    // the candidates query) or zero (locked out until the surviving access
    // token expires).
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.refreshToken.create({
        data: { userId, tokenHash: refreshTokenHash, expiresAt },
      });
      if (replacesTokenId) {
        await tx.refreshToken.update({
          where: { id: replacesTokenId },
          data: { revokedAt: new Date(), replacedBy: row.id },
        });
      }
    });

    return { accessToken, refreshToken };
  }

  /**
   * Generate a 6-digit OTP using the OS CSPRNG. `randomInt` reads from
   * /dev/urandom (Linux) / BCryptGenRandom (Windows) via Node's `crypto`
   * module — unpredictable even with arbitrarily many prior outputs
   * observed. Math.random (V8 xorshift128+) is NOT acceptable here:
   * successful OTP verification issues a JWT pair and lets the caller
   * impersonate the phone number's account, so a predictable code is a
   * direct path to account takeover.
   */
  /**
   * Phase B1 — single-device logout. Revokes the refresh-token row that
   * matches the presented raw token (argon2 verify against the hashes,
   * same scan-then-match pattern as `refresh`). Returns silently if the
   * token doesn't match any row — the cookie still gets cleared by the
   * controller so the client ends up logged out either way.
   *
   * Note: this does NOT call `JwtRevocationService.revokeUser` because
   * that's a wider hammer (logs the user out of every device). Standard
   * logout intent is "this device only" — invalidate one refresh row and
   * let the 15-min access token age out.
   */
  async logout(rawRefreshToken: string): Promise<void> {
    // Decode-only — no signature check needed; we're not authorizing, just
    // looking up which row to revoke. A bogus token finds nothing and
    // no-ops.
    let userId: string;
    try {
      const decoded = await this.jwt.verifyAsync<{ sub: string }>(rawRefreshToken, {
        secret: this.env.jwtRefreshSecret,
      });
      userId = decoded.sub;
    } catch (err) {
      // Expired or malformed token — nothing to revoke; cookie clears on
      // the controller side anyway.
      this.logger.debug(
        { event: 'auth_logout_verify_failed', error: String(err) },
        'Logout received an unverifiable refresh token — clearing cookie only',
      );
      return;
    }

    const candidates = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null },
    });
    for (const row of candidates) {
      if (await argon2.verify(row.tokenHash, rawRefreshToken)) {
        await this.prisma.refreshToken.update({
          where: { id: row.id },
          data: { revokedAt: new Date() },
        });
        this.logger.info(
          { event: 'auth_logout', userId, tokenId: row.id },
          'Refresh token revoked on logout',
        );
        return;
      }
    }
  }

  /**
   * Cookie Max-Age in seconds — derived from JWT_REFRESH_TTL so the
   * cookie expiry matches the JWT expiry. Used by the controller to
   * set the chopnow_rt cookie. Parsed from the env string at boot
   * (parseDurationMs is the same helper signTokens uses).
   */
  refreshCookieMaxAgeSeconds(): number {
    const ttl = this.env.jwtRefreshTtl as `${number}${'s' | 'm' | 'h' | 'd'}`;
    return Math.floor(parseDurationMs(ttl) / 1000);
  }

  private generateCode(): string {
    if (this.env.nodeEnv === 'test') return '000000';
    const n = randomInt(0, 1_000_000);
    return n.toString().padStart(6, '0');
  }
}
