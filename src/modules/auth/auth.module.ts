import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthCaptchaConfigController } from './auth-captcha-config.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';
import { JwtRevocationService } from './jwt-revocation.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RefreshJwtStrategy } from './strategies/refresh-jwt.strategy';
import { NotificationsModule } from '../notifications/notifications.module';

// EnvService is provided globally by AppConfigModule (see app.module.ts).
@Module({
  // Phase D3 — DeviceService fans out Web Push notifications on new-
  // device sign-in (in addition to the C2 email). Pulls WebPushService
  // from NotificationsModule.
  imports: [PassportModule, JwtModule.register({}), NotificationsModule],
  controllers: [AuthController, AuthCaptchaConfigController],
  providers: [AuthService, DeviceService, JwtRevocationService, JwtStrategy, RefreshJwtStrategy],
  // Exported so admin suspension endpoints (Stories 6.2 / 6.8 / 6.9) can
  // call revokeUser() / reactivateUser() once they exist.
  exports: [AuthService, JwtRevocationService],
})
export class AuthModule {}
