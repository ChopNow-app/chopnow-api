/**
 * Normalize a phone input to canonical E.164 (+CCNNN…).
 *
 * Accepts:
 *   - Cameroon local 9-digit (e.g. "670000000") → "+237670000000"
 *   - Bare international digits (e.g. "33695412820") → "+33695412820"
 *   - Already E.164 (e.g. "+237670000000") → unchanged
 *
 * Caller is expected to have already validated the input via the DTO regex.
 */
export function normalizePhone(input: string): string {
  if (input.startsWith('+')) return input;
  if (/^6[5-9]\d{7}$/.test(input)) return `+237${input}`;
  return `+${input}`;
}
