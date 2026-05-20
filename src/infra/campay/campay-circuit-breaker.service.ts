import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

// Per ADR-0005 §S3 / chopnow-api#92. Circuit breaker around CampayService
// outbound calls — when Campay is degraded (5 consecutive failures across
// any method), we OPEN the breaker and fail-fast for OPEN_DURATION_MS.
// This stops worker crons from hammering a dead aggregator and surfacing
// hundreds of false-positive FAILED payouts.
//
// State machine:
//   CLOSED   — normal. Each call goes through; failures increment a
//              counter, success resets it. Threshold trip → OPEN.
//   OPEN     — any wrapped call throws `campay_circuit_open` immediately.
//              After OPEN_DURATION_MS the next call auto-promotes to
//              HALF_OPEN as a probe.
//   HALF_OPEN — one trial call allowed; success → CLOSED, failure → OPEN.
//
// Single-process, in-memory state. At pilot scale (single droplet) that's
// sufficient. Multi-instance would need Redis-backed state — straightforward
// refactor when prod lands.

const THRESHOLD_FAILURES = 5;
const OPEN_DURATION_MS = 60_000; // 60s — auto-probe roughly twice between cron ticks

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CampayCircuitOpenError extends Error {
  readonly code = 'campay_circuit_open';
  constructor() {
    super('Campay circuit is OPEN — too many consecutive failures');
  }
}

@Injectable()
export class CampayCircuitBreakerService {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  // For tests + admin observability.
  getState(): { state: CircuitState; consecutiveFailures: number; openedAt: number } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
    };
  }

  constructor(
    @InjectPinoLogger(CampayCircuitBreakerService.name) private readonly logger: PinoLogger,
  ) {}

  // Wraps a Campay call. The caller passes (operationName, fn). The
  // breaker fails-fast when OPEN, transitions through HALF_OPEN on the
  // first call after the cool-down window, then closes on success.
  async wrap<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    // OPEN → maybe HALF_OPEN if cool-down elapsed.
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt < OPEN_DURATION_MS) {
        this.logger.warn(
          { event: 'campay_circuit_open_rejected', operation },
          'Campay circuit OPEN — fail-fast',
        );
        throw new CampayCircuitOpenError();
      }
      // Cool-down elapsed — promote to HALF_OPEN for a probe.
      this.state = 'HALF_OPEN';
      this.logger.info(
        { event: 'campay_circuit_half_open', operation },
        'Campay circuit HALF_OPEN — trying probe call',
      );
    }

    try {
      const result = await fn();
      this.onSuccess(operation);
      return result;
    } catch (err) {
      this.onFailure(operation, err);
      throw err;
    }
  }

  private onSuccess(operation: string): void {
    if (this.state === 'HALF_OPEN') {
      this.logger.info(
        { event: 'campay_circuit_closed', operation },
        'Campay circuit CLOSED — probe succeeded',
      );
    }
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }

  private onFailure(operation: string, err: unknown): void {
    if (this.state === 'HALF_OPEN') {
      // Probe failed → straight back to OPEN with a fresh cool-down.
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.logger.error(
        {
          event: 'campay_circuit_reopened',
          operation,
          error: err instanceof Error ? err.message : String(err),
        },
        'Campay circuit re-OPENED — probe failed',
      );
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= THRESHOLD_FAILURES) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      this.logger.error(
        {
          event: 'campay_circuit_opened',
          operation,
          consecutiveFailures: this.consecutiveFailures,
          error: err instanceof Error ? err.message : String(err),
        },
        'Campay circuit OPENED — threshold reached',
      );
    }
  }
}

export { THRESHOLD_FAILURES, OPEN_DURATION_MS };
