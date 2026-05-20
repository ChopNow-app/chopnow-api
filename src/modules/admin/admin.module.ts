import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { FinanceModule } from '../finance/finance.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminMetricsController } from './admin-metrics.controller';
import { AdminMetricsService } from './admin-metrics.service';
import { AdminValidationController } from './admin-validation.controller';
import { AdminValidationService } from './admin-validation.service';

/**
 * Admin domain — auth (Story 1.6), validation queues (6.2), audit log
 * (6.x), commission management (6.6), etc.
 *
 * Admin tokens are signed with the same access secret as consumer tokens
 * (just with an 8h `expiresIn` override), so the existing global
 * JwtAuthGuard validates them transparently. Role differentiation goes
 * through @Roles() + RolesGuard.
 *
 * Story 6.2 ✅ — vendor + rider approve/reject/suspend/unsuspend, with
 *                WhatsApp notification on each terminal decision and
 *                immediate JWT revocation on suspend.
 *
 * AuthModule import gives us JwtRevocationService for the suspend flow.
 */
@Module({
  imports: [JwtModule.register({}), AuthModule, FinanceModule],
  controllers: [
    AdminAuthController,
    AdminValidationController,
    AdminMetricsController,
    AdminFinanceController,
  ],
  providers: [AdminAuthService, AdminValidationService, AdminMetricsService],
  exports: [AdminAuthService, AdminValidationService, AdminMetricsService],
})
export class AdminModule {}
