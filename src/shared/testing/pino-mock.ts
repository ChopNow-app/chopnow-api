import { getLoggerToken } from 'nestjs-pino';

/**
 * Minimal silent `PinoLogger` stand-in for unit tests. Tests almost never
 * assert on log output — when they need to, use `jest.spyOn(...)` on the
 * specific method.
 *
 * Returned as a fresh instance per call so tests can reset call counts
 * independently if they choose to spy.
 */
export function pinoMock() {
  return {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    setContext: jest.fn(),
  };
}

/**
 * Provider tuple for `Test.createTestingModule({ providers: [...] })`. Pass
 * the same context string the service uses in `@InjectPinoLogger(...)` —
 * typically `ServiceName` (e.g. `OrdersService.name`).
 *
 * Example:
 * ```
 * providers: [
 *   OrdersService,
 *   pinoLoggerProvider(OrdersService.name),
 *   ...
 * ]
 * ```
 */
export function pinoLoggerProvider(context: string) {
  return {
    provide: getLoggerToken(context),
    useValue: pinoMock(),
  };
}
