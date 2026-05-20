import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../infra/prisma/prisma.service';

// Per ADR-0005 §S3 / chopnow-api#213. Flags Orders stuck in PICKED_UP
// past the threshold — the "rider scanned pickup but never delivered"
// fraud or operational-incident signal.
//
// No automatic state mutation. Detection only — the admin investigation
// endpoint (AdminRiderFraudController.resolveRiderFraud) is the actor
// that decides resolution.

const STUCK_THRESHOLD_MINUTES = 120; // 2h
const MAX_FLAGS_PER_RUN = 100;

@Injectable()
export class StuckPickupDetectorService {
  constructor(
    @InjectPinoLogger(StuckPickupDetectorService.name) private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweepStuckPickups(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - STUCK_THRESHOLD_MINUTES * 60_000);

    const stuck = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PICKED_UP,
        pickedUpAt: { lt: cutoff },
      },
      orderBy: { pickedUpAt: 'asc' },
      take: MAX_FLAGS_PER_RUN,
      select: {
        id: true,
        code: true,
        vendorId: true,
        riderId: true,
        userId: true,
        totalXAF: true,
        pickedUpAt: true,
      },
    });

    if (stuck.length === 0) {
      this.logger.info(
        {
          event: 'stuck_pickup_detector_completed',
          flagged: 0,
        },
        'stuck pickup detector completed — nothing flagged',
      );
      return;
    }

    for (const o of stuck) {
      const ageMs = o.pickedUpAt ? now.getTime() - o.pickedUpAt.getTime() : 0;
      this.logger.warn(
        {
          event: 'order_stuck_in_pickup',
          orderId: o.id,
          orderCode: o.code,
          vendorId: o.vendorId,
          riderId: o.riderId,
          userId: o.userId,
          totalXAF: o.totalXAF,
          minutesStuck: Math.floor(ageMs / 60_000),
        },
        'order stuck in PICKED_UP — needs admin investigation',
      );
    }

    this.logger.info(
      {
        event: 'stuck_pickup_detector_completed',
        flagged: stuck.length,
      },
      'stuck pickup detector completed',
    );
  }
}
