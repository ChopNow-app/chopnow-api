import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { pinoMock } from '../testing/pino-mock';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual('@sentry/node'),
  captureException: jest.fn(),
}));

function fakeHost(method = 'GET', path = '/api/v1/test') {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = { method, url: path };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function makeFilter() {
  const logger = pinoMock();
  return { filter: new AllExceptionsFilter(logger as never), logger };
}

describe('AllExceptionsFilter', () => {
  beforeEach(() => {
    (Sentry.captureException as jest.Mock).mockClear();
  });

  it('passes a structured { code, message } throw through unchanged', () => {
    const { filter } = makeFilter();
    const { host, status, json } = fakeHost();

    filter.catch(
      new UnauthorizedException({
        code: 'refresh_invalid_or_expired',
        message: 'Session expired.',
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(401);
    const body = json.mock.calls[0][0];
    expect(body).toMatchObject({
      statusCode: 401,
      path: '/api/v1/test',
      code: 'refresh_invalid_or_expired',
      message: 'Session expired.',
    });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('promotes a bare-string snake_case throw to the `code` field', () => {
    // Regression coverage for the ~80 call sites that use
    // `throw new NotFoundException('vendor_not_found')`. Pre-fix, those
    // gave the client { message: 'vendor_not_found', error: 'Not Found' }
    // with no `code`. Post-fix, the snake_case message is also copied
    // to `code` so the frontend can branch on it.
    const { filter } = makeFilter();
    const { host, json } = fakeHost();

    filter.catch(new NotFoundException('vendor_not_found'), host);

    const body = json.mock.calls[0][0];
    expect(body.code).toBe('vendor_not_found');
    expect(body.message).toBe('vendor_not_found');
  });

  it('does NOT touch `code` when a structured throw already set it', () => {
    const { filter } = makeFilter();
    const { host, json } = fakeHost();

    // Explicit code wins even when message also looks snake_case
    filter.catch(
      new BadRequestException({ code: 'preferred_code', message: 'other_message' }),
      host,
    );

    const body = json.mock.calls[0][0];
    expect(body.code).toBe('preferred_code');
  });

  it("does NOT promote a free-text message that isn't a snake_case code", () => {
    const { filter } = makeFilter();
    const { host, json } = fakeHost();

    filter.catch(new ForbiddenException('Access denied — contact your admin.'), host);

    const body = json.mock.calls[0][0];
    expect(body.code).toBeUndefined();
    expect(body.message).toBe('Access denied — contact your admin.');
  });

  it('maps an arbitrary Error to a generic 500 — never leaks the stack', () => {
    const { filter, logger } = makeFilter();
    const { host, status, json } = fakeHost('POST', '/api/v1/orders');

    const boom = new Error('DB pool exhausted at /opt/chopnow/node_modules/...');
    boom.stack = 'Error: secret-leak\n    at /home/build/private/path:42';
    filter.catch(boom, host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Internal server error');
    // Critical: the response must not contain the raw error message OR stack.
    expect(JSON.stringify(body)).not.toContain('DB pool');
    expect(JSON.stringify(body)).not.toContain('secret-leak');
    expect(JSON.stringify(body)).not.toContain('/opt/chopnow');

    // But the logger gets the full stack for ops to debug from.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'unhandled_5xx',
        statusCode: 500,
        path: '/api/v1/orders',
        method: 'POST',
        stack: expect.stringContaining('secret-leak'),
      }),
      expect.any(String),
    );
  });

  it('5xx HttpException also logs the stack', () => {
    const { filter, logger } = makeFilter();
    const { host } = fakeHost();
    const httpEx = new HttpException(
      { code: 'service_unavailable', message: 'Upstream timeout' },
      HttpStatus.SERVICE_UNAVAILABLE,
    );

    filter.catch(httpEx, host);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'unhandled_5xx', statusCode: 503 }),
      expect.any(String),
    );
  });

  it('does not log a stack for 4xx (sanitized client errors)', () => {
    const { filter, logger } = makeFilter();
    const { host } = fakeHost();

    filter.catch(new BadRequestException({ code: 'foo', message: 'bar' }), host);

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('sends 5xx to Sentry with method + path + status tags (Phase O1)', () => {
    const { filter } = makeFilter();
    const { host } = fakeHost('POST', '/api/v1/orders');

    filter.catch(new Error('boom'), host);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          method: 'POST',
          path: '/api/v1/orders',
          status_code: '500',
        }),
      }),
    );
  });

  it('does NOT send 4xx to Sentry — client errors are not bugs', () => {
    const { filter } = makeFilter();
    const { host } = fakeHost();

    filter.catch(new BadRequestException({ code: 'foo', message: 'bar' }), host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('includes path + timestamp on every response', () => {
    const { filter } = makeFilter();
    const { host, json } = fakeHost('DELETE', '/api/v1/admin/x');

    filter.catch(new NotFoundException('x_not_found'), host);

    const body = json.mock.calls[0][0];
    expect(body.path).toBe('/api/v1/admin/x');
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\./);
  });
});
