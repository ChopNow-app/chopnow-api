import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../shared/decorators/public.decorator';
import { PhoneRateLimit } from '../../shared/decorators/phone-rate-limit.decorator';
import { PhoneRateLimitGuard } from '../../shared/guards/phone-rate-limit.guard';
import { AuthService } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

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
}
