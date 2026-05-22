import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DispatchService } from './dispatch.service';
import {
  DISPATCH_RETRY_JOB,
  DISPATCH_RETRY_QUEUE,
  type DispatchRetryJobData,
} from './dispatch-retry.constants';

/**
 * BullMQ worker that resumes a dispatch retry after the scheduled delay.
 *
 * Replaces the in-process `setTimeout` previously held in a Map inside
 * DispatchService. Survives node restarts, can be consumed by any API
 * instance — fixes the "single node = single point of failure" gap flagged
 * in dispatch.service.ts pre-PR.
 *
 * Idempotency is delegated to DispatchService.runRetry(), which re-checks
 * the order's current state (riderId/status) before doing anything — so a
 * job that fires after the order was assigned through another path simply
 * no-ops.
 *
 * `attempts: 1` on the enqueue side: the dispatch retry semantics ARE the
 * job content (10 attempts × 30s scheduled by the service itself); having
 * BullMQ also retry would double-count. A worker exception just leaves the
 * job in the failed lane for inspection.
 */
@Processor(DISPATCH_RETRY_QUEUE)
export class DispatchRetryProcessor extends WorkerHost {
  constructor(
    @InjectPinoLogger(DispatchRetryProcessor.name) private readonly logger: PinoLogger,
    private readonly dispatch: DispatchService,
  ) {
    super();
  }

  async process(job: Job<DispatchRetryJobData>): Promise<void> {
    if (job.name !== DISPATCH_RETRY_JOB) {
      this.logger.warn(
        { event: 'dispatch_retry_unknown_job', jobName: job.name, jobId: job.id },
        'Unknown job name on dispatch-retry queue — ignoring',
      );
      return;
    }
    const { orderId, vendorId, attempt } = job.data;
    this.logger.info(
      { event: 'dispatch_retry_processing', orderId, vendorId, attempt, jobId: job.id },
      'Processing scheduled dispatch retry',
    );
    await this.dispatch.runRetry(orderId, vendorId, attempt);
  }
}
