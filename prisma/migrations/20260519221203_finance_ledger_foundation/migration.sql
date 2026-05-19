-- Finance ledger foundation (ADR-0005, S1 — milestone #5)
-- Adds the double-entry append-only ledger + vendor/rider payout tables.
-- No data backfill — empty tables. No service-layer consumers yet (those
-- land in 7.0b/7.0c and S2 follow-ups).

-- =====================================================================
-- Enums
-- =====================================================================

CREATE TYPE "LedgerAccount" AS ENUM (
  'CUSTOMER_ESCROW',
  'VENDOR_PAYABLE',
  'RIDER_PAYABLE',
  'PLATFORM_REVENUE',
  'PLATFORM_RESERVE',
  'CAMPAY_FLOAT',
  'REFUND_PAYABLE'
);

CREATE TYPE "LedgerEventType" AS ENUM (
  'PAYMENT_RECEIVED',
  'ORDER_DELIVERED',
  'REFUND_ISSUED',
  'VENDOR_PAYOUT',
  'RIDER_PAYOUT',
  'PENALTY_APPLIED',
  'ADJUSTMENT'
);

CREATE TYPE "PayoutStatus" AS ENUM (
  'PENDING',
  'IN_FLIGHT',
  'PAID',
  'FAILED',
  'CANCELLED'
);

-- =====================================================================
-- ledger_entries — append-only, double-entry
-- =====================================================================

CREATE TABLE "ledger_entries" (
  "id"          TEXT NOT NULL,
  "eventId"     TEXT NOT NULL,
  "eventType"   "LedgerEventType" NOT NULL,
  "account"     "LedgerAccount" NOT NULL,
  "amountXAF"   INTEGER NOT NULL,
  "orderId"     TEXT,
  "vendorId"    TEXT,
  "riderId"     TEXT,
  "payoutId"    TEXT,
  "refundId"    TEXT,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ledger_entries_eventId_idx"               ON "ledger_entries" ("eventId");
CREATE INDEX "ledger_entries_account_createdAt_idx"     ON "ledger_entries" ("account", "createdAt");
CREATE INDEX "ledger_entries_vendorId_createdAt_idx"    ON "ledger_entries" ("vendorId", "createdAt");
CREATE INDEX "ledger_entries_riderId_createdAt_idx"     ON "ledger_entries" ("riderId", "createdAt");
CREATE INDEX "ledger_entries_orderId_idx"               ON "ledger_entries" ("orderId");

-- amountXAF must never be zero (a no-op entry is a bug).
ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("amountXAF" <> 0);

-- =====================================================================
-- vendor_payouts
-- =====================================================================

CREATE TABLE "vendor_payouts" (
  "id"             TEXT NOT NULL,
  "vendorId"       TEXT NOT NULL,
  "periodStart"    TIMESTAMP(3) NOT NULL,
  "periodEnd"      TIMESTAMP(3) NOT NULL,
  "grossXAF"       INTEGER NOT NULL,
  "commissionXAF"  INTEGER NOT NULL,
  "penaltyXAF"     INTEGER NOT NULL DEFAULT 0,
  "adjustmentsXAF" INTEGER NOT NULL DEFAULT 0,
  "netXAF"         INTEGER NOT NULL,
  "momoPhone"      TEXT NOT NULL,
  "campayRef"      TEXT,
  "status"         "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "failureReason"  TEXT,
  "scheduledFor"   TIMESTAMP(3) NOT NULL,
  "sentAt"         TIMESTAMP(3),
  "paidAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vendor_payouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vendor_payouts_vendorId_fkey" FOREIGN KEY ("vendorId")
    REFERENCES "vendors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Idempotency: one payout per (vendor, period) — re-running the cron is safe.
CREATE UNIQUE INDEX "vendor_payouts_vendorId_periodStart_key"
  ON "vendor_payouts" ("vendorId", "periodStart");
CREATE UNIQUE INDEX "vendor_payouts_campayRef_key"
  ON "vendor_payouts" ("campayRef") WHERE "campayRef" IS NOT NULL;
CREATE INDEX "vendor_payouts_status_scheduledFor_idx"
  ON "vendor_payouts" ("status", "scheduledFor");

-- =====================================================================
-- rider_payouts
-- =====================================================================

CREATE TABLE "rider_payouts" (
  "id"             TEXT NOT NULL,
  "riderId"        TEXT NOT NULL,
  "periodStart"    TIMESTAMP(3) NOT NULL,
  "periodEnd"      TIMESTAMP(3) NOT NULL,
  "grossXAF"       INTEGER NOT NULL,
  "adjustmentsXAF" INTEGER NOT NULL DEFAULT 0,
  "netXAF"         INTEGER NOT NULL,
  "momoPhone"      TEXT NOT NULL,
  "campayRef"      TEXT,
  "status"         "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "failureReason"  TEXT,
  "scheduledFor"   TIMESTAMP(3) NOT NULL,
  "sentAt"         TIMESTAMP(3),
  "paidAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rider_payouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rider_payouts_riderId_fkey" FOREIGN KEY ("riderId")
    REFERENCES "riders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "rider_payouts_riderId_periodStart_key"
  ON "rider_payouts" ("riderId", "periodStart");
CREATE UNIQUE INDEX "rider_payouts_campayRef_key"
  ON "rider_payouts" ("campayRef") WHERE "campayRef" IS NOT NULL;
CREATE INDEX "rider_payouts_status_scheduledFor_idx"
  ON "rider_payouts" ("status", "scheduledFor");
