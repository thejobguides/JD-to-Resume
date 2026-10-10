import type { Db, Sql } from '@jmo/db';
import { uuidv7 } from '@jmo/shared';
import { maskEmail } from './analytics/queries';
import { openJson, sealJson } from './crypto';

// Opt-in content store (migration 0003): for users who agreed to it, the job posts they analyze, the minimized resume
// they send for tailoring (the extension strips name and contact details) and the tailored result, kept for product
// analysis. Each row is AES-GCM encrypted; the AAD binds a ciphertext to its user, kind and id, so rows can't be
// swapped between users. Nothing is saved for users who have not opted in.

export const CONTENT_RETENTION_DAYS = 365;
export const CONTENT_KEY_VERSION = 1;
export type ContentKind = 'job_post' | 'resume' | 'result';

export interface ContentMeta {
  id: string;
  user_id: string;
  kind: ContentKind;
  optimization_id: string | null;
  job_analysis_id: string | null;
  meta: Record<string, unknown>;
  bytes: number;
  created_at: Date;
  expires_at: Date;
}

const aad = (id: string, userId: string, kind: string) => `content:${userId}:${kind}:${id}`;

/**
 * Saves one item if, and only if, the user has opted in; returns its id (null when not opted in). The user row is
 * share-locked for the insert, so a concurrent opt-out (which deletes everything) can't leave a row behind.
 */
export async function saveContent(
  sql: Sql,
  key: string,
  item: { userId: string; kind: ContentKind; payload: unknown; meta?: Record<string, unknown>; optimizationId?: string | null; jobAnalysisId?: string | null; now?: Date; oncePerJob?: boolean },
): Promise<string | null> {
  return sql.begin(async (tx) => {
    const [u] = await tx<Array<{ content_opt_in: boolean }>>`SELECT content_opt_in FROM users WHERE id = ${item.userId} AND status = 'active' FOR SHARE`;
    if (!u?.content_opt_in) return null;
    // A job post analyzed again (cache hit, another session) is saved once per user.
    if (item.oncePerJob && item.jobAnalysisId && (await tx`SELECT 1 FROM stored_content WHERE user_id = ${item.userId} AND kind = ${item.kind} AND job_analysis_id = ${item.jobAnalysisId} AND expires_at > now()`).length) return null;
    const id = uuidv7();
    const sealed = await sealJson(item.payload, key, aad(id, item.userId, item.kind));
    const now = item.now ?? new Date();
    await tx`INSERT INTO stored_content (id, user_id, kind, optimization_id, job_analysis_id, meta, bytes, iv, ciphertext, key_version, expires_at)
             VALUES (${id}, ${item.userId}, ${item.kind}, ${item.optimizationId ?? null}, ${item.jobAnalysisId ?? null}, ${tx.json((item.meta ?? {}) as never)},
                     ${new TextEncoder().encode(JSON.stringify(item.payload)).length}, ${sealed.iv}, ${sealed.ciphertext}, ${CONTENT_KEY_VERSION},
                     ${new Date(now.getTime() + CONTENT_RETENTION_DAYS * 86_400_000)})`;
    return id;
  });
}

/** Opting out deletes everything already saved for the user, in the same transaction. */
export async function setContentOptIn(sql: Sql, userId: string, on: boolean): Promise<{ deleted: number }> {
  return sql.begin(async (tx) => {
    await tx`SELECT 1 FROM users WHERE id = ${userId} FOR UPDATE`;
    await tx`UPDATE users SET content_opt_in = ${on}, content_opt_in_at = CASE WHEN ${on} THEN COALESCE(content_opt_in_at, now()) ELSE NULL END, updated_at = now() WHERE id = ${userId}`;
    if (on) return { deleted: 0 };
    return { deleted: (await tx`DELETE FROM stored_content WHERE user_id = ${userId} RETURNING 1`).length };
  });
}

export async function deleteUserContent(sql: Sql, userId: string): Promise<number> {
  return (await sql`DELETE FROM stored_content WHERE user_id = ${userId} RETURNING 1`).length;
}

/** Adds fields (e.g. the client's before/after scores) to the stored result of an optimization. */
export async function annotateResult(sql: Sql, userId: string, optimizationId: string, patch: Record<string, unknown>): Promise<void> {
  await sql`UPDATE stored_content SET meta = meta || ${sql.json(patch as never)} WHERE user_id = ${userId} AND optimization_id = ${optimizationId} AND kind = 'result'`;
}

async function decrypt(key: string, r: ContentMeta & { iv: Uint8Array; ciphertext: Uint8Array }) {
  const { iv, ciphertext, ...rest } = r;
  return { ...rest, payload: await openJson<unknown>(iv, ciphertext, key, aad(r.id, r.user_id, r.kind)) };
}

export async function readContent(sql: Sql, key: string, id: string) {
  const [r] = await sql<Array<ContentMeta & { iv: Uint8Array; ciphertext: Uint8Array }>>`
    SELECT id, user_id, kind, optimization_id, job_analysis_id, meta, bytes, created_at, expires_at, iv, ciphertext FROM stored_content WHERE id = ${id} AND expires_at > now()`;
  return r ? decrypt(key, r) : null;
}

/** The user's own saved items, decrypted (account export: the right of access). */
export async function userContent(db: Db, key: string, userId: string) {
  const rows = await db<Array<ContentMeta & { iv: Uint8Array; ciphertext: Uint8Array }>>`
    SELECT id, user_id, kind, optimization_id, job_analysis_id, meta, bytes, created_at, expires_at, iv, ciphertext
    FROM stored_content WHERE user_id = ${userId} AND expires_at > now() ORDER BY created_at DESC LIMIT 2000`;
  return Promise.all(rows.map(async (r) => {
    const { user_id: _u, ...d } = await decrypt(key, r);
    return d;
  }));
}

export interface ContentFilter {
  kind?: ContentKind | undefined;
  userId?: string | undefined;
  optimizationId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

/** Metadata only (no content), for the admin list. */
export async function listContent(sql: Sql, f: ContentFilter = {}) {
  const rows = await sql<Array<ContentMeta & { email: string }>>`
    SELECT s.id, s.user_id, s.kind, s.optimization_id, s.job_analysis_id, s.meta, s.bytes, s.created_at, s.expires_at, u.email
    FROM stored_content s JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > now()
      AND (${f.kind ?? null}::text IS NULL OR s.kind = ${f.kind ?? null})
      AND (${f.userId ?? null}::uuid IS NULL OR s.user_id = ${f.userId ?? null})
      AND (${f.optimizationId ?? null}::uuid IS NULL OR s.optimization_id = ${f.optimizationId ?? null})
      AND (${f.from ?? null}::timestamptz IS NULL OR s.created_at >= ${f.from ?? null})
      AND (${f.to ?? null}::timestamptz IS NULL OR s.created_at < ${f.to ?? null})
    ORDER BY s.created_at DESC LIMIT ${Math.min(500, f.limit ?? 100)}`;
  return rows.map(({ email, ...r }) => ({ ...r, user_email_masked: maskEmail(email) }));
}

/** Decrypted rows for the owner's offline analysis export (JSON Lines). */
export async function exportContent(sql: Sql, key: string, f: ContentFilter = {}) {
  const rows = await sql<Array<ContentMeta & { iv: Uint8Array; ciphertext: Uint8Array }>>`
    SELECT id, user_id, kind, optimization_id, job_analysis_id, meta, bytes, created_at, expires_at, iv, ciphertext FROM stored_content
    WHERE expires_at > now()
      AND (${f.kind ?? null}::text IS NULL OR kind = ${f.kind ?? null})
      AND (${f.from ?? null}::timestamptz IS NULL OR created_at >= ${f.from ?? null})
      AND (${f.to ?? null}::timestamptz IS NULL OR created_at < ${f.to ?? null})
    ORDER BY created_at LIMIT ${Math.min(20_000, f.limit ?? 5000)}`;
  return Promise.all(rows.map((r) => decrypt(key, r)));
}

/** Aggregates only: safe for every admin role. */
export async function contentStats(sql: Sql) {
  const [u] = await sql<Array<{ opted_in: number; users: number }>>`SELECT count(*) FILTER (WHERE content_opt_in)::int AS opted_in, count(*)::int AS users FROM users WHERE status = 'active'`;
  const byKind = await sql<Array<{ kind: ContentKind; n: number; bytes: number; last_30d: number }>>`
    SELECT kind, count(*)::int AS n, COALESCE(sum(bytes), 0)::int AS bytes, count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS last_30d
    FROM stored_content WHERE expires_at > now() GROUP BY kind ORDER BY kind`;
  const [o] = await sql<Array<{ n: number; with_scores: number; avg_gain: number | null }>>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE meta ? 'after_score')::int AS with_scores,
           avg((meta->>'after_score')::numeric - (meta->>'before_score')::numeric) FILTER (WHERE meta ? 'after_score') AS avg_gain
    FROM stored_content WHERE kind = 'result' AND expires_at > now()`;
  return {
    users: { active: u!.users, opted_in: u!.opted_in, opt_in_rate: u!.users ? u!.opted_in / u!.users : 0 },
    by_kind: byKind,
    results: { total: o!.n, with_scores: o!.with_scores, avg_score_gain: o!.avg_gain === null ? null : Math.round(Number(o!.avg_gain) * 10) / 10 },
    retention_days: CONTENT_RETENTION_DAYS,
  };
}

export async function purgeExpiredContent(sql: Sql, now = new Date()): Promise<number> {
  return (await sql`DELETE FROM stored_content WHERE expires_at < ${now} RETURNING 1`).length;
}
