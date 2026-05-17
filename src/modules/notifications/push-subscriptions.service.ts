import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SubscribePushDto } from './dto/subscribe-push.dto';

/**
 * Thin DB layer over the PushSubscription table. The unique constraint is
 * (userId, deviceFingerprint) — the same physical device re-subscribing
 * (re-install, permission re-grant) updates its row in place instead of
 * leaving stale rows behind.
 *
 * The endpoint URL itself can change (browsers rotate them periodically) so
 * we treat it as updatable, not as the identity key.
 */
@Injectable()
export class PushSubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(userId: string, dto: SubscribePushDto): Promise<{ id: string }> {
    const row = await this.prisma.pushSubscription.upsert({
      where: {
        userId_deviceFingerprint: { userId, deviceFingerprint: dto.deviceFingerprint },
      },
      create: {
        userId,
        deviceFingerprint: dto.deviceFingerprint,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
      },
      update: {
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        lastUsedAt: new Date(),
      },
      select: { id: true },
    });
    return row;
  }

  async deactivateByEndpoint(userId: string, endpoint: string): Promise<void> {
    // Idempotent: 0 rows is fine — the client may have already revoked it,
    // or the row was cleaned up after a 410 Gone from the push service.
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  async deactivateById(id: string): Promise<void> {
    await this.prisma.pushSubscription.delete({ where: { id } }).catch(() => undefined); // race: row may already be gone
  }

  async listForUser(
    userId: string,
  ): Promise<Array<{ id: string; endpoint: string; p256dh: string; auth: string }>> {
    return this.prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  }
}
