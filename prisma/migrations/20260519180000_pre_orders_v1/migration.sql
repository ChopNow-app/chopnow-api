-- Feature #187 — pre-orders for INFORMAL vendors (v1).
-- Additive migration: nullable Order.scheduledFor column, default-false
-- Vendor.acceptsPreOrders flag, new VendorPenalty ledger table, and a new
-- REFUND_PENDING enum value on PaymentStatus.

-- 1. PaymentStatus.REFUND_PENDING — vendor pre-order cancel-after-accept
--    flips the order here; Story 3.8 (Campay refund API) sweeps to REFUNDED.
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUND_PENDING' BEFORE 'REFUNDED';

-- 2. Vendor.acceptsPreOrders — per-vendor gate. Default false; VendorService.submit
--    sets it to true for new type=INFORMAL submissions. Admin can flip per-vendor.
ALTER TABLE "vendors" ADD COLUMN "acceptsPreOrders" BOOLEAN NOT NULL DEFAULT false;

-- 2a. One-shot backfill: existing INFORMAL vendors already in the DB get the
--     same default the new-submission code path applies. Without this, vendors
--     onboarded before this migration would silently stay opted out.
UPDATE "vendors" SET "acceptsPreOrders" = true WHERE "type" = 'INFORMAL';

-- 3. Order.scheduledFor — null = immediate (today's flow). Set = pre-order;
--    PreOrderPromotionService promotes at scheduledFor - 60min.
ALTER TABLE "orders" ADD COLUMN "scheduledFor" TIMESTAMP(3);
CREATE INDEX "orders_scheduledFor_idx" ON "orders"("scheduledFor");
CREATE INDEX "orders_vendorId_scheduledFor_idx" ON "orders"("vendorId", "scheduledFor");

-- 4. VendorPenalty ledger — created when a vendor cancels a pre-order
--    AFTER accepting. Story 7.x reads unsettled rows and nets against payouts.
CREATE TYPE "VendorPenaltyReason" AS ENUM ('PRE_ORDER_VENDOR_CANCEL_AFTER_ACCEPT');

CREATE TABLE "vendor_penalties" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reason" "VendorPenaltyReason" NOT NULL,
    "amountXAF" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "vendor_penalties_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendor_penalties_orderId_key" ON "vendor_penalties"("orderId");
CREATE INDEX "vendor_penalties_vendorId_settledAt_idx" ON "vendor_penalties"("vendorId", "settledAt");

ALTER TABLE "vendor_penalties"
  ADD CONSTRAINT "vendor_penalties_vendorId_fkey" FOREIGN KEY ("vendorId")
  REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "vendor_penalties"
  ADD CONSTRAINT "vendor_penalties_orderId_fkey" FOREIGN KEY ("orderId")
  REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
