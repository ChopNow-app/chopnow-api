import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Public } from '../../shared/decorators/public.decorator';
import { PhoneRateLimit } from '../../shared/decorators/phone-rate-limit.decorator';
import { PhoneRateLimitGuard } from '../../shared/guards/phone-rate-limit.guard';
import { AuthService } from './auth.service';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  // Story 1.1 spec: 5 OTP requests per 15 min per IP …
  @Throttle({ otp: { limit: 5, ttl: 15 * 60 * 1000 } })
  // … and 5 per 15 min per phone (prevents enumeration of a single number)
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
  // Verification is cheaper but still bounded — 10 attempts per 15 min per IP
  @Throttle({ otp: { limit: 10, ttl: 15 * 60 * 1000 } })
  @PhoneRateLimit({ limit: 10, ttlSeconds: 15 * 60 })
  @UseGuards(PhoneRateLimitGuard)
  @Post('verify-otp')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify OTP',
    description: 'Returns access + refresh JWT on success. Creates the user on first verify.',
  })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.phone, dto.code);
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
      'Story 1.2 — returns a new access + refresh pair. Old refresh becomes invalid (rotation). ' +
      'Replaying an already-rotated refresh revokes the entire family. ' +
      'Error codes (body.code on 401): refresh_invalid_or_expired, refresh_reuse_detected, user_suspended.',
  })
  refresh(
    @Body() _dto: RefreshTokenDto,
    @Req() req: { user: { id: string; role: UserRole; refreshToken: string } },
  ) {
    // _dto is here only so class-validator rejects empty bodies with a 400.
    // The actual values come from req.user (populated by RefreshJwtStrategy).
    return this.auth.refresh(req.user.id, req.user.role, req.user.refreshToken);
  }
}
