import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';

import { MetricsController } from './metrics.controller';

function fakeReq(authHeader?: string): Request {
  return { headers: authHeader ? { authorization: authHeader } : {} } as Request;
}

function fakeRes(): Response {
  return { setHeader: jest.fn() } as unknown as Response;
}

describe('MetricsController bearer gate', () => {
  const ORIGINAL_TOKEN = process.env.METRICS_AUTH_TOKEN;
  let controller: MetricsController;

  beforeEach(() => {
    controller = new MetricsController();
  });

  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.METRICS_AUTH_TOKEN;
    } else {
      process.env.METRICS_AUTH_TOKEN = ORIGINAL_TOKEN;
    }
  });

  it('serves freely when METRICS_AUTH_TOKEN is unset (dev default)', async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const res = fakeRes();

    const body = await controller.index(fakeReq(), res);

    expect(typeof body).toBe('string');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      expect.stringContaining('text/plain'),
    );
  });

  it('serves freely when METRICS_AUTH_TOKEN is empty string', async () => {
    process.env.METRICS_AUTH_TOKEN = '';
    const res = fakeRes();

    await expect(controller.index(fakeReq(), res)).resolves.toEqual(expect.any(String));
  });

  it('401s when the token is required and missing', async () => {
    process.env.METRICS_AUTH_TOKEN = 'a'.repeat(64);
    const res = fakeRes();

    await expect(controller.index(fakeReq(), res)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('401s when the token is required and wrong', async () => {
    process.env.METRICS_AUTH_TOKEN = 'a'.repeat(64);
    const res = fakeRes();

    await expect(controller.index(fakeReq(`Bearer ${'b'.repeat(64)}`), res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('401s when the bearer header is right token but wrong length', async () => {
    process.env.METRICS_AUTH_TOKEN = 'a'.repeat(64);
    const res = fakeRes();

    // Off-by-one length — would crash timingSafeEqual without the
    // wrapper's length guard. Should cleanly 401, not throw.
    await expect(controller.index(fakeReq(`Bearer ${'a'.repeat(63)}`), res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('200s with the correct token', async () => {
    process.env.METRICS_AUTH_TOKEN = 'a'.repeat(64);
    const res = fakeRes();

    const body = await controller.index(fakeReq(`Bearer ${'a'.repeat(64)}`), res);

    expect(typeof body).toBe('string');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      expect.stringContaining('text/plain'),
    );
  });

  it('case-insensitive on the "Bearer" prefix', async () => {
    process.env.METRICS_AUTH_TOKEN = 'a'.repeat(64);
    const res = fakeRes();

    await expect(controller.index(fakeReq(`bearer ${'a'.repeat(64)}`), res)).resolves.toEqual(
      expect.any(String),
    );
  });
});
