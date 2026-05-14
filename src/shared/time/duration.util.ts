// Parse a short duration string into milliseconds.
//
// Supports the suffix shorthand `jsonwebtoken` accepts for `expiresIn`:
//   `60s` → 60_000, `15m` → 900_000, `24h` → 86_400_000, `30d` → 2_592_000_000.
//
// Used to compute a `RefreshToken.expiresAt` Date that matches whatever value
// JwtModule embedded as the JWT's `exp` claim — so DB-side expiry and
// JWT-side expiry stay in lockstep.

const SUFFIX_TO_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDurationMs(input: string): number {
  const match = /^(\d+)([smhd])$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${input}. Expected <number>(s|m|h|d), e.g. "30d".`);
  }
  const [, n, suffix] = match;
  return Number(n) * SUFFIX_TO_MS[suffix];
}
