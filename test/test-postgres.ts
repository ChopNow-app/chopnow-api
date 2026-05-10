import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { execFileSync } from 'child_process';

/**
 * Boots a postgis-enabled Postgres container, applies all Prisma migrations,
 * and returns the connection URL. Use from `beforeAll` in *.integration.spec.ts.
 *
 * Usage:
 *   const ctx = await startTestPostgres();
 *   process.env.DATABASE_URL = ctx.url;
 *   // ...build PrismaService against ctx.url...
 *   afterAll(() => ctx.stop());
 */
export interface TestPostgresContext {
  url: string;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgresContext> {
  const container: StartedTestContainer = await new GenericContainer('postgis/postgis:16-3.4')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgresql://test:test@${host}:${port}/test?schema=public`;

  // Apply migrations against the fresh container. execFileSync (not exec) — no shell.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  return {
    url,
    stop: async () => {
      await container.stop();
    },
  };
}
