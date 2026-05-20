-- Refund flow fields on Order (ADR-0005 S3, #90).
-- RefundProcessor uses refundInitiatedAt as the worker lock and
-- refundCampayRef as the success indicator. Webhook flips paymentStatus
-- to REFUNDED and stamps refundedAt.

ALTER TABLE "orders"
  ADD COLUMN "refundInitiatedAt"  TIMESTAMP(3),
  ADD COLUMN "refundCampayRef"    TEXT,
  ADD COLUMN "refundedAt"         TIMESTAMP(3),
  ADD COLUMN "refundFailureReason" TEXT;

-- Unique-when-set so a Campay reference maps to exactly one Order.
-- Webhook handler looks up by this column.
CREATE UNIQUE INDEX "orders_refundCampayRef_key"
  ON "orders" ("refundCampayRef") WHERE "refundCampayRef" IS NOT NULL;
