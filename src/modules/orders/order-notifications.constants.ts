/**
 * BullMQ queue + job names for the order-notifications fan-out. Shared
 * between the producer (OrderNotificationsService) and worker
 * (OrderNotificationsProcessor) so the wire contract can't drift.
 */
export const ORDER_NOTIFICATIONS_QUEUE = 'order-notifications';

export const VENDOR_NEW_ORDER_JOB = 'vendor-new-order';
export const CONSUMER_ORDER_REFUSED_JOB = 'consumer-order-refused';

export interface VendorNewOrderJobData {
  orderId: string;
}

export interface ConsumerOrderRefusedJobData {
  orderId: string;
  reason: string;
}

export type OrderNotificationJobData = VendorNewOrderJobData | ConsumerOrderRefusedJobData;
