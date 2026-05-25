-- Coupon system (#167) — automated BIENVENUE first-order incentive.
--
-- Two new tables: `coupons` (catalogue rows the founder mints), and
-- `coupon_redemptions` (audit row written atomically alongside the
-- discounted Order). Plus two columns on `orders` to denormalize the
-- applied discount for display + reporting.
--
-- The race-stop is `coupon_redemptions_couponId_userId_key`: a single
-- user can't redeem the same coupon twice, even on concurrent submissions.

-- =====================================================================
-- Enums
-- =====================================================================
CREATE TYPE "CouponType" AS ENUM ('FREE_DELIVERY', 'FIXED_AMOUNT_OFF');
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- =====================================================================
-- coupons table
-- =====================================================================
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "CouponType" NOT NULL,
    "valueXAF" INTEGER NOT NULL DEFAULT 0,
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "minSubtotalXAF" INTEGER,
    "firstOrderOnly" BOOLEAN NOT NULL DEFAULT true,
    "maxPerUser" INTEGER NOT NULL DEFAULT 1,
    "maxRedemptions" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");
CREATE INDEX "coupons_status_idx" ON "coupons"("status");

-- =====================================================================
-- coupon_redemptions table
-- =====================================================================
CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "appliedDiscountXAF" INTEGER NOT NULL,
    "originalDeliveryFeeXAF" INTEGER,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

-- One redemption row per order (1:1 with Order — no stacking in v1).
CREATE UNIQUE INDEX "coupon_redemptions_orderId_key" ON "coupon_redemptions"("orderId");

-- The race-stop: same user + same coupon → unique violation on concurrent
-- redeems. Prisma surfaces this as P2002 which the service maps to the
-- domain error `coupon_already_redeemed`.
CREATE UNIQUE INDEX "coupon_redemptions_couponId_userId_key" ON "coupon_redemptions"("couponId", "userId");

CREATE INDEX "coupon_redemptions_userId_idx" ON "coupon_redemptions"("userId");
CREATE INDEX "coupon_redemptions_couponId_redeemedAt_idx" ON "coupon_redemptions"("couponId", "redeemedAt");

ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- orders — denormalized fields for display + analytics
-- =====================================================================
ALTER TABLE "orders" ADD COLUMN "discountXAF" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "couponCode" TEXT;
