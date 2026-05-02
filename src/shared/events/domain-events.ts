/**
 * Domain event names — single source of truth for cross-module fan-out.
 *
 * Producers emit events via NestJS EventEmitter2; consumers subscribe with @OnEvent.
 * When a module is later extracted to its own service, these names become the
 * pub/sub topic / queue name — keep them stable.
 */
export const DomainEvents = {
  // Auth
  USER_REGISTERED: 'user.registered',
  USER_SUSPENDED: 'user.suspended',
  USER_REACTIVATED: 'user.reactivated',

  // Orders
  ORDER_CREATED: 'order.created',
  ORDER_PAID: 'order.paid',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_DELIVERED: 'order.delivered',
  ORDER_DISPUTED: 'order.disputed',

  // Dispatch
  RIDER_ASSIGNED: 'rider.assigned',
  RIDER_ARRIVED_PICKUP: 'rider.arrived_pickup',
  RIDER_ARRIVED_DROPOFF: 'rider.arrived_dropoff',
  RIDER_OFFLINE_MID_DELIVERY: 'rider.offline_mid_delivery',

  // Payments
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',

  // Vendor
  VENDOR_VALIDATED: 'vendor.validated',
  VENDOR_REJECTED: 'vendor.rejected',
  VENDOR_OFFLINE: 'vendor.offline',
} as const;

export type DomainEventName = (typeof DomainEvents)[keyof typeof DomainEvents];
