/**
 * Metric token constants — kept in their own file so the interceptor
 * and the module that registers the providers can both import them
 * without creating a circular dependency.
 *
 * `@InjectMetric(name)` looks the metric up by name in the registry,
 * so the constant just needs to be a stable string everyone agrees on.
 */
export const HTTP_REQUEST_DURATION_SECONDS = 'http_request_duration_seconds';
