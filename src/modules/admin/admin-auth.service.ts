import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { UserRole } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { AdminTotpService } from './admin-totp.service';

const ADMIN_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.OPERATOR,
  UserRole.VIEWER,
]);

// Story 1.6 — lockout policy.
const LOCKOUT_WINDOW_SECONDS = 15 * 60;
const LOCKOUT_THRESHOLD = 5;
const ADMIN_SESSION_TTL = '8h';

// Phase A1 — 2FA challenge. Issued at successful password step, redeemed at
// the /admin/auth/2fa endpoint. 5-min TTL so a lost browser tab doesn't keep
// a half-finished login alive forever.
const TOTP_CHALLENGE_TTL_SECONDS = 5 * 60;

const attemptsKey = (userId: string) => `admin:login-attempts:${userId}`;
const lockedKey = (userId: string) => `admin:locked:${userId}`;
const challengeKey = (token: string) => `admin:2fa-challenge:${token}`;

export type LoginResult =
  | {
      stage: 'totp_required';
      challenge: string;
      challengeExpiresIn: number;
    }
  | {
      stage: 'success';
      accessToken: string;
      role: UserRole;
      email: string;
      expiresIn: number;
    };

@Injectable()
export class AdminAuthService {
  constructor(
    @InjectPinoLogger(AdminAuthService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
    private readonly totp: AdminTotpService,
  ) {}

  /**
   * Step 1 — password authentication.
   *
   * If the admin has confirmed TOTP enrollment, returns a `totp_required`
   * challenge that the client redeems at /admin/auth/2fa. No access token
   * is issued until the second factor is verified.
   *
   * Legacy admins without enrollment get an immediate access token (same
   * shape as pre-A1) so existing accounts don't break — the controller
   * exposes /admin/auth/2fa/setup to drive enrollment forward.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const normalized = email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (!user || !user.passwordHash || !ADMIN_ROLES.has(user.role)) {
      throw new UnauthorizedException({
        code: 'invalid_credentials',
        message: 'Email or password is incorrect.',
      });
    }

    if (await this.redis.get(lockedKey(user.id))) {
      throw new UnauthorizedException({
        code: 'account_locked',
        message: 'Account locked after too many failed attempts. Contact a super-admin to unlock.',
      });
    }

    const passwordValid = await argon2.verify(user.passwordHash, password);
    if (!passwordValid) {
      const attempts = await this.redis.incrWithTTL(attemptsKey(user.id), LOCKOUT_WINDOW_SECONDS);
      if (attempts >= LOCKOUT_THRESHOLD) {
        await this.redis.client.set(lockedKey(user.id), '1');
        this.logger.warn(
          { event: 'admin_account_locked', userId: user.id, email: normalized, attempts },
          'Admin account locked after too many failed attempts',
        );
        throw new UnauthorizedException({
          code: 'account_locked',
          message:
            'Account locked after too many failed attempts. Contact a super-admin to unlock.',
        });
      }
      throw new UnauthorizedException({
        code: 'invalid_credentials',
        message: 'Email or password is incorrect.',
      });
    }

    // Password OK — reset lockout counter.
    await this.redis.del(attemptsKey(user.id));

    // Phase A1: branch on TOTP enrollment.
    const totpEnrolled = await this.totp.isEnrolled(user.id);
    if (totpEnrolled) {
      const challenge = randomBytes(24).toString('base64url');
      await this.redis.setWithTTL(challengeKey(challenge), user.id, TOTP_CHALLENGE_TTL_SECONDS);
      this.logger.info(
        { event: 'admin_login_totp_challenge_issued', userId: user.id },
        'Admin login pending TOTP verification',
      );
      return {
        stage: 'totp_required',
        challenge,
        challengeExpiresIn: TOTP_CHALLENGE_TTL_SECONDS,
      };
    }

    // No TOTP yet — issue access token directly (legacy / first-login path).
    return this.issueAccessToken(user.id, user.role, normalized);
  }

  /**
   * Step 2 — redeem the challenge with either a TOTP code or a recovery code.
   * The challenge is single-use: success or wrong-code attempt deletes the
   * Redis key. (A wrong-code attempt forces the user back to step 1, which
   * is the right UX — they probably mistyped the password screen earlier.)
   */
  async verifyTotpChallenge(
    challenge: string,
    code: string,
    isRecoveryCode = false,
  ): Promise<LoginResult> {
    const userId = await this.redis.get(challengeKey(challenge));
    if (!userId) {
      throw new UnauthorizedException({
        code: 'totp_challenge_expired',
        message: 'Your sign-in has expired. Please log in again.',
      });
    }

    const ok = isRecoveryCode
      ? await this.totp.consumeRecoveryCode(userId, code)
      : await this.totp.verifyCode(userId, code);

    if (!ok) {
      // Don't consume the challenge on a wrong-code attempt — the admin's
      // app might just have shown a stale 30s code. The 5-min TTL bounds
      // total guess attempts naturally. Per-IP throttling at the controller
      // layer keeps brute force in check.
      throw new UnauthorizedException({
        code: 'totp_invalid_code',
        message: 'The code is incorrect or expired. Try the next one your app shows.',
      });
    }

    // Success — consume the challenge so it can't be replayed.
    await this.redis.del(challengeKey(challenge));

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException({
        code: 'invalid_credentials',
        message: 'Account no longer exists.',
      });
    }

    this.logger.info(
      { event: 'admin_login_totp_verified', userId, viaRecovery: isRecoveryCode },
      'Admin TOTP / recovery code verified',
    );
    return this.issueAccessToken(user.id, user.role, user.email ?? '');
  }

  private async issueAccessToken(
    userId: string,
    role: UserRole,
    email: string,
  ): Promise<LoginResult> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, role },
      {
        secret: this.env.jwtAccessSecret,
        // 8h override — admin sessions are stricter than the 24h consumer default.
        expiresIn: ADMIN_SESSION_TTL,
        jwtid: randomUUID(),
      },
    );
    return {
      stage: 'success',
      accessToken,
      role,
      email,
      expiresIn: 8 * 3600,
    };
  }

  /**
   * Manual unlock — exposed as a SUPER_ADMIN-only endpoint in Story 6.2.
   * Kept here so the admin module owns the lockout lifecycle even before that
   * endpoint exists (super-admin can call from a one-off REPL / script at launch).
   */
  async unlock(userId: string): Promise<void> {
    await this.redis.del(lockedKey(userId), attemptsKey(userId));
  }
}
