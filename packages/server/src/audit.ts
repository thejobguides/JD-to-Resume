import { canonicalJson } from '@jmo/config';
import type { Db, Sql } from '@jmo/db';
import { sha256Hex } from '@jmo/shared';

// Append-only, hash-chained audit log (admin-panel.md §8.5). Every admin write and sensitive read goes here,
// in the SAME transaction as the change it describes.

export interface AuditEntry {
  actor_type: 'user' | 'admin' | 'system' | 'webhook';
  actor_id?: string | null;
  actor_role?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  request_id?: string | null;
}

const AUDIT_LOCK = 727274;
const SECRET_KEYS = /secret|token|password|api_?key|ciphertext|wrapped_dek|private/i;

/** Drops secrets from before/after snapshots. */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : redact(x)]));
  }
  return v;
}

function rowCanonical(r: { occurred_at: string; prev_hash_hex: string } & AuditEntry): string {
  return canonicalJson({
    occurred_at: r.occurred_at,
    prev: r.prev_hash_hex,
    actor_type: r.actor_type,
    actor_id: r.actor_id ?? null,
    actor_role: r.actor_role ?? null,
    action: r.action,
    target_type: r.target_type ?? null,
    target_id: r.target_id ?? null,
    before: r.before ?? null,
    after: r.after ?? null,
    reason: r.reason ?? null,
    request_id: r.request_id ?? null,
  });
}

const toHex = (b: Uint8Array | null | undefined) => (b ? Buffer.from(b).toString('hex') : '');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** Must be called inside a transaction (the advisory lock serializes appends so the chain never forks). */
export async function audit(tx: Db, e: AuditEntry): Promise<number> {
  await tx`SELECT pg_advisory_xact_lock(${AUDIT_LOCK})`;
  const [last] = await tx<{ row_hash: Uint8Array }[]>`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`;
  const prevHex = toHex(last?.row_hash);
  const occurred_at = new Date().toISOString();
  const entry = { ...e, before: redact(e.before ?? null), after: redact(e.after ?? null) };
  const hash = await sha256Hex(rowCanonical({ ...entry, occurred_at, prev_hash_hex: prevHex }));
  const [row] = await tx<{ id: bigint }[]>`
    INSERT INTO audit_log (occurred_at, actor_type, actor_id, actor_role, action, target_type, target_id, before, after, reason, request_id, prev_hash, row_hash)
    VALUES (${occurred_at}, ${e.actor_type}, ${e.actor_id ?? null}, ${e.actor_role ?? null}, ${e.action}, ${e.target_type ?? null}, ${e.target_id ?? null},
            ${entry.before === null ? null : tx.json(entry.before as never)}, ${entry.after === null ? null : tx.json(entry.after as never)},
            ${e.reason ?? null}, ${e.request_id ?? null}, ${prevHex ? fromHex(prevHex) : null}, ${fromHex(hash)})
    RETURNING id`;
  return Number(row!.id);
}

export async function auditStandalone(sql: Sql, e: AuditEntry): Promise<number> {
  return sql.begin((tx) => audit(tx, e));
}

/** Recomputes the chain; returns the first broken row id, if any. */
export async function verifyAuditChain(sql: Sql, fromId = 0): Promise<{ ok: boolean; checked: number; broken_at?: number }> {
  const rows = await sql<Array<{ id: bigint; occurred_at: Date; actor_type: string; actor_id: string | null; actor_role: string | null; action: string; target_type: string | null; target_id: string | null; before: unknown; after: unknown; reason: string | null; request_id: string | null; prev_hash: Uint8Array | null; row_hash: Uint8Array }>>`
    SELECT * FROM audit_log WHERE id > ${fromId} ORDER BY id`;
  let prev = fromId > 0 ? toHex((await sql<{ row_hash: Uint8Array }[]>`SELECT row_hash FROM audit_log WHERE id = ${fromId}`)[0]?.row_hash) : '';
  let checked = 0;
  for (const r of rows) {
    if (toHex(r.prev_hash) !== prev) return { ok: false, checked, broken_at: Number(r.id) };
    const hash = await sha256Hex(
      rowCanonical({
        occurred_at: r.occurred_at.toISOString(),
        prev_hash_hex: prev,
        actor_type: r.actor_type as AuditEntry['actor_type'],
        actor_id: r.actor_id,
        actor_role: r.actor_role,
        action: r.action,
        target_type: r.target_type,
        target_id: r.target_id,
        before: r.before,
        after: r.after,
        reason: r.reason,
        request_id: r.request_id,
      }),
    );
    if (hash !== toHex(r.row_hash)) return { ok: false, checked, broken_at: Number(r.id) };
    prev = hash;
    checked++;
  }
  return { ok: true, checked };
}
