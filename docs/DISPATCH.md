# Dispatch — pilot runbook

The dispatch system matches an order to a rider. This doc is the operational
ground truth: how it works today, how to read the admin metrics, and what to
do when something looks off.

## How the algorithm picks a rider

1. **Trigger**: vendor accepts an order. `DomainEvents.ORDER_ACCEPTED` fires.
2. **Query**: single PostGIS roundtrip — find the closest online rider
   inside their vehicle's radius from the vendor.
   - `ON_FOOT` 1 km · `BICYCLE` 3 km · `MOTO` 7 km · `CAR` 10 km
   - Rider must be `ACTIVE`, `isOnline = true`, heartbeat fresh (≤ 60 s).
3. **Tie-breaker**: `ORDER BY distance_m ASC, "lastAssignedAt" ASC NULLS FIRST`.
   When two riders are equally close, the one who was assigned longer ago
   wins. Riders never assigned yet rank ahead of recently-assigned ones.
4. **Atomic assign**: `UPDATE orders SET riderId=... WHERE id=... AND riderId IS NULL`.
   Concurrency-safe — two simultaneous dispatchers can't both grab the
   same order.
5. **Audit row**: write a `DispatchEvent` (`ASSIGNED` / `NO_CANDIDATE` /
   `RACE_LOST`) for every attempt. This is the data backing the admin
   funnel tile.
6. **Retry**: if no candidate, schedule another attempt in 30 s. Up to
   10 attempts total (≈ 5 min). After that, order → `EXPIRED`,
   `refusalReason = NO_RIDER_AVAILABLE`, automatic refund if paid.

## Admin dispatch funnel

`/admin/metrics` exposes per-window:

| Metric                                      | Healthy                       | Watch for                          |
| ------------------------------------------- | ----------------------------- | ---------------------------------- |
| `ordersAssigned`                            | matches the day's order count | gap = orders that expired          |
| `assignedOnFirstAttempt` / `ordersAssigned` | > 85 %                        | < 70 % = rider density too thin    |
| `avgAttemptsToAssign`                       | ≤ 1.3                         | > 2 = consistent retry needed      |
| `expiredNoRider`                            | 0                             | any non-zero needs op intervention |
| `topRiders[0].offers / total`               | < 50 % at 3-rider pilot       | > 70 % = starved-rider pathology   |

## When you see a problem

### One rider has > 70 % of offers (`topRiders[0]`)

The "starved rider" pathology. The tie-breaker handles equal-distance
ties, but if rider A is genuinely the closest to most active vendors,
they get the work and others sit idle. Operational fix: tell the idle
riders to reposition into the active vendor's quartier; or temporarily
take rider A offline to redistribute.

### `expiredNoRider > 0`

Either no rider was online in that quartier-vendor radius, or all riders
were heartbeat-stale (off for ≥ 60 s). Check `Rider.lastSeenAt` for
candidates the dispatch query should have found but didn't. Most
common: a rider went online then put their phone in standby — the
heartbeat stops.

Quick recovery: call the rider to come back online; manually use the
admin stuck-pickup tool to reassign if the order is still recoverable.

### `avgAttemptsToAssign > 2`

The dispatch is finding riders eventually but not on the first try.
Usually means the closest rider is busy or going stale right after
acceptance. Pilot fix: more riders online in the busy quartier.
Engineering fix (post-pilot): exclude riders with active in-flight
courses from the candidate pool (see "Known gaps" below).

## Known gaps (deliberately deferred — pilot scope)

1. **Riders with active courses can be re-assigned.** Today the SQL
   doesn't filter `WHERE riderId NOT IN (active orders)`. At 3 pilot
   riders + 50 orders/day this is unlikely to bite, but at scale it
   needs the exclusion.
2. **No score-based dispatch.** Story 4.1 specs "40 % proximity + 40 %
   reliability + 20 % acceptance rate" — today's algo is pure
   proximity. Building the score needs ≥ 2 weeks of `DispatchEvent`
   data first, which is exactly what this PR makes possible.
3. **No top-N broadcast.** Spec calls for parallel offers to the top 3
   riders. At 3 active riders that's just "offer to everyone" — wrong
   pattern. Revisit at ~10+ active riders per zone.
4. **No surge pricing or zone coefficients on the delivery fee.** Flat
   formula today (`250 + 100 × km`, floored at 500 FCFA, capped at
   1 500 FCFA). Surge + zone are documented for v2; revisit with real
   peak-vs-off-peak data.

## Database

| Table                   | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `riders.lastLocation`   | PostGIS `geography(POINT, 4326)`, updated every 15 s by the heartbeat |
| `riders.lastSeenAt`     | Last heartbeat timestamp; staleness cutoff for dispatch               |
| `riders.lastAssignedAt` | Round-robin tie-breaker stamp (this PR)                               |
| `dispatch_events`       | Append-only audit of every dispatch attempt's outcome (this PR)       |

## Code pointers

| File                                         | Lines                   | What                                               |
| -------------------------------------------- | ----------------------- | -------------------------------------------------- |
| `src/modules/dispatch/dispatch.service.ts`   | 65–76                   | `@OnEvent(ORDER_ACCEPTED)` entry point             |
| same                                         | 230–270                 | PostGIS `ST_Distance` + `ST_DWithin` query         |
| same                                         | 10–15                   | Vehicle radius constants                           |
| same                                         | 78–127                  | Retry loop (30 s × 10 attempts)                    |
| same                                         | 145–195                 | `expireForNoRider` — terminal state + refund event |
| same                                         | 80–112                  | `logDispatchEvent` — append-only audit             |
| `src/shared/pricing/delivery-fee.util.ts`    | 21–27                   | Fee formula                                        |
| `src/modules/admin/admin-metrics.service.ts` | `computeDispatchFunnel` | Admin tile data                                    |
