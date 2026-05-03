import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * RBAC guard. Runs after the global JwtAuthGuard. If the route has no @Roles()
 * decorator, allows the request through (auth already happened). If it does,
 * checks that req.user.role is in the allowed list.
 *
 * SUPER_ADMIN bypasses every @Roles() check by design — there's no role above
 * super-admin.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed || allowed.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: { id: string; role: UserRole } }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('forbidden');

    if (user.role === UserRole.SUPER_ADMIN) return true;
    if (allowed.includes(user.role)) return true;

    throw new ForbiddenException('insufficient_role');
  }
}
