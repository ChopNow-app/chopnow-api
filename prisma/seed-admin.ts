/**
 * Seed the first SUPER_ADMIN account. Story 1.6.
 *
 * Reads SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD from the environment. Refuses
 * to run if either is missing or if the password fails the strength rules
 * declared in AdminLoginDto.
 *
 * Usage:
 *   SEED_ADMIN_EMAIL=admin@chopnow.app \
 *   SEED_ADMIN_PASSWORD='StrongPwd!2026' \
 *   npx ts-node prisma/seed-admin.ts
 *
 * Idempotent — re-running with the same email rewrites the password hash on
 * the existing user (useful for password rotation on launch infra).
 */
import * as argon2 from 'argon2';
import { PrismaClient, UserRole } from '@prisma/client';

const PASSWORD_MIN_LENGTH = 12;

function assertStrongPassword(password: string): void {
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`min ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(password)) errors.push('at least one uppercase letter');
  if (!/\d/.test(password)) errors.push('at least one digit');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('at least one special character');
  if (errors.length > 0) {
    throw new Error(`SEED_ADMIN_PASSWORD too weak: missing ${errors.join(', ')}`);
  }
}

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase().trim();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email) throw new Error('SEED_ADMIN_EMAIL is required');
  if (!password) throw new Error('SEED_ADMIN_PASSWORD is required');
  assertStrongPassword(password);

  const prisma = new PrismaClient();
  try {
    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash, role: UserRole.SUPER_ADMIN, isActive: true, isDeleted: false },
      create: {
        email,
        passwordHash,
        role: UserRole.SUPER_ADMIN,
        displayName: 'Super Admin',
      },
    });
    console.log(`Seeded SUPER_ADMIN ${user.email} (id=${user.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
