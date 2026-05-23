import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { SubscribePushDto } from './subscribe-push.dto';

/**
 * Exercises the same global ValidationPipe config registered in main.ts
 * so the assertions reflect what would actually happen at the HTTP layer.
 */
function pipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
}

const meta = { type: 'body' as const, metatype: SubscribePushDto, data: '' };
const validBody = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abcdef',
  keys: {
    p256dh: 'A'.repeat(80),
    auth: 'B'.repeat(16),
  },
  deviceFingerprint: 'device-1234567890',
};

describe('SubscribePushDto validation', () => {
  it('accepts a well-formed payload', async () => {
    await expect(pipe().transform(validBody, meta)).resolves.toMatchObject({
      endpoint: validBody.endpoint,
      keys: { p256dh: validBody.keys.p256dh, auth: validBody.keys.auth },
      deviceFingerprint: validBody.deviceFingerprint,
    });
  });

  it('rejects an empty `keys` object (regression: nested DTO must be validated)', async () => {
    // Pre-fix this passed: @IsObject() alone treats `{}` as valid, and the
    // missing p256dh/auth would only blow up downstream in WebPushService.
    await expect(pipe().transform({ ...validBody, keys: {} }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects `keys` missing only p256dh', async () => {
    await expect(
      pipe().transform({ ...validBody, keys: { auth: 'B'.repeat(16) } }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects `keys` with an auth value below the 8-char minimum', async () => {
    await expect(
      pipe().transform({ ...validBody, keys: { p256dh: 'A'.repeat(80), auth: 'short' } }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects unknown fields injected into `keys` (forbidNonWhitelisted)', async () => {
    await expect(
      pipe().transform(
        {
          ...validBody,
          keys: {
            p256dh: 'A'.repeat(80),
            auth: 'B'.repeat(16),
            // PushKeysDto doesn't declare this — whitelist mode rejects.
            evilProp: 'x',
          },
        },
        meta,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a null `keys` value', async () => {
    await expect(pipe().transform({ ...validBody, keys: null }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an endpoint over 2048 chars', async () => {
    await expect(
      pipe().transform({ ...validBody, endpoint: `https://x/${'a'.repeat(2050)}` }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
