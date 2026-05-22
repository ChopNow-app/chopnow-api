/**
 * BullMQ queue + job names for the dispatch-retry path. Centralised so the
 * service that enqueues and the processor that consumes can't drift.
 */
export const DISPATCH_RETRY_QUEUE = 'dispatch-retry';
export const DISPATCH_RETRY_JOB = 'tryDispatch';

export interface DispatchRetryJobData {
  orderId: string;
  vendorId: string;
  /**
   * 0-indexed attempt counter. The processor calls `tryDispatch(...)` with
   * this value; `tryDispatch` itself handles the "did we hit MAX_RETRIES"
   * decision.
   */
  attempt: number;
}
