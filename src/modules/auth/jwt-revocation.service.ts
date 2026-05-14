import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../infra/redis/redis.service';
import { parseDurationMs } from '../../shared/time/duration.util';
import { EnvService } from '../../infra/config/env.service';

/**
 * Story 1.7 — Instant JWT revocation by user.
 *
 * The granularity is `userId`, not individual tokens. When an account is
 * suspended (Stories 6.2 / 6.8 / 6.9), every JWT issued to that user becomes
 * invalid on the next request — both access and refresh.
 *
 * Storage: a single Redis key per revoked user. TTL = the longest-lived
 * possible token (refresh TTL, typically 30d) so the key auto-purges once
 * every issued token has expired naturally. No manual cleanup job needed.
 *
 * Reactivation = delete the key. The next consumer login proceeds via OTP
 * as normal; admin users have to re-authenticate too (their old token's
 * lifetime overlaps the revocation key, so it remains rejected even after
 * deletion until they sign in fresh).
 */
const revokedKey = (userId: string) => `user:revoked:${userId}`;

@Injectable()
export class JwtRevocationService {
  private readonly logger = new Logger(JwtRevocationService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly env: EnvService,
  ) {}

  async revokeUser(userId: string): Promise<void> {
    // TTL aligns with the longest token TTL. Anything shorter risks a window
    // where a key is gone but tokens are still live; anything longer wastes
    // Redis memory after natural expiry.
    const ttlSeconds = Math.ceil(parseDurationMs(this.env.jwtRefreshTtl) / 1000);
    await this.redis.setWithTTL(revokedKey(userId), '1', ttlSeconds);
    this.logger.warn(`Revoked all JWTs for user ${userId} (TTL ${ttlSeconds}s)`);
  }

  async reactivateUser(userId: string): Promise<void> {
    await this.redis.del(revokedKey(userId));
    this.logger.log(`Cleared JWT revocation for user ${userId}`);
  }

  async isRevoked(userId: string): Promise<boolean> {
    const value = await this.redis.get(revokedKey(userId));
    return value !== null;
  }
}
