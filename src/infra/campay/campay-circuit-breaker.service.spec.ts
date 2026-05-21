import { Test } from '@nestjs/testing';
import { pinoLoggerProvider } from '../../shared/testing/pino-mock';
import {
  CampayCircuitBreakerService,
  CampayCircuitOpenError,
  OPEN_DURATION_MS,
  THRESHOLD_FAILURES,
} from './campay-circuit-breaker.service';

describe('CampayCircuitBreakerService', () => {
  let breaker: CampayCircuitBreakerService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        CampayCircuitBreakerService,
        pinoLoggerProvider(CampayCircuitBreakerService.name),
      ],
    }).compile();
    breaker = module.get(CampayCircuitBreakerService);
  });

  it('starts CLOSED and passes calls through', async () => {
    const r = await breaker.wrap('test', () => Promise.resolve('ok'));
    expect(r).toBe('ok');
    expect(breaker.getState().state).toBe('CLOSED');
  });

  it('resets the failure counter on each success', async () => {
    await breaker.wrap('test', () => Promise.reject(new Error('boom'))).catch(() => undefined);
    expect(breaker.getState().consecutiveFailures).toBe(1);
    await breaker.wrap('test', () => Promise.resolve('ok'));
    expect(breaker.getState().consecutiveFailures).toBe(0);
  });

  it(`OPENS after ${THRESHOLD_FAILURES} consecutive failures`, async () => {
    for (let i = 0; i < THRESHOLD_FAILURES; i++) {
      await breaker
        .wrap('test', () => Promise.reject(new Error(`fail ${i}`)))
        .catch(() => undefined);
    }
    expect(breaker.getState().state).toBe('OPEN');
  });

  it('fails fast with CampayCircuitOpenError while OPEN within cool-down', async () => {
    for (let i = 0; i < THRESHOLD_FAILURES; i++) {
      await breaker.wrap('x', () => Promise.reject(new Error('e'))).catch(() => undefined);
    }
    // Next call should not even invoke fn
    const fn = jest.fn();
    await expect(breaker.wrap('x', fn)).rejects.toBeInstanceOf(CampayCircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('auto half-opens after the cool-down elapses, then closes on probe success', async () => {
    jest.useFakeTimers();
    const baseNow = Date.now();
    jest.setSystemTime(baseNow);

    for (let i = 0; i < THRESHOLD_FAILURES; i++) {
      await breaker.wrap('x', () => Promise.reject(new Error('e'))).catch(() => undefined);
    }
    expect(breaker.getState().state).toBe('OPEN');

    // Advance past cool-down
    jest.setSystemTime(baseNow + OPEN_DURATION_MS + 1);

    const r = await breaker.wrap('probe', () => Promise.resolve('ok'));
    expect(r).toBe('ok');
    expect(breaker.getState().state).toBe('CLOSED');
    expect(breaker.getState().consecutiveFailures).toBe(0);
    jest.useRealTimers();
  });

  it('re-OPENS when the half-open probe fails', async () => {
    jest.useFakeTimers();
    const baseNow = Date.now();
    jest.setSystemTime(baseNow);

    for (let i = 0; i < THRESHOLD_FAILURES; i++) {
      await breaker.wrap('x', () => Promise.reject(new Error('e'))).catch(() => undefined);
    }
    jest.setSystemTime(baseNow + OPEN_DURATION_MS + 1);

    await expect(
      breaker.wrap('probe', () => Promise.reject(new Error('still down'))),
    ).rejects.toThrow('still down');
    expect(breaker.getState().state).toBe('OPEN');
    jest.useRealTimers();
  });
});
