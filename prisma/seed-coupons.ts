/**
 * Seed the pilot promo coupon(s) (#167).
 *
 * Today this only seeds BIENVENUE — the launch offer: free delivery on
 * the first MoMo order. The founder mints additional codes from a
 * future admin UI, but for the launch we hard-code this one because:
 *   1. The /restaurants splash promo banner advertises it by literal name
 *   2. Engineering needs the row to exist BEFORE pilot users start
 *      placing orders, so a typo in an admin form can't break the funnel
 *
 * Usage:
 *   npx ts-node prisma/seed-coupons.ts
 *
 * Idempotent — re-running upserts the BIENVENUE row in place, useful
 * for rotating the validity window after re-launch.
 */
import { PrismaClient, CouponStatus, CouponType } from '@prisma/client';

const prisma = new PrismaClient();

interface CouponSeed {
  code: string;
  description: string;
  type: CouponType;
  valueXAF?: number;
  validFrom?: Date;
  validUntil?: Date;
  minSubtotalXAF?: number;
  firstOrderOnly?: boolean;
  maxPerUser?: number;
  maxRedemptions?: number;
}

const PILOT_COUPONS: CouponSeed[] = [
  {
    code: 'BIENVENUE',
    description: 'Livraison gratuite pour ta première commande',
    type: CouponType.FREE_DELIVERY,
    // No minimum subtotal — we want first-order conversion at any
    // basket size during pilot Week 1-4.
    minSubtotalXAF: undefined,
    firstOrderOnly: true,
    maxPerUser: 1,
    // No global cap during pilot — every first-time consumer should
    // get it. Switch to a finite cap when we run a paid campaign.
    maxRedemptions: undefined,
  },
];

async function main(): Promise<void> {
  for (const seed of PILOT_COUPONS) {
    const upserted = await prisma.coupon.upsert({
      where: { code: seed.code },
      create: {
        code: seed.code,
        description: seed.description,
        type: seed.type,
        valueXAF: seed.valueXAF ?? 0,
        status: CouponStatus.ACTIVE,
        validFrom: seed.validFrom ?? null,
        validUntil: seed.validUntil ?? null,
        minSubtotalXAF: seed.minSubtotalXAF ?? null,
        firstOrderOnly: seed.firstOrderOnly ?? true,
        maxPerUser: seed.maxPerUser ?? 1,
        maxRedemptions: seed.maxRedemptions ?? null,
      },
      update: {
        description: seed.description,
        type: seed.type,
        valueXAF: seed.valueXAF ?? 0,
        status: CouponStatus.ACTIVE,
        validFrom: seed.validFrom ?? null,
        validUntil: seed.validUntil ?? null,
        minSubtotalXAF: seed.minSubtotalXAF ?? null,
        firstOrderOnly: seed.firstOrderOnly ?? true,
        maxPerUser: seed.maxPerUser ?? 1,
        maxRedemptions: seed.maxRedemptions ?? null,
      },
    });
    console.log(
      `[seed-coupons] upserted ${upserted.code} (${upserted.type}, status=${upserted.status})`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
