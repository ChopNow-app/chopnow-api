import { OrderStatus } from '@prisma/client';

// Story 3.1 — minimum order to protect margin (≤ 1200 FCFA generates ~26 FCFA
// net, near loss). Hard-coded for MVP; surface as an admin config later.
export const MIN_ORDER_XAF = 1200;

// Vendor acceptance SLA — Order.acceptanceDeadlineAt is set to placedAt +
// this many seconds at order creation. The UI counts down to that absolute
// deadline (not from-now), so the vendor sees the same remaining time even
// after a tab reload. 60s is humane vs the prototype's 40s while still
// keeping consumer wait short. The OrdersExpiryService auto-refuses past
// this with reason EXPIRED_NO_VENDOR_RESPONSE.
export const ACCEPTANCE_TTL_SECONDS = 60;

// Pre-orders (#187 — INFORMAL vendors only).
// Minimum lead time between order placement and scheduledFor. Set conservatively
// to the same value as the default cancellation cutoff — a pre-order placed
// inside that window wouldn't give the vendor enough room to prep.
export const PRE_ORDER_MIN_LEAD_HOURS = 4;
// Maximum lead time: 24h ahead of `now` (v1.1 day-ahead). The frontend day
// toggle exposes "Aujourd'hui / Demain" within this window. Multi-day (T+N)
// is v2 — bumping this to e.g. 7 * 24 would technically work but the UX
// changes substantially.
export const PRE_ORDER_MAX_LEAD_HOURS = 24;
// How early before scheduledFor the promotion cron flips the order to "vendor
// must decide" — sets acceptanceDeadlineAt and emits ORDER_CREATED.
export const PRE_ORDER_NOTIFICATION_LEAD_MINUTES = 60;
// Vendor penalty for cancel-after-accept: 10% of totalXAF rounded down to the
// nearest 50 FCFA (currency tick on the Cameroon market).
export const PRE_ORDER_PENALTY_RATE = 0.1;
export const PRE_ORDER_PENALTY_ROUND_TO_XAF = 50;

// Status sets — keep transition gates explicit so a bug in one branch can't
// silently teleport an order past the wrong gate.
export const VENDOR_CAN_DECIDE: ReadonlySet<OrderStatus> = new Set([
  // PENDING is only briefly visible — the window between order creation
  // and the Campay webhook flipping it to CONFIRMED. Kept here so a
  // vendor seeing a stale PENDING row (slow webhook) can still accept it.
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED, // MoMo flow after webhook — the normal case
]);
export const CONSUMER_CAN_CANCEL: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
]);

/**
 * Story 3.17 — vendor-side phone masking helper. Keeps the country code
 * + last 2 digits so the vendor can roughly recognize the number on a
 * callback ringing, but strips the bypass-prone middle.
 * Input: '+237670000099' → '+237 6•• ••• •99'. Falsy input stays falsy.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return phone ?? '';
  const trimmed = phone.trim();
  if (trimmed.length < 6) return '••••••';
  const last2 = trimmed.slice(-2);
  // For +237XXXXXXXXX show '+237 6•• ••• •XX'; for anything else just
  // show last-2 + dots.
  if (trimmed.startsWith('+237') && trimmed.length >= 11) {
    return `+237 ${trimmed[4]}•• ••• •${last2}`;
  }
  return `${trimmed.slice(0, 2)}•••••${last2}`;
}

export interface DistanceRow {
  distance_m: number;
}
