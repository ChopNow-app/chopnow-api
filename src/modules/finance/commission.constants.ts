import { VendorType } from '@prisma/client';

// Commission rates per vendor type — base rates only. Volume-tier
// step-downs (TchopNow Star, semi-formal >30 cmd/mo, restaurant >50/150)
// are deferred per ADR-0005 §Out of scope. Admin override on
// `Vendor.commissionRate` always wins.
//
// Source: business-model.md §6.
export const COMMISSION_RATE_BY_TYPE: Record<VendorType, number> = {
  [VendorType.INFORMAL]: 0.06,
  [VendorType.SEMI_FORMAL]: 0.1,
  [VendorType.RESTAURANT]: 0.17,
};

// Rider's share of the delivery fee. Platform keeps the remainder. See
// business-model.md §7.
export const RIDER_DELIVERY_SHARE = 0.65;
