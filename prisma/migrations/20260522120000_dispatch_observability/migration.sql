-- Dispatch observability — round-robin tie-breaker + per-attempt log.
--
-- The Rider.lastAssignedAt column powers the round-robin tie-breaker in
-- dispatch.service.ts: when two riders are equally close to a vendor,
-- whoever was assigned longer ago wins. Prevents the closest rider in a
-- zone from soaking up every order.
--
-- The dispatch_events table records every dispatchOrder() call's outcome.
-- Powers the admin "dispatch funnel" tile and gives us the signal we
-- need to design score-based dispatch v2 post-pilot.

-- 1) Rider tie-breaker column
ALTER TABLE "riders" ADD COLUMN "lastAssignedAt" TIMESTAMP(3);

-- 2) Dispatch outcome enum
CREATE TYPE "DispatchOutcome" AS ENUM ('ASSIGNED', 'NO_CANDIDATE', 'RACE_LOST');

-- 3) Dispatch events log (append-only)
CREATE TABLE "dispatch_events" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "outcome" "DispatchOutcome" NOT NULL,
  "riderId" TEXT,
  "vehicleType" "RiderVehicleType",
  "distanceM" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dispatch_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dispatch_events_orderId_createdAt_idx"
  ON "dispatch_events"("orderId", "createdAt");
CREATE INDEX "dispatch_events_riderId_createdAt_idx"
  ON "dispatch_events"("riderId", "createdAt");
CREATE INDEX "dispatch_events_createdAt_idx"
  ON "dispatch_events"("createdAt");

ALTER TABLE "dispatch_events"
  ADD CONSTRAINT "dispatch_events_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dispatch_events"
  ADD CONSTRAINT "dispatch_events_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "vendors"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dispatch_events"
  ADD CONSTRAINT "dispatch_events_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
