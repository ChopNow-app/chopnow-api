import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'allowedRoles';

/**
 * Restricts a route to one or more roles. Combine with the global JwtAuthGuard
 * (no need to add @UseGuards) — the RolesGuard runs after auth and inspects this
 * decorator's metadata.
 *
 * @example
 *   @Roles(UserRole.SUPER_ADMIN)
 *   @Patch('/commissions/:vendorId')
 *   updateCommission(...) { ... }
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
