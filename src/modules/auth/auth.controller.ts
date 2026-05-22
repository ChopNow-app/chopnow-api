import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import type { CookieOptions, Request, Response } from 'express';
import { EnvService } from '../../infra/config/env.service';
import { Public } from '../../shared/decorators/public.decorator';
import { PhoneRateLimit } from '../../shared/decorators/phone-rate-limit.decorator';
import { PhoneRateLimitGuard } from '../../shared/guards/phone-rate-limit.guard';
import { AuthService } from './auth.service';
import type { DeviceMeta } from './device.service';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

const REFRESH_COOKIE_NAME = 'chopnow_rt';
// Phase C1 — long-lived (10y) HttpOnly cookie carrying the Device row's
// id. The cookie is wider-pathed than chopnow_rt (`/api/v1/auth` vs the
// whole app) because we want it on every refresh/verify, never on any
// other endpoint — same scope as the refresh cookie is fine.
const DEVICE_COOKIE_NAME = 'chopnow_did';
const DEVICE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // ~10 years
/**
 * Phase B1 — refresh-cookie attributes. `Path` is scoped to the auth
 * routes that actually need it (refresh + logout); other endpoints
 * receive the cookie unnecessarily otherwise. `SameSite=Strict` blocks
 * cross-site requests entirely — the PWA on `app.tchopnow.app` and the
 * API on `api-staging.tchopnow.app` share eTLD+1 `tchopnow.app`, so
 * Strict still permits the legitimate same-site cross-subdomain flow.
 * `HttpOnly` is the security primitive: JavaScript can't read the
 * cookie, so XSS on the PWA can't exfiltrate the refresh token.
 */
function refreshCookieOptions(maxAgeSeconds: number, isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction, // Strict requires HTTPS in prod; allow dev over http
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: maxAgeSeconds * 1000, // express-cookies expects ms
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly env: EnvService,
  ) {}

  @Public()
  // 20 OTP requests per 15 min per IP. The original Story 1.1 cap was 5
  // but it tripped legitimate e2e suites that exercise multiple phones
  // from the same supertest client IP. 20 still strongly bounds
  // enumeration / credential-stuffing (the per-phone @PhoneRateLimit
  // below stays at 5/15min — phone-specific brute force is the real
  // threat).
  @Throttle({ otp: { limit: 20, ttl: 15 * 60 * 1000 } })
  @PhoneRateLimit({ limit: 5, ttlSeconds: 15 * 60 })
  @UseGuards(PhoneRateLimitGuard)
  @Post('request-otp')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Request OTP',
    description: 'Sends a 6-digit OTP via WhatsApp (primary) with SMS fallback. Story 1.1.',
  })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.phone);
  }

  @Public()
  // 40 verify attempts per 15 min per IP (was 10 — same rationale as
  // request-otp above: per-IP limit must accommodate multi-phone test
  // suites; per-phone @PhoneRateLimit keeps the brute-force defence
  // tight at 10/15min).
  @Throttle({ otp: { limit: 40, ttl: 15 * 60 * 1000 } })
  @PhoneRateLimit({ limit: 10, ttlSeconds: 15 * 60 })
  @UseGuards(PhoneRateLimitGuard)
  @Post('verify-otp')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify OTP',
    description:
      'On success: 200 with { accessToken, refreshToken } in body AND sets the HttpOnly ' +
      '`chopnow_rt` refresh cookie (Phase B1). The body refreshToken is kept for backwards ' +
      'compatibility while the consumer PWA cuts over from localStorage to cookie storage; ' +
      'new clients should ignore the body and rely on the cookie.',
  })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.verifyOtp(dto.phone, dto.code, this.readDeviceMeta(req));
    this.setRefreshCookie(res, tokens.refreshToken);
    this.setDeviceCookie(res, tokens.deviceId);
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  }

  // @Public skips the global access-token guard — by design. The whole point
  // of /refresh is that the access token is (presumably) expired. The
  // 'jwt-refresh' AuthGuard validates the refresh JWT against its own secret
  // and shape, independently from the access guard.
  @Public()
  @UseGuards(JwtRefreshGuard)
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotate refresh token',
    description:
      'Story 1.2 — returns a new access + refresh pair. Phase B1: prefers the HttpOnly ' +
      '`chopnow_rt` cookie; falls back to body `refreshToken` during the frontend cutover. ' +
      'Old refresh becomes invalid (rotation). Replaying an already-rotated refresh revokes ' +
      'the entire family. ' +
      'Error codes (body.code on 401): refresh_invalid_or_expired, refresh_reuse_detected, user_suspended.',
  })
  async refresh(
    @Body() _dto: RefreshTokenDto,
    @Req() req: Request & { user: { id: string; role: UserRole; refreshToken: string } },
    @Res({ passthrough: true }) res: Response,
  ) {
    // _dto is here only so class-validator rejects empty bodies with a 400.
    // The actual values come from req.user (populated by RefreshJwtStrategy).
    const tokens = await this.auth.refresh(
      req.user.id,
      req.user.role,
      req.user.refreshToken,
      this.readDeviceMeta(req),
    );
    this.setRefreshCookie(res, tokens.refreshToken);
    this.setDeviceCookie(res, tokens.deviceId);
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  }

  /**
   * Phase B1 — single-device logout.
   *
   * Public route because the access token may already be expired when the
   * user clicks "Log out" (cookie still valid). The refresh token from the
   * cookie / body identifies which row to revoke; the cookie itself is
   * cleared regardless of whether the token matched a row.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({
    summary: "Logout — revoke this device's refresh token + clear cookie",
    description:
      'Idempotent: a stale or already-revoked refresh token still clears the cookie + ' +
      'returns 204. Use `/admin/auth/revoke-user` (forthcoming) for "log out of all devices."',
  })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const raw = this.readRefreshFromRequest(req);
    if (raw) await this.auth.logout(raw);
    res.clearCookie(REFRESH_COOKIE_NAME, {
      path: '/api/v1/auth',
      sameSite: 'strict',
      httpOnly: true,
      secure: this.env.isProduction,
    });
    // chopnow_did is kept on logout — it identifies the device, not the
    // session. The user might log back in on the same browser tomorrow
    // and we DON'T want that to fire a "new device" alert.
  }

  /**
   * Phase C2 — "log out everywhere." Revokes every active refresh-token
   * row for this user (i.e. every active session across all devices) so
   * a compromised refresh cookie cannot be replayed. Targeted by the
   * "Ce n'était pas toi&nbsp;?" link in new-device alert emails — the
   * link is account-scoped (no email-token magic-link yet), so the
   * user must be already authenticated to call it.
   *
   * The current device's access token survives until its 15-min TTL
   * expires; if it's the legitimate user revoking their own sessions
   * that's fine, and if it's the attacker doing it (e.g. they're the
   * one viewing the alert email mistakenly delivered to them) they
   * still cut their own session short on the next /refresh.
   */
  @Post('sessions/revoke-all')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke all refresh tokens for the authenticated user',
    description:
      "Phase C2 — 'log out of every device.' Idempotent. Auth required " +
      '(global access-token guard). Returns 204 with no body.',
  })
  async revokeAllSessions(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const userId = (req.user as { id: string }).id;
    await this.auth.revokeAllSessions(userId);
    // Also clear cookies on the calling device — there's no refresh row
    // left for it, so the chopnow_rt cookie is now meaningless.
    res.clearCookie(REFRESH_COOKIE_NAME, {
      path: '/api/v1/auth',
      sameSite: 'strict',
      httpOnly: true,
      secure: this.env.isProduction,
    });
  }

  private setRefreshCookie(res: Response, refreshToken: string): void {
    res.cookie(
      REFRESH_COOKIE_NAME,
      refreshToken,
      refreshCookieOptions(this.auth.refreshCookieMaxAgeSeconds(), this.env.isProduction),
    );
  }

  private setDeviceCookie(res: Response, deviceId: string): void {
    if (!deviceId) return;
    res.cookie(DEVICE_COOKIE_NAME, deviceId, {
      httpOnly: true,
      secure: this.env.isProduction,
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS * 1000,
    });
  }

  private readRefreshFromRequest(req: Request): string | null {
    const cookie = (req.cookies as { chopnow_rt?: unknown } | undefined)?.chopnow_rt;
    if (typeof cookie === 'string' && cookie.length > 0) return cookie;
    const body = req.body as { refreshToken?: unknown } | undefined;
    return typeof body?.refreshToken === 'string' && body.refreshToken.length > 0
      ? body.refreshToken
      : null;
  }

  private readDeviceMeta(req: Request): DeviceMeta {
    const cookieRaw = (req.cookies as { chopnow_did?: unknown } | undefined)?.chopnow_did;
    const deviceCookie = typeof cookieRaw === 'string' && cookieRaw.length > 0 ? cookieRaw : null;
    const userAgentRaw = req.headers['user-agent'];
    const userAgent =
      typeof userAgentRaw === 'string' && userAgentRaw.length > 0 ? userAgentRaw : null;
    // express's `req.ip` honors the `trust proxy` setting and falls back
    // to the socket address. Behind Caddy on the DO droplet this is the
    // forwarded client IP; in tests / dev it's the loopback address.
    const ipAddress = typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : null;
    return { deviceCookie, userAgent, ipAddress };
  }
}
