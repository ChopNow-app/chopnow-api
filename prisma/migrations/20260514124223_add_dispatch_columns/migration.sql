-- Story 4.1 — rider online + last-location for dispatch matching.
-- Story 4.4 — heartbeat timestamp; UI shows "position momentanément
-- indisponible" when older than 60s.
ALTER TABLE "riders" ADD COLUMN "isOnline"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "riders" ADD COLUMN "lastLocation" geography(Point, 4326);
ALTER TABLE "riders" ADD COLUMN "lastSeenAt"   TIMESTAMP(3);

CREATE INDEX "riders_isOnline_idx" ON "riders" ("isOnline");
-- GIST index for radius queries (ST_DWithin).
CREATE INDEX "riders_lastLocation_idx" ON "riders" USING GIST ("lastLocation");

-- Story 4.1 — order ↔ rider assignment.
ALTER TABLE "orders" ADD COLUMN "riderId"    TEXT;
ALTER TABLE "orders" ADD COLUMN "assignedAt" TIMESTAMP(3);

CREATE INDEX "orders_riderId_idx" ON "orders" ("riderId");

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
