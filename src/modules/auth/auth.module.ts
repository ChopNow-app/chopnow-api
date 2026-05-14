import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtRevocationService } from './jwt-revocation.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RefreshJwtStrategy } from './strategies/refresh-jwt.strategy';

// EnvService is provided globally by AppConfigModule (see app.module.ts).
@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, JwtRevocationService, JwtStrategy, RefreshJwtStrategy],
  // Exported so admin suspension endpoints (Stories 6.2 / 6.8 / 6.9) can
  // call revokeUser() / reactivateUser() once they exist.
  exports: [AuthService, JwtRevocationService],
})
export class AuthModule {}
