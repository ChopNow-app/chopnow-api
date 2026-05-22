// Single source of truth for delivery-fee computation.
//
// Story 2.5 (browse cards) and Story 3.1 (cart total) both need this — keep
// the formula here so a tweak doesn't drift between the catalogue preview and
// the actual order total. Story 3.19 v2 adds surge + zone coefficient on top
// of this base formula (deferred for MVP).
//
// Formula (v2 baseline — surge and zone TBD):
//   raw  = BASE + km × PER_KM
//   fee  = round_up_to_50( clamp(FLOOR, raw, CAP) )
//
// XAF is rounded to whole units (5 FCFA is the smallest market coin, but we
// only emit multiples of 50 to make change-counting easy at the door).

export const DELIVERY_BASE_FEE_XAF = 250;
export const DELIVERY_PER_KM_XAF = 100; // moto baseline; Story 3.19 v2 per-vehicle
// Rider-sustainability floor. At 350 the rider got 227 FCFA on a sub-1km
// trip — below per-minute operating cost. 500 floor → rider gets 325 FCFA,
// which sustains short trips and prevents rider attrition during the pilot.
// Worth revisiting after the pilot when there's actual margin data.
export const DELIVERY_FEE_FLOOR_XAF = 500;
export const DELIVERY_FEE_CAP_XAF = 1500;
export const ROUND_TO_XAF = 50;

export function computeDeliveryFeeXAF(distanceKm: number): number {
  const raw = DELIVERY_BASE_FEE_XAF + distanceKm * DELIVERY_PER_KM_XAF;
  const clamped = Math.min(DELIVERY_FEE_CAP_XAF, Math.max(DELIVERY_FEE_FLOOR_XAF, raw));
  // Always round UP to the next 50 — the "gain invisible" the business model
  // calls out in Story 3.1.
  return Math.ceil(clamped / ROUND_TO_XAF) * ROUND_TO_XAF;
}
