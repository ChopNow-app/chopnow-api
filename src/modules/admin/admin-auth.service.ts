import { randomUUID } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { UserRole } from '@prisma/client';
import { EnvService } from '../../infra/config/env.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

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

const attemptsKey = (userId: string) => `admin:login-attempts:${userId}`;
const lockedKey = (userId: string) => `admin:locked:${userId}`;

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
  ) {}

  async login(
    email: string,
    password: string,
  ): Promise<{
    accessToken: string;
    role: UserRole;
    email: string;
    expiresIn: number;
  }> {
    const normalized = email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    // Reject early but with the same shape as a wrong password — never leak
    // whether an email exists.
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
        // Lock with no TTL — only a super-admin unlock clears this key.
        await this.redis.client.set(lockedKey(user.id), '1');
        this.logger.warn(`Admin account locked after ${attempts} attempts: ${user.id}`);
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

    // Success — reset the counter so future typos don't lock a returning admin
    // who got it wrong once.
    await this.redis.del(attemptsKey(user.id));

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role },
      {
        secret: this.env.jwtAccessSecret,
        // 8h override — admin sessions are stricter than the 24h consumer default.
        expiresIn: ADMIN_SESSION_TTL,
        jwtid: randomUUID(),
      },
    );

    return {
      accessToken,
      role: user.role,
      email: normalized,
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
