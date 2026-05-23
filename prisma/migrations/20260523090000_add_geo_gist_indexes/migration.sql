-- DB hardening — GIST spatial indexes on Vendor.location + Address.location.
--
-- Background: Rider.lastLocation already has a GIST index (dispatch needs it
-- for ST_DWithin / ST_Distance). Vendor and Address don't, which means:
--   - browse.service.ts ST_DWithin(vendor.location, ...) → table scan + filter
--   - order-creation.service.ts ST_Distance(vendor.location, delivery.location) → same
--
-- At pilot scale (3 vendors, ~50 addresses) the cost is microseconds and
-- the planner picks a sequential scan anyway. This migration sets us up
-- so the scan-then-filter pattern stays bounded as the dataset grows.
--
-- Not using CONCURRENTLY because:
--   - Tables are tiny at pilot deploy (locking for ~ms is fine)
--   - Prisma migrate deploy wraps each migration in a transaction by default,
--     and CREATE INDEX CONCURRENTLY can't run inside one. The existing
--     migrations in this repo all use plain CREATE INDEX for the same reason.

CREATE INDEX "vendors_location_idx" ON "vendors" USING GIST ("location");
CREATE INDEX "addresses_location_idx" ON "addresses" USING GIST ("location");
