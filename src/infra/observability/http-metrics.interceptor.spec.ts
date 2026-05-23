import { CallHandler, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Histogram } from 'prom-client';
import { lastValueFrom, of, throwError } from 'rxjs';

import { HttpMetricsInterceptor } from './http-metrics.interceptor';

function fakeHttpContext(method: string, route: string, statusCode = 200): ExecutionContext {
  const req = { method, url: `/api/v1${route}`, route: { path: `/api/v1${route}` } };
  const res = { statusCode };
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

function makeInterceptor() {
  const observe = jest.fn();
  const histogram = { observe } as unknown as Histogram<string>;
  return { interceptor: new HttpMetricsInterceptor(histogram), observe };
}

describe('HttpMetricsInterceptor', () => {
  it('records duration with method + route template + status on success', async () => {
    const { interceptor, observe } = makeInterceptor();
    const ctx = fakeHttpContext('GET', '/vendors/:vendorId', 200);
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await lastValueFrom(interceptor.intercept(ctx, next));

    expect(observe).toHaveBeenCalledTimes(1);
    const [labels, duration] = observe.mock.calls[0];
    expect(labels).toEqual({
      method: 'GET',
      // Critical: route TEMPLATE, not the resolved URL — keeps
      // cardinality bounded.
      route: '/api/v1/vendors/:vendorId',
      status: '200',
    });
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(duration).toBeLessThan(1); // sanity: shouldn't take 1s in a unit test
  });

  it('records duration with the HttpException status on failure paths', async () => {
    const { interceptor, observe } = makeInterceptor();
    const ctx = fakeHttpContext('POST', '/orders/:orderId/pay/momo', 200);
    const next: CallHandler = {
      handle: () => throwError(() => new HttpException('boom', HttpStatus.CONFLICT)),
    };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBeInstanceOf(
      HttpException,
    );

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toEqual({
      method: 'POST',
      route: '/api/v1/orders/:orderId/pay/momo',
      status: '409', // pulled from the exception, not res.statusCode
    });
  });

  it('attributes plain Errors to status 500', async () => {
    const { interceptor, observe } = makeInterceptor();
    const ctx = fakeHttpContext('GET', '/anything', 200);
    const next: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBeInstanceOf(Error);

    expect(observe.mock.calls[0][0].status).toBe('500');
  });

  it('skips non-HTTP contexts (cron, BullMQ workers, etc.)', async () => {
    const { interceptor, observe } = makeInterceptor();
    const ctx = { getType: () => 'rpc' } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('ok') };

    await lastValueFrom(interceptor.intercept(ctx, next));

    expect(observe).not.toHaveBeenCalled();
  });

  it('falls back to req.url when route is undefined (e.g. 404 routes)', async () => {
    const { interceptor, observe } = makeInterceptor();
    const ctx = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/api/v1/nope' }),
        getResponse: () => ({ statusCode: 404 }),
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(undefined) };

    await lastValueFrom(interceptor.intercept(ctx, next));

    expect(observe.mock.calls[0][0].route).toBe('/api/v1/nope');
  });
});
