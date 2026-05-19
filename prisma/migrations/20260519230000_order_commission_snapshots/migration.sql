-- Per-order commission snapshot fields + type-aware vendor commission backfill.
-- ADR-0005 §Data model. Closes the latent bug where INFORMAL vendors were
-- silently set to 10% commission instead of the business-model-mandated 6%.

-- =====================================================================
-- 1) Order — new snapshot columns
-- =====================================================================

-- commissionRate is the rate effective at order creation. Required (NOT
-- NULL), but we add it nullable first, backfill from the vendor, then SET
-- NOT NULL. Decimal(5,4) matches Vendor.commissionRate (e.g. 0.0600).
ALTER TABLE "orders"
  ADD COLUMN "commissionRate"  DECIMAL(5,4),
  ADD COLUMN "commissionXAF"   INTEGER,
  ADD COLUMN "riderShareXAF"   INTEGER,
  ADD COLUMN "platformFeeXAF"  INTEGER,
  ADD COLUMN "payoutId"        TEXT;

-- Backfill existing orders from the vendor's CURRENT rate. The pilot has
-- not launched, so this is approximate but safe — no historical money
-- has moved yet. New orders created after this migration get the correct
-- type-aware rate at creation time (vendor.service.ts:submit +
-- orders.service.ts:createOrder).
UPDATE "orders" o
   SET "commissionRate" = v."commissionRate"
  FROM "vendors" v
 WHERE o."vendorId" = v.id
   AND o."commissionRate" IS NULL;

ALTER TABLE "orders"
  ALTER COLUMN "commissionRate" SET NOT NULL;

-- =====================================================================
-- 2) Vendor — backfill type-aware defaults (the actual bug fix)
-- =====================================================================
-- The schema default of 0.10 silently over-charged every INFORMAL vendor
-- since the column was introduced. Pilot hasn't launched so no real money
-- has moved, but this aligns the existing rows with the business model.

UPDATE "vendors" SET "commissionRate" = 0.0600 WHERE type = 'INFORMAL'   AND "commissionRate" = 0.1000;
UPDATE "vendors" SET "commissionRate" = 0.1700 WHERE type = 'RESTAURANT' AND "commissionRate" = 0.1000;
-- SEMI_FORMAL is already 0.1000 = the type-correct default; no-op.

-- =====================================================================
-- 3) Indexes — payoutId is queried when reconciling settled batches
-- =====================================================================
CREATE INDEX "orders_payoutId_idx" ON "orders" ("payoutId");
