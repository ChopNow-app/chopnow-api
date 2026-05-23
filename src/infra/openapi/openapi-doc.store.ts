/**
 * In-process holder for the OpenAPI document.
 *
 * Populated by `main.ts` immediately after `SwaggerModule.createDocument`
 * succeeds, then read by `OpenApiController` to serve `/openapi.json` on
 * demand. Plain module-level state (not a NestJS provider) so the
 * controller doesn't need to participate in module DI for something
 * that's effectively a singleton built once at boot.
 *
 * If the Swagger build throws (circular DTO refs, etc.) we never call
 * `set()` — the store stays `null` and the controller responds with
 * 503, surfacing the breakage to anyone hitting the endpoint instead of
 * silently 404'ing.
 */
let cached: object | null = null;

export const OpenApiDocStore = {
  set(doc: object): void {
    cached = doc;
  },
  get(): object | null {
    return cached;
  },
  clear(): void {
    cached = null;
  },
};
