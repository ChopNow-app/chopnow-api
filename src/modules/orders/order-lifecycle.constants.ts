/**
 * BullMQ queue + job names for time-based order lifecycle transitions.
 *
 * Today this powers two delayed jobs:
 *   - expire-vendor-decision : fires at Order.acceptanceDeadlineAt → flips
 *                              PENDING/CONFIRMED to REFUSED with reason
 *                              EXPIRED_NO_VENDOR_RESPONSE.
 *   - promote-pre-order      : fires at scheduledFor - lead → sets
 *                              acceptanceDeadlineAt + emits ORDER_CREATED.
 *
 * Both replace the precise path that the @nestjs/schedule polling crons
 * (OrdersExpiryService, PreOrderPromotionService) currently provide. The
 * crons stay running as safety nets — if Redis loses a delayed job (e.g.
 * a redeploy clears Docker volumes), the next cron sweep catches the order.
 */
export const ORDER_LIFECYCLE_QUEUE = 'order-lifecycle';

export const EXPIRE_VENDOR_DECISION_JOB = 'expire-vendor-decision';
export const PROMOTE_PRE_ORDER_JOB = 'promote-pre-order';

export interface ExpireVendorDecisionJobData {
  orderId: string;
}

export interface PromotePreOrderJobData {
  orderId: string;
}

export type OrderLifecycleJobData = ExpireVendorDecisionJobData | PromotePreOrderJobData;
