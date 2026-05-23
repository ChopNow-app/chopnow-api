import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import type { CookieOptions, Request, Response } from 'express';
import { EnvService } from '../../infra/config/env.service';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { AdminAuthService, LoginResult } from './admin-auth.service';
import { AdminTotpService } from './admin-totp.service';
import { AuthService } from '../auth/auth.service';
import type { DeviceMeta } from '../auth/device.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { ConfirmAdminTotpDto, VerifyAdminTotpDto } from './dto/admin-2fa.dto';

const REFRESH_COOKIE_NAME = 'chopnow_rt';
const DEVICE_COOKIE_NAME = 'chopnow_did';
const DEVICE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // ~10 years

const ADMIN_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.OPERATOR,
  UserRole.VIEWER,
] as const;

@ApiTags('admin-auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly totp: AdminTotpService,
    private readonly auth: AuthService,
    private readonly env: EnvService,
  ) {}

  // ── Step 1: password ────────────────────────────────────────────────

  // Public: admin doesn't have a JWT yet at this point. Strict per-IP throttle
  // (5/min) discourages credential-stuffing in addition to the per-account
  // lockout (5 failed/15min → locked).
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * 1000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Admin login step 1 — email + password',
    description:
      'Story 1.6 / Phase A1. Returns one of two shapes:\n' +
      '  - { stage: "totp_required", challenge, challengeExpiresIn } — admin has TOTP enrolled. ' +
      'Client must POST /admin/auth/2fa within 5 minutes.\n' +
      '  - { stage: "success", accessToken, role, email, expiresIn } — admin does not yet have ' +
      'TOTP enrolled (legacy / first-login). 8h access JWT issued directly. Client should ' +
      'redirect to enrollment.\n' +
      'Error codes (body.code on 401): invalid_credentials, account_locked.',
  })
  async login(
    @Body() dto: AdminLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuth.login(dto.email, dto.password, this.readDeviceMeta(req));
    this.maybeSetSessionCookies(res, result);
    return this.scrubBody(result);
  }

  // ── Step 2: TOTP / recovery code ────────────────────────────────────

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60 * 1000 } })
  @Post('2fa')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Admin login step 2 — TOTP code or recovery code',
    description:
      'Redeems the challenge from step 1. On success: 8h access JWT (same shape as ' +
      '/admin/auth/login when not 2fa-required). Recovery codes are single-use; consuming ' +
      'one decrements the remaining pool. ' +
      'Error codes: totp_challenge_expired, totp_invalid_code.',
  })
  async verify2fa(
    @Body() dto: VerifyAdminTotpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.adminAuth.verifyTotpChallenge(
      dto.challenge,
      dto.code,
      Boolean(dto.isRecoveryCode),
      this.readDeviceMeta(req),
    );
    this.maybeSetSessionCookies(res, result);
    return this.scrubBody(result);
  }

  // ── Enrollment (requires an authenticated admin session) ────────────

  @Roles(...ADMIN_ROLES)
  @ApiBearerAuth()
  @Post('2fa/setup')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start TOTP enrollment — returns QR + cleartext secret',
    description:
      'Generates an RFC 6238 secret + otpauth:// URI. Admin scans the QR with Authy / ' +
      'Google Authenticator / 1Password, then POSTs /admin/auth/2fa/confirm with the first ' +
      'code to lock the enrollment in. Recovery codes are minted at confirmation time, NOT here.',
  })
  start2faSetup(@Req() req: Request) {
    const user = req.user as { id: string; email?: string };
    return this.totp.startEnrollment(user.id, user.email ?? '');
  }

  @Roles(...ADMIN_ROLES)
  @ApiBearerAuth()
  @Post('2fa/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm TOTP enrollment with the first code, get recovery codes',
    description:
      'Locks the enrollment + mints 10 single-use recovery codes. Codes are shown ONCE — ' +
      'argon2 hashed at rest, no way to retrieve them later. Admin MUST save them ' +
      '(password manager / printed sheet) before leaving this screen.',
  })
  confirm2faSetup(@Req() req: Request, @Body() dto: ConfirmAdminTotpDto) {
    const user = req.user as { id: string };
    return this.totp.confirmEnrollment(user.id, dto.code);
  }

  // ── Phase D1 helpers ────────────────────────────────────────────────

  /**
   * Set the admin refresh + device cookies on the response. Skips when
   * the login is still mid-flow (`totp_required`) — only the second-
   * factor success can issue a session.
   */
  private maybeSetSessionCookies(res: Response, result: LoginResult): void {
    if (result.stage !== 'success') return;
    res.cookie(
      REFRESH_COOKIE_NAME,
      result.refreshToken,
      this.cookieOptions({
        maxAgeSeconds: this.auth.refreshCookieMaxAgeSeconds(this.auth.adminRefreshTtl()),
      }),
    );
    res.cookie(
      DEVICE_COOKIE_NAME,
      result.deviceId,
      this.cookieOptions({ maxAgeSeconds: DEVICE_COOKIE_MAX_AGE_SECONDS }),
    );
  }

  private cookieOptions({ maxAgeSeconds }: { maxAgeSeconds: number }): CookieOptions {
    return {
      httpOnly: true,
      secure: this.env.isProduction,
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: maxAgeSeconds * 1000,
    };
  }

  /**
   * Strip the body refreshToken + deviceId on the way out — the cookies
   * are the authoritative copies. accessToken stays in the body so the
   * PWA can put it straight into the in-memory store.
   */
  private scrubBody(result: LoginResult) {
    if (result.stage !== 'success') return result;
    const { refreshToken: _rt, deviceId: _did, ...rest } = result;
    void _rt;
    void _did;
    return rest;
  }

  private readDeviceMeta(req: Request): DeviceMeta {
    const cookieRaw = (req.cookies as { chopnow_did?: unknown } | undefined)?.chopnow_did;
    const deviceCookie = typeof cookieRaw === 'string' && cookieRaw.length > 0 ? cookieRaw : null;
    const userAgentRaw = req.headers['user-agent'];
    const userAgent =
      typeof userAgentRaw === 'string' && userAgentRaw.length > 0 ? userAgentRaw : null;
    const ipAddress = typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : null;
    return { deviceCookie, userAgent, ipAddress };
  }
}
