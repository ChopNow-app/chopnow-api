-- Campay webhook dedup table (ADR-0005 S3, #88).
-- INSERT-first idempotency for Campay callbacks. The (eventType, reference)
-- unique constraint converts duplicate-webhook into a known-error path that
-- CampayWebhookDedupService handles as a no-op signal.

CREATE TYPE "CampayWebhookEventType" AS ENUM (
  'COLLECT',
  'TRANSFER',
  'REFUND'
);

CREATE TABLE "campay_webhook_events" (
  "id"          TEXT NOT NULL,
  "eventType"   "CampayWebhookEventType" NOT NULL,
  "reference"   TEXT NOT NULL,
  "payload"     JSONB NOT NULL,
  "result"      TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campay_webhook_events_pkey" PRIMARY KEY ("id")
);

-- Hot path: unique on (eventType, reference). Insert collision = duplicate.
CREATE UNIQUE INDEX "campay_webhook_events_eventType_reference_key"
  ON "campay_webhook_events" ("eventType", "reference");

CREATE INDEX "campay_webhook_events_eventType_processedAt_idx"
  ON "campay_webhook_events" ("eventType", "processedAt");
