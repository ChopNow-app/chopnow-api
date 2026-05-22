import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { Public } from '../../shared/decorators/public.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { AdminAuthService } from './admin-auth.service';
import { AdminTotpService } from './admin-totp.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { ConfirmAdminTotpDto, VerifyAdminTotpDto } from './dto/admin-2fa.dto';

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
  login(@Body() dto: AdminLoginDto) {
    return this.adminAuth.login(dto.email, dto.password);
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
  verify2fa(@Body() dto: VerifyAdminTotpDto) {
    return this.adminAuth.verifyTotpChallenge(dto.challenge, dto.code, Boolean(dto.isRecoveryCode));
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
}
