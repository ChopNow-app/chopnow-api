import { UserRole } from '@prisma/client';

/**
 * Centralised admin-role lists for `@Roles()` decorators on admin
 * controllers.
 *
 * Two flavours:
 *   - `ADMIN_WRITE_ROLES` — anyone who can perform write actions on the
 *     admin surface (approve a vendor, retry a payout, suspend a rider).
 *     SUPER_ADMIN is intentionally absent: `RolesGuard` bypasses every
 *     `@Roles()` check for SUPER_ADMIN, so including it would be noise.
 *   - `ADMIN_ANY_ROLE` — broader list that also includes VIEWER. Used by
 *     endpoints every admin needs to reach regardless of write capability,
 *     primarily TOTP enrollment.
 *
 * Why one place instead of per-controller constants:
 *   - Before this file, five admin controllers each defined their own
 *     `ADMIN_ROLES` constant with subtly different membership (some
 *     included VIEWER, some explicitly listed SUPER_ADMIN, some didn't).
 *     None of the drift was exploitable thanks to the SUPER_ADMIN bypass,
 *     but it made future role changes risky — adding a new admin role
 *     would need to land in five files in lockstep.
 *   - Single import here means: change the canonical list in one place,
 *     every admin endpoint stays consistent.
 */
export const ADMIN_WRITE_ROLES = [UserRole.OPERATOR, UserRole.ADMIN] as const;

export const ADMIN_ANY_ROLE = [UserRole.OPERATOR, UserRole.ADMIN, UserRole.VIEWER] as const;
