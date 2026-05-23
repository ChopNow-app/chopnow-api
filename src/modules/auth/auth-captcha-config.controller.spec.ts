import { AuthCaptchaConfigController } from './auth-captcha-config.controller';

function controllerWith(captcha: {
  enabled: boolean;
  turnstileSecret?: string;
  turnstileSiteKey?: string;
}) {
  return new AuthCaptchaConfigController({ captcha } as never);
}

describe('AuthCaptchaConfigController', () => {
  it('reports disabled when CAPTCHA_ENABLED is false (inert default)', () => {
    const result = controllerWith({ enabled: false }).captchaConfig();
    expect(result).toEqual({ enabled: false, siteKey: null });
  });

  it('reports enabled + site key when fully configured', () => {
    const result = controllerWith({
      enabled: true,
      turnstileSecret: 'srv-secret',
      turnstileSiteKey: '0x4AAA-site-key',
    }).captchaConfig();
    expect(result).toEqual({ enabled: true, siteKey: '0x4AAA-site-key' });
  });

  it('clamps to disabled when enabled=true but no site key is set (avoids broken half-on state)', () => {
    const result = controllerWith({
      enabled: true,
      turnstileSecret: 'srv-secret',
      turnstileSiteKey: undefined,
    }).captchaConfig();
    expect(result).toEqual({ enabled: false, siteKey: null });
  });

  it('does not leak the secret key — only the public site key is returned', () => {
    const result = controllerWith({
      enabled: true,
      turnstileSecret: 'srv-secret-NEVER-EXPOSED',
      turnstileSiteKey: 'public-site-key',
    }).captchaConfig();
    expect(JSON.stringify(result)).not.toContain('srv-secret-NEVER-EXPOSED');
  });
});
