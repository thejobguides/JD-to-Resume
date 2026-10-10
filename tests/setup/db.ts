import { createSql, migrate, seed, type Sql } from '@jmo/db';

// Creates (once) and resets a dedicated test database next to the dev one. Tests skip when Postgres is down.

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://jmo:jmo@localhost:54329/jmo';

export async function dbAvailable(): Promise<boolean> {
  const sql = createSql(ADMIN_URL, { max: 1 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export async function freshDatabase(name: string): Promise<{ sql: Sql; url: string }> {
  const admin = createSql(ADMIN_URL, { max: 1 });
  try {
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (!exists.length) await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end({ timeout: 1 });
  }
  const url = ADMIN_URL.replace(/\/[^/]+$/, `/${name}`);
  const sql = createSql(url, { max: 10 });
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql, () => undefined);
  await seed(sql, { ownerEmail: 'owner@example.com', useMockAi: true }, () => undefined);
  return { sql, url };
}
