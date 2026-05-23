import * as Sentry from '@sentry/node';

/**
 * Phase O1 — Sentry init.
 *
 * Must be called BEFORE NestFactory.create so the SDK can monkey-patch
 * Node's http/express internals before any request handler runs.
 *
 * Graceful no-op when SENTRY_DSN is unset — the SDK becomes a series
 * of empty function calls. This means:
 *   - CI runs (no DSN configured) don't try to send to Sentry
 *   - Local dev (no DSN) doesn't ship noise
 *   - Production / staging (DSN set via secrets) ship every captured
 *     exception
 *
 * Reads directly from `process.env` rather than `EnvService` because
 * this runs before the Nest DI container exists.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    // Don't ship logs as breadcrumbs — pino already captures everything
    // structured + ships to Loki. Sentry's value here is exceptions +
    // perf traces, not log aggregation.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== 'Console' && i.name !== 'NodeFetch'),
    // Don't let Sentry block the process on shutdown — log the captures
    // best-effort and move on. The 2s timeout matches NestJS' default
    // shutdown grace period.
    shutdownTimeout: 2000,
    beforeSend(event) {
      // Belt + braces: scrub anything that smells like an auth header
      // or a refresh token before it leaves the process. The pino
      // logger already does this for log lines, but Sentry's request
      // breadcrumb capture is a separate code path.
      if (event.request?.headers) {
        const h = event.request.headers as Record<string, string>;
        delete h.authorization;
        delete h.cookie;
        delete h['set-cookie'];
      }
      return event;
    },
  });

  return true;
}

/**
 * Test-only helper — flushes pending events with a short timeout so
 * specs don't leak undelivered events. Production callers should use
 * Sentry's normal shutdown via `Sentry.close()`.
 */
export async function flushSentry(timeoutMs = 2000): Promise<boolean> {
  return Sentry.flush(timeoutMs);
}
