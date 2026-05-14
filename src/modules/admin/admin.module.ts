import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';

/**
 * Admin domain — auth (Story 1.6), audit log (1.6 + 6.x), validation queues
 * (6.2), commission management (6.6), etc.
 *
 * Admin tokens are signed with the same access secret as consumer tokens
 * (just with an 8h `expiresIn` override), so the existing global
 * JwtAuthGuard validates them transparently. Role differentiation goes
 * through @Roles() + RolesGuard.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AdminAuthController],
  providers: [AdminAuthService],
  exports: [AdminAuthService],
})
export class AdminModule {}
