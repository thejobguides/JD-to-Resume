import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './client';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Applies pending SQL migrations in order, each in its own transaction (expand → migrate → contract). */
export async function migrate(sql: Sql, log: (s: string) => void = console.log): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const text = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
    });
    log(`applied ${f}`);
    applied.push(f);
  }
  return applied;
}

/** Drops everything (tests and local reset only). */
export async function resetDatabase(sql: Sql): Promise<void> {
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}
