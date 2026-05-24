/**
 * Campay sandbox smoke test.
 *
 * Hits the REAL Campay demo API (https://demo.campay.net) with the 4
 * pre-configured test phone numbers that simulate every operator ×
 * outcome combination:
 *
 *   +237 677 777 777  MTN     → PENDING → SUCCESSFUL
 *   +237 677 777 770  MTN     → PENDING → FAILED
 *   +237 699 999 999  Orange  → PENDING → SUCCESSFUL
 *   +237 699 999 990  Orange  → PENDING → FAILED
 *
 * Cap: 25 XAF per call (sandbox rule). Costs 0 FCFA — sandbox doesn't
 * charge real money. The 4 numbers above are documented in Campay's
 * sandbox dashboard.
 *
 * # Usage
 *
 *   # Local — uses your .env (CAMPAY_API_URL / USERNAME / PASSWORD)
 *   npx ts-node scripts/campay-sandbox-smoke.ts
 *
 *   # Against staging creds explicitly (don't commit; pull from gh)
 *   CAMPAY_USERNAME=… CAMPAY_PASSWORD=… npx ts-node scripts/campay-sandbox-smoke.ts
 *
 *   # Skip the status-poll (faster — only verifies /collect/ accepts)
 *   SKIP_POLL=1 npx ts-node scripts/campay-sandbox-smoke.ts
 *
 * # What it checks
 *
 *   1. /token/      — auth still works against demo.campay.net
 *   2. /collect/    — each of the 4 numbers gets a `reference` + PENDING status
 *   3. (optional)   — polls `/transaction/<reference>/` until terminal state
 *                     and asserts it matches the expected outcome (60s timeout)
 *
 * # What it does NOT check (covered elsewhere)
 *
 *   - Webhook signature validation       → campay-signature.spec.ts
 *   - Circuit breaker open/closed states → campay-circuit-breaker.service.spec.ts
 *   - Webhook idempotency                → campay-webhook-dedup.service.spec.ts
 *   - Webhook controller dispatch        → campay-webhook.guard.spec.ts
 *
 * # NOT a CI test
 *
 * This script is intentionally NOT a `src/.../[name].spec.ts` and NOT wired
 * to `npm test`. Hitting Campay's sandbox in CI would be flaky (network
 * + their rate limit) and slow. Run it manually before each launch
 * and after any change to campay.service.ts.
 *
 * Exit code: 0 if all 4 scenarios behaved as expected, 1 otherwise.
 */

import * as dotenv from 'dotenv';
dotenv.config();

// ─── Sandbox numbers (source: Campay sandbox dashboard) ─────────────
interface SandboxScenario {
  msisdn: string; // E.164 — what we send as `from`
  operator: 'MTN' | 'Orange';
  expectedFinalStatus: 'SUCCESSFUL' | 'FAILED';
  label: string;
}

const SANDBOX_SCENARIOS: SandboxScenario[] = [
  {
    msisdn: '+237677777777',
    operator: 'MTN',
    expectedFinalStatus: 'SUCCESSFUL',
    label: 'MTN happy path',
  },
  {
    msisdn: '+237677777770',
    operator: 'MTN',
    expectedFinalStatus: 'FAILED',
    label: 'MTN payer-side failure',
  },
  {
    msisdn: '+237699999999',
    operator: 'Orange',
    expectedFinalStatus: 'SUCCESSFUL',
    label: 'Orange happy path',
  },
  {
    msisdn: '+237699999990',
    operator: 'Orange',
    expectedFinalStatus: 'FAILED',
    label: 'Orange payer-side failure',
  },
];

const AMOUNT_XAF = 25; // sandbox cap
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60_000;

// ─── Result tracking ─────────────────────────────────────────────────
interface ScenarioResult {
  scenario: SandboxScenario;
  collectAccepted: boolean;
  reference?: string;
  initialStatus?: string;
  finalStatus?: string;
  finalStatusMatchesExpected?: boolean;
  error?: string;
  durationMs: number;
}

// ─── Config ──────────────────────────────────────────────────────────
function readConfig(): { apiUrl: string; username: string; password: string } {
  const apiUrl = (process.env.CAMPAY_API_URL || '').replace(/\/$/, '');
  const username = process.env.CAMPAY_USERNAME || '';
  const password = process.env.CAMPAY_PASSWORD || '';
  if (!apiUrl || !username || !password) {
    console.error(
      'Missing config — required env vars: CAMPAY_API_URL, CAMPAY_USERNAME, CAMPAY_PASSWORD\n' +
        'Populate .env or export them inline.',
    );
    process.exit(2);
  }
  if (!apiUrl.includes('demo.campay.net')) {
    console.error(
      `Refusing to run — CAMPAY_API_URL is "${apiUrl}", not the sandbox (demo.campay.net).\n` +
        'This script costs real money against production. Use only against the sandbox.',
    );
    process.exit(2);
  }
  return { apiUrl, username, password };
}

// ─── HTTP helpers ────────────────────────────────────────────────────
async function getToken(cfg: {
  apiUrl: string;
  username: string;
  password: string;
}): Promise<string> {
  const res = await fetch(`${cfg.apiUrl}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`auth failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error('no token in response');
  return data.token;
}

async function initiateCollect(
  apiUrl: string,
  token: string,
  scenario: SandboxScenario,
): Promise<{ reference: string; status: string }> {
  const externalReference = `smoke-${scenario.operator}-${Date.now()}`;
  const res = await fetch(`${apiUrl}/collect/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
    body: JSON.stringify({
      amount: String(AMOUNT_XAF),
      from: scenario.msisdn,
      description: `ChopNow sandbox smoke ${scenario.label}`,
      external_reference: externalReference,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  const reference = data.reference as string | undefined;
  if (!reference) throw new Error(`missing reference in response: ${JSON.stringify(data)}`);
  return { reference, status: (data.status as string) ?? 'PENDING' };
}

/**
 * Poll Campay's transaction-status endpoint until the status reaches a
 * terminal state (SUCCESSFUL / FAILED / CANCELLED) or we time out.
 * Returns the last observed status.
 *
 * Endpoint shape per Campay docs: GET /transaction/{reference}/ —
 * returns `{ status, reference, ... }`.
 */
async function pollUntilTerminal(
  apiUrl: string,
  token: string,
  reference: string,
): Promise<string> {
  const start = Date.now();
  let last = 'PENDING';
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await fetch(`${apiUrl}/transaction/${reference}/`, {
        headers: { Authorization: `Token ${token}` },
      });
      if (!res.ok) {
        // Don't treat transient 5xx as a final answer; keep polling.
        continue;
      }
      const data = (await res.json()) as { status?: string };
      last = (data.status as string) || last;
      if (last === 'SUCCESSFUL' || last === 'FAILED' || last === 'CANCELLED') {
        return last;
      }
    } catch {
      // Network blip — keep going until timeout.
    }
  }
  return last; // last observed (probably still PENDING)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const cfg = readConfig();
  console.log(`▶ Campay sandbox smoke test`);
  console.log(`  API: ${cfg.apiUrl}`);
  console.log(`  Scenarios: ${SANDBOX_SCENARIOS.length}, amount: ${AMOUNT_XAF} XAF each`);
  console.log(`  Skip poll: ${process.env.SKIP_POLL ? 'YES' : 'no'}`);
  console.log();

  let token: string;
  try {
    token = await getToken(cfg);
    console.log(`  ✓ /token/ — auth succeeded`);
  } catch (err) {
    console.error(`  ✗ /token/ — ${(err as Error).message}`);
    process.exit(1);
  }
  console.log();

  const results: ScenarioResult[] = [];
  for (const scenario of SANDBOX_SCENARIOS) {
    const start = Date.now();
    const result: ScenarioResult = {
      scenario,
      collectAccepted: false,
      durationMs: 0,
    };

    console.log(
      `▶ ${scenario.label} (${scenario.msisdn}) — expect ${scenario.expectedFinalStatus}`,
    );

    try {
      const collect = await initiateCollect(cfg.apiUrl, token, scenario);
      result.collectAccepted = true;
      result.reference = collect.reference;
      result.initialStatus = collect.status;
      console.log(`    /collect/    → reference=${collect.reference} status=${collect.status}`);
    } catch (err) {
      result.error = (err as Error).message;
      result.durationMs = Date.now() - start;
      console.error(`    /collect/    ✗ ${result.error}`);
      results.push(result);
      console.log();
      continue;
    }

    if (process.env.SKIP_POLL) {
      result.durationMs = Date.now() - start;
      results.push(result);
      console.log(`    (skipping status poll)`);
      console.log();
      continue;
    }

    const finalStatus = await pollUntilTerminal(cfg.apiUrl, token, result.reference!);
    result.finalStatus = finalStatus;
    result.finalStatusMatchesExpected = finalStatus === scenario.expectedFinalStatus;
    result.durationMs = Date.now() - start;

    const icon = result.finalStatusMatchesExpected ? '✓' : '✗';
    console.log(
      `    poll status   ${icon} final=${finalStatus} (expected ${scenario.expectedFinalStatus})  ${result.durationMs}ms`,
    );
    console.log();

    results.push(result);
  }

  // ─── Summary ──────────────────────────────────────────────────────
  console.log('━'.repeat(60));
  console.log('Summary');
  console.log('━'.repeat(60));
  const headerWidth = 32;
  for (const r of results) {
    const label = r.scenario.label.padEnd(headerWidth);
    if (r.error) {
      console.log(`  ✗  ${label}  ERROR: ${r.error}`);
      continue;
    }
    if (process.env.SKIP_POLL) {
      const ok = r.collectAccepted ? '✓' : '✗';
      console.log(`  ${ok}  ${label}  collect-accepted=${r.collectAccepted} (poll skipped)`);
      continue;
    }
    const ok = r.finalStatusMatchesExpected ? '✓' : '✗';
    console.log(
      `  ${ok}  ${label}  final=${r.finalStatus}  expected=${r.scenario.expectedFinalStatus}`,
    );
  }
  console.log();

  const ok = results.every((r) =>
    process.env.SKIP_POLL ? r.collectAccepted : r.finalStatusMatchesExpected,
  );
  const passCount = results.filter((r) =>
    process.env.SKIP_POLL ? r.collectAccepted : r.finalStatusMatchesExpected,
  ).length;
  console.log(`Result: ${passCount}/${results.length} scenarios as expected.`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
