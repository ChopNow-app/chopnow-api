-- Drop PaymentMethod.CASH — the COD product was abandoned 2026-05-18 in
-- favour of MoMo-only pilot. The application code stopped emitting CASH
-- by then, but the enum value lingered. Postgres can't drop a single
-- value from an enum in place; the canonical pattern is rename → create
-- new → cast column → drop old.

-- Safety check: refuse to migrate if any order still references CASH.
-- Should be impossible (no code path emits CASH for the last ~6 months),
-- but better to fail loudly than to corrupt data on the cast.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "paymentMethod" = 'CASH') THEN
    RAISE EXCEPTION 'orders still reference PaymentMethod.CASH — refuse to drop enum value. Update or delete those rows first.';
  END IF;
END $$;

-- Rename the old enum out of the way, create the new one with only the
-- two values we actually use, cast the column over, drop the old type.
ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_old";

CREATE TYPE "PaymentMethod" AS ENUM ('MTN_MOMO', 'ORANGE_MONEY');

ALTER TABLE "orders"
  ALTER COLUMN "paymentMethod" TYPE "PaymentMethod"
  USING ("paymentMethod"::text::"PaymentMethod");

DROP TYPE "PaymentMethod_old";
