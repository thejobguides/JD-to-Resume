import { diffPaths, EVAL_GATED, type Namespace, validateNamespace, type ValidationContext } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { ApiError, uuidv7 } from '@jmo/shared';
import { audit } from './audit';

// Config lifecycle (admin-panel.md §6.2): draft → validate → (eval gate) → activate → rollback. Versions are
// immutable; a rollback is a new activation of an old version. Every transition is audited.

export interface Actor {
  id: string;
  role: string;
  requestId?: string;
}

export async function policyContext(sql: Sql, env: ValidationContext['env']): Promise<ValidationContext> {
  const providers = await sql<Array<{ id: string; production_allowed: boolean; personal_data_allowed: boolean; trains_on_inputs: 'yes' | 'no' | 'unknown'; active: boolean }>>`
    SELECT id, production_allowed, personal_data_allowed, trains_on_inputs, active FROM ai_providers`;
  const models = await sql<Array<{ id: string; provider_id: string; status: 'candidate' | 'eval_only' | 'approved' | 'retired'; approved_tasks: string[] }>>`
    SELECT id, provider_id, status, approved_tasks FROM ai_models`;
  const credentials = await sql<Array<{ id: string; provider_id: string; scope: 'production' | 'non_production'; status: 'active' | 'standby' | 'revoked' }>>`
    SELECT id, provider_id, scope, status FROM provider_credentials`;
  return { env, providers, models, credentials };
}

export async function listVersions(sql: Sql, ns: Namespace, env: string) {
  return sql`SELECT id, version, status, rollout_pct, change_note, created_by, created_at, activated_by, activated_at, eval_run_id FROM config_versions WHERE namespace = ${ns} AND env = ${env} ORDER BY version DESC LIMIT 100`;
}

export async function getActive(sql: Sql, ns: Namespace, env: string) {
  const [row] = await sql<Array<{ id: string; version: number; data: unknown; activated_at: Date }>>`SELECT id, version, data, activated_at FROM config_versions WHERE namespace = ${ns} AND env = ${env} AND status = 'active'`;
  return row ?? null;
}

export async function createDraft(sql: Sql, ns: Namespace, env: string, data: unknown, note: string, actor: Actor) {
  if (!note || note.trim().length < 10) throw new ApiError('invalid_request', 'A change note of at least 10 characters is required.');
  return sql.begin(async (tx) => {
    const v = (await tx<Array<{ v: number }>>`SELECT COALESCE(max(version), 0) + 1 AS v FROM config_versions WHERE namespace = ${ns} AND env = ${env}`)[0]!.v;
    const id = uuidv7();
    await tx`INSERT INTO config_versions (id, namespace, env, version, data, status, change_note, created_by) VALUES (${id}, ${ns}, ${env}, ${v}, ${tx.json(data as never)}, 'draft', ${note}, ${actor.id})`;
    const auditId = await audit(tx, { actor_type: 'admin', actor_id: actor.id, actor_role: actor.role, action: 'config.draft', target_type: 'config_version', target_id: id, after: { namespace: ns, env, version: v }, reason: note, request_id: actor.requestId ?? null });
    return { id, version: v, audit_id: auditId };
  });
}

export async function validateVersion(sql: Sql, id: string) {
  const [row] = await sql<Array<{ namespace: Namespace; env: ValidationContext['env']; data: unknown }>>`SELECT namespace, env, data FROM config_versions WHERE id = ${id}`;
  if (!row) throw new ApiError('not_found', 'Config version not found.');
  const ctx = await policyContext(sql, row.env);
  const res = validateNamespace(row.namespace, row.data, ctx);
  const active = await getActive(sql, row.namespace, row.env);
  return { valid: res.ok, errors: res.ok ? [] : res.errors, diff: diffPaths(active?.data ?? null, row.data), eval_required: EVAL_GATED.has(row.namespace) };
}

export async function activateVersion(sql: Sql, id: string, actor: Actor, opts: { reason: string; evalRunId?: string | null }) {
  const [row] = await sql<Array<{ namespace: Namespace; env: ValidationContext['env']; data: unknown; status: string; version: number; eval_run_id: string | null }>>`
    SELECT namespace, env, data, status, version, eval_run_id FROM config_versions WHERE id = ${id}`;
  if (!row) throw new ApiError('not_found', 'Config version not found.');
  if (!['draft', 'approved', 'superseded', 'rolled_back'].includes(row.status)) throw new ApiError('conflict', `Version is ${row.status}.`);
  const v = validateNamespace(row.namespace, row.data, await policyContext(sql, row.env));
  if (!v.ok) throw new ApiError('invalid_request', 'This version does not pass validation.', { errors: v.errors });
  const evalRun = opts.evalRunId ?? row.eval_run_id;
  if (EVAL_GATED.has(row.namespace) && row.env === 'production') {
    const [er] = evalRun ? await sql<Array<{ passed: boolean }>>`SELECT passed FROM eval_runs WHERE id = ${evalRun}` : [];
    if (!er?.passed) throw new ApiError('precondition_failed', `Activating ${row.namespace} needs a passing eval run (admin-panel.md §6.3).`, { eval_required: true });
  }
  return sql.begin(async (tx) => {
    const [prev] = await tx<Array<{ id: string; version: number; data: unknown }>>`SELECT id, version, data FROM config_versions WHERE namespace = ${row.namespace} AND env = ${row.env} AND status = 'active' FOR UPDATE`;
    if (prev) await tx`UPDATE config_versions SET status = 'superseded' WHERE id = ${prev.id}`;
    await tx`UPDATE config_versions SET status = 'active', activated_by = ${actor.id}, activated_at = now(), eval_run_id = COALESCE(${evalRun ?? null}, eval_run_id) WHERE id = ${id}`;
    const auditId = await audit(tx, {
      actor_type: 'admin',
      actor_id: actor.id,
      actor_role: actor.role,
      action: row.status === 'superseded' || row.status === 'rolled_back' ? 'config.rollback' : 'config.activate',
      target_type: 'config_version',
      target_id: id,
      before: prev ? { version: prev.version, changes: diffPaths(prev.data, row.data).slice(0, 50) } : null,
      after: { namespace: row.namespace, env: row.env, version: row.version },
      reason: opts.reason,
      request_id: actor.requestId ?? null,
    });
    return { activated: row.version, previous: prev?.version ?? null, audit_id: auditId };
  });
}

/** One-click rollback: re-activates the most recent superseded version. */
export async function rollback(sql: Sql, ns: Namespace, env: string, actor: Actor, reason: string) {
  const [prev] = await sql<Array<{ id: string; eval_run_id: string | null }>>`
    SELECT id, eval_run_id FROM config_versions WHERE namespace = ${ns} AND env = ${env} AND status = 'superseded' ORDER BY activated_at DESC NULLS LAST, version DESC LIMIT 1`;
  if (!prev) throw new ApiError('not_found', 'No previous version to roll back to.');
  const [cur] = await sql<Array<{ id: string }>>`SELECT id FROM config_versions WHERE namespace = ${ns} AND env = ${env} AND status = 'active'`;
  const res = await activateVersion(sql, prev.id, actor, { reason, evalRunId: prev.eval_run_id });
  if (cur) await sql`UPDATE config_versions SET status = 'rolled_back' WHERE id = ${cur.id}`;
  return res;
}
