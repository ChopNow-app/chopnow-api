/**
 * Phase O3 — Pino multi-transport builder.
 *
 * Matrix of stdout vs Loki shipping based on env:
 *
 *   - dev / test (NODE_ENV !== 'production'):
 *       → pino-pretty for stdout (human-readable single-line)
 *       → pino-loki if LOKI_URL is set (rare in dev; useful when
 *         testing the Loki wiring locally)
 *
 *   - production (NODE_ENV === 'production'):
 *       → stdout JSON (default pino, no transport — no extra worker)
 *         when LOKI_URL is unset
 *       → pino-loki when LOKI_URL is set (still goes to stdout via
 *         pino's default + ALSO ships to Loki in a worker thread)
 *
 * Pino's `transport.targets` array runs each target in its own worker
 * thread so the main process isn't blocked by network I/O to Loki.
 *
 * Loki labels: `app=chopnow-api, env=<NODE_ENV>` give us the two
 * dimensions Grafana queries usually filter on. Adding a label per
 * service or per pod is a follow-up if we ever scale past 1 instance.
 *
 * Auth shape for Grafana Cloud Loki:
 *   - LOKI_URL: full endpoint (e.g. `https://logs-prod-XXX.grafana.net`)
 *   - LOKI_USERNAME: numeric tenant ID from the Grafana Cloud stack
 *   - LOKI_TOKEN: API token with `logs:write` scope
 */

type TransportTarget = {
  target: string;
  options?: Record<string, unknown>;
  level?: string;
};

export function buildPinoTransport(): { targets: TransportTarget[] } | undefined {
  const targets: TransportTarget[] = [];
  const isProd = process.env.NODE_ENV === 'production';
  const lokiUrl = process.env.LOKI_URL;

  // Dev/test stdout: pino-pretty for readability. In production this
  // is unset and pino falls back to its default JSON stdout writer.
  if (!isProd) {
    targets.push({
      target: 'pino-pretty',
      options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' },
    });
  }

  if (lokiUrl && lokiUrl.length > 0) {
    targets.push({
      target: 'pino-loki',
      options: {
        host: lokiUrl,
        basicAuth: {
          username: process.env.LOKI_USERNAME ?? '',
          password: process.env.LOKI_TOKEN ?? '',
        },
        labels: {
          app: 'chopnow-api',
          env: process.env.NODE_ENV ?? 'development',
        },
        // Batched delivery — 5s buffer is the pino-loki default + a
        // good middle ground for our pilot volume (logs visible in
        // Grafana within seconds, no network thrash on every line).
        batching: true,
        interval: 5,
        // Don't replace pino's ISO timestamp with Loki's wall-clock
        // when the batch arrives — we want the original event time.
        replaceTimestamp: false,
      },
    });
  }

  // If neither pretty nor loki applies (prod without Loki), return
  // undefined so pino uses its default stdout JSON path directly —
  // no worker thread for the simplest case.
  if (targets.length === 0) return undefined;

  return { targets };
}
