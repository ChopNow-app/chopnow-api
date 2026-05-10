import { PrismaClient, UserRole } from '@prisma/client';
import { startTestPostgres, TestPostgresContext } from './test-postgres';

/**
 * Reference integration test.
 *
 * Run with: `npm run test:integration` (also runs in CI on every PR — see
 * .github/workflows/ci.yml).
 *
 * This pattern is the canonical example for any Sprint 1+ story whose logic
 * depends on real Postgres semantics (PostGIS, transactions, unique constraints,
 * triggers). For unit tests of pure logic, keep using mocked Prisma.
 */
describe('Users (integration)', () => {
  let ctx: TestPostgresContext;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ctx = await startTestPostgres();
    prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await ctx.stop();
  });

  it('creates and reads a CONSUMER user', async () => {
    const user = await prisma.user.create({
      data: { phone: '670000000', role: UserRole.CONSUMER },
    });
    const found = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(found.phone).toBe('670000000');
    expect(found.role).toBe(UserRole.CONSUMER);
  });
});
