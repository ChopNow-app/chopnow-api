import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { collectDefaultMetrics, Histogram, register } from 'prom-client';

import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { HTTP_REQUEST_DURATION_SECONDS } from './metrics.constants';
import { MetricsController } from './metrics.controller';

/**
 * Phase O2 — Prometheus metrics endpoint.
 *
 * Wires up:
 *   1. Default Node.js process metrics (heap, GC, event loop lag,
 *      open file descriptors) via `prom-client.collectDefaultMetrics()`.
 *   2. HTTP request duration histogram, observed by the global
 *      `HttpMetricsInterceptor` for every request.
 *   3. `/metrics` endpoint via `MetricsController` (mirrors the
 *      `HealthController` route pattern: VERSION_NEUTRAL controller +
 *      path on the @Get decorator).
 *
 * Why not `@willsoto/nestjs-prometheus`'s `PrometheusModule.register()`:
 * the library mutates controller route metadata via Reflect, which
 * collides with our own @Controller() decorator + @Public() needs.
 * We use the bare prom-client primitives instead — equivalent end
 * result without the magic.
 *
 * Histogram buckets cover typical request times for this stack:
 *   - 10ms-100ms: fast in-memory + cached DB hits
 *   - 100ms-1s: most DB-backed reads / writes
 *   - 1s-10s: dispatch loops, Campay calls, PostGIS aggregates
 *
 * Custom business metrics (orders created, payments succeeded, queue
 * depths) ship in follow-up PRs — this PR kept to infrastructure.
 */

// Guard against double-registration when the module is hot-reloaded
// in test runs (each `Test.createTestingModule` re-imports this file).
// prom-client's default registry is a process-level singleton.
let defaultMetricsStarted = false;
function ensureDefaultMetrics(): void {
  if (defaultMetricsStarted) return;
  collectDefaultMetrics();
  defaultMetricsStarted = true;
}

let httpHistogram: Histogram<string> | null = null;
function ensureHttpHistogram(): Histogram<string> {
  if (httpHistogram) return httpHistogram;
  // If the test fixture already created an instance (e.g. from a prior
  // module compile), reuse it — the registry only allows one metric
  // per name.
  const existing = register.getSingleMetric(HTTP_REQUEST_DURATION_SECONDS) as
    | Histogram<string>
    | undefined;
  if (existing) {
    httpHistogram = existing;
    return httpHistogram;
  }
  httpHistogram = new Histogram({
    name: HTTP_REQUEST_DURATION_SECONDS,
    help: 'HTTP request duration in seconds, labelled by method + route template + status.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });
  return httpHistogram;
}

ensureDefaultMetrics();

@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: HTTP_REQUEST_DURATION_SECONDS,
      useFactory: ensureHttpHistogram,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpMetricsInterceptor,
    },
  ],
})
export class MetricsModule {}
