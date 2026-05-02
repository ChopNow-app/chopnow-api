import * as http from 'http';
import * as https from 'https';
// @ts-expect-error — package ships its own types but no @types module declaration is bundled
import ssrfFilter from 'ssrf-req-filter';

/**
 * SSRF-safe HTTP agents. Block private IP ranges (RFC 1918), loopback,
 * link-local (169.254.0.0/16 — covers cloud metadata endpoints), and IPv6 equivalents.
 *
 * Use when fetching ANY user-influenced URL:
 *   - Vendor logos / photos via URL (Story 2.1, 2.11)
 *   - Webhook callback URLs configured by external providers
 *   - Image proxy endpoints
 *
 * Example:
 *   const res = await fetch(userUrl, { agent: getSafeAgent(userUrl) } as any);
 */
const safeHttp = ssrfFilter('http:') as http.Agent;
const safeHttps = ssrfFilter('https:') as https.Agent;

export function getSafeAgent(url: string | URL): http.Agent | https.Agent {
  const u = typeof url === 'string' ? new URL(url) : url;
  return u.protocol === 'https:' ? safeHttps : safeHttp;
}

/**
 * Convenience wrapper around node-fetch / global fetch with SSRF protection
 * for the common case of GET-ing a user-supplied URL.
 *
 * Returns the Response or throws if the URL targets a forbidden range.
 */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // Reject obvious junk early
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('protocol_not_allowed');
  }

  // node-fetch / undici read `dispatcher` or `agent` differently depending on runtime;
  // ssrf-req-filter targets node http(s).Agent and works with node-fetch v2/v3.
  const agent = getSafeAgent(parsed);
  return fetch(url, { ...init, // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent } as any);
}
