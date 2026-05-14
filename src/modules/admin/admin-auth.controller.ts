import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../shared/decorators/public.decorator';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';

@ApiTags('admin-auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  // Public: admin doesn't have a JWT yet at this point. Strict per-IP throttle
  // (5/min) discourages credential-stuffing in addition to the per-account
  // lockout (5 failed/15min → locked).
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60 * 1000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Admin login (email + password)',
    description:
      'Story 1.6 — issues an 8h access JWT for ADMIN/SUPER_ADMIN/OPERATOR/VIEWER users. ' +
      'No refresh-token flow (admin re-enters password at end of session). ' +
      'Lockout: 5 failed attempts in 15 min → account_locked; super-admin must unlock. ' +
      'Error codes (body.code on 401): invalid_credentials, account_locked.',
  })
  login(@Body() dto: AdminLoginDto) {
    return this.adminAuth.login(dto.email, dto.password);
  }
}
