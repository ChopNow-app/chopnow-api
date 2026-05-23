import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

/**
 * Slow-query threshold (ms). Queries that take longer than this get a
 * structured warn-level log line so they surface in Sentry breadcrumbs +
 * Grafana Loki searches. Threshold tunable via env so production can run
 * tighter (e.g. 200ms) once we have a baseline.
 */
const DEFAULT_SLOW_QUERY_MS = 500;

/**
 * Phase O4 — Prisma client with query event logging.
 *
 * Enables Prisma's `query` event stream and listens for slow ones. We
 * don't pipe every query to stdout (would drown the logs) — only queries
 * over the threshold get a warn-level event. Errors and warnings always
 * log because they're rare and high-signal.
 *
 * The query log line redacts the parameters but keeps the first 200
 * chars of the query template — enough to identify the offending
 * statement without leaking values that might include phone numbers,
 * coordinates, or other PII.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@InjectPinoLogger(PrismaService.name) private readonly logger: PinoLogger) {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    const threshold = parseInt(process.env.PRISMA_SLOW_QUERY_MS ?? '', 10);
    const slowMs = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_SLOW_QUERY_MS;

    // `$on('query', ...)` typing on PrismaClient is awkward when constructor-
    // configured via the literal log array — the runtime accepts it but TS
    // narrows to `never`. Cast through unknown to keep the listener wiring.
    (this as unknown as { $on(ev: 'query', cb: (e: Prisma.QueryEvent) => void): void }).$on(
      'query',
      (event) => {
        if (event.duration < slowMs) return;
        this.logger.warn(
          {
            event: 'prisma_slow_query',
            durationMs: event.duration,
            // First 200 chars only — keeps the log line bounded and
            // avoids accidentally dumping parameter-laced SQL into Loki.
            // Params are deliberately NOT logged.
            query: event.query.slice(0, 200),
            target: event.target,
          },
          `Prisma slow query (${event.duration}ms ≥ ${slowMs}ms threshold)`,
        );
      },
    );

    (this as unknown as { $on(ev: 'warn', cb: (e: Prisma.LogEvent) => void): void }).$on(
      'warn',
      (event) => {
        this.logger.warn(
          { event: 'prisma_warn', target: event.target, message: event.message },
          'Prisma warning',
        );
      },
    );

    (this as unknown as { $on(ev: 'error', cb: (e: Prisma.LogEvent) => void): void }).$on(
      'error',
      (event) => {
        this.logger.error(
          { event: 'prisma_error', target: event.target, message: event.message },
          'Prisma error',
        );
      },
    );
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
