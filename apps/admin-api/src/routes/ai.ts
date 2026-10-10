import { audit } from '@jmo/server';
import { ApiError } from '@jmo/shared';
import { unb64 } from '@jmo/vault';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminEnv } from '../context';
import { need, reasonOf, stepUp } from '../guard';
import { parse } from '../util';

// AI providers, write-only key vault, models (admin-panel.md §6.5). The admin plane stores ciphertext produced in
// the admin's browser and can never decrypt it; key tests run in the API over an internal call.

export const ai = new Hono<AdminEnv>();

const Kind = z.enum(['openai', 'anthropic', 'google', 'openai_compatible']);

ai.get('/ai/providers', need('dashboards.view'), async (c) => c.json({ data: await c.get('deps').sql`SELECT * FROM ai_providers ORDER BY id` }));

ai.post('/ai/providers', need('providers.policy'), stepUp, async (c) => {
  const b = await parse(c, z.object({ id: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.string().max(80), kind: Kind, base_url: z.string().url().nullable().optional(), terms_url: z.string().url(), reason: z.string() }));
  const reason = reasonOf(b);
  if (b.kind === 'openai_compatible' && !b.base_url) throw new ApiError('invalid_request', 'OpenAI-compatible providers need a base URL.');
  // Keys are sent to this URL: plain http would expose them, and in production it is also an SSRF foothold.
  if (b.base_url && c.get('deps').env.ENV === 'production' && new URL(b.base_url).protocol !== 'https:') throw new ApiError('invalid_request', 'Provider base URLs must use https.');
  const a = c.get('admin');
  const res = await c.get('deps').sql.begin(async (tx) => {
    // New providers start with every policy flag closed: not production, no personal data, unknown training.
    await tx`INSERT INTO ai_providers (id, name, kind, base_url, production_allowed, personal_data_allowed, trains_on_inputs, terms_url, terms_reviewed_on)
             VALUES (${b.id}, ${b.name}, ${b.kind}, ${b.base_url ?? null}, false, false, 'unknown', ${b.terms_url}, current_date)`;
    return { audit_id: await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'provider.create', target_type: 'provider', target_id: b.id, after: { kind: b.kind, base_url: b.base_url }, reason, request_id: c.get('requestId') }) };
  });
  return c.json(res, 201);
});

ai.patch('/ai/providers/:id', need('providers.policy'), stepUp, async (c) => {
  const b = await parse(c, z.object({ production_allowed: z.boolean().optional(), personal_data_allowed: z.boolean().optional(), trains_on_inputs: z.enum(['yes', 'no', 'unknown']).optional(), active: z.boolean().optional(), retention_note: z.string().max(500).optional(), terms_url: z.string().url().optional(), dpa_signed_at: z.string().nullable().optional(), reason: z.string() }));
  const reason = reasonOf(b);
  const policyChange = b.production_allowed !== undefined || b.personal_data_allowed !== undefined || b.trains_on_inputs !== undefined;
  if (policyChange && !b.terms_url) throw new ApiError('invalid_request', 'Changing a data-policy flag needs the terms URL that supports it.');
  const a = c.get('admin');
  const res = await c.get('deps').sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM ai_providers WHERE id = ${c.req.param('id')} FOR UPDATE`;
    if (!before) throw new ApiError('not_found', 'Provider not found.');
    await tx`UPDATE ai_providers SET production_allowed = COALESCE(${b.production_allowed ?? null}, production_allowed), personal_data_allowed = COALESCE(${b.personal_data_allowed ?? null}, personal_data_allowed),
             trains_on_inputs = COALESCE(${b.trains_on_inputs ?? null}, trains_on_inputs), active = COALESCE(${b.active ?? null}, active), retention_note = COALESCE(${b.retention_note ?? null}, retention_note),
             terms_url = COALESCE(${b.terms_url ?? null}, terms_url), terms_reviewed_on = CASE WHEN ${policyChange} THEN current_date ELSE terms_reviewed_on END,
             dpa_signed_at = ${b.dpa_signed_at === undefined ? before.dpa_signed_at : b.dpa_signed_at} WHERE id = ${before.id}`;
    return { audit_id: await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: policyChange ? 'provider.policy_change' : 'provider.update', target_type: 'provider', target_id: before.id, before: { production_allowed: before.production_allowed, personal_data_allowed: before.personal_data_allowed, trains_on_inputs: before.trains_on_inputs, active: before.active }, after: b, reason, request_id: c.get('requestId') }) };
  });
  await c.get('deps').internal('/internal/config/invalidate').catch(() => undefined);
  return c.json(res);
});

ai.get('/ai/vault/public-key', need('keys.manage'), async (c) => {
  const { env } = c.get('deps');
  if (!env.VAULT_PUBLIC_KEY_JWK) throw new ApiError('internal', 'Vault public key is not configured.');
  return c.json({ public_jwk: env.VAULT_PUBLIC_KEY_JWK, vault_key_version: env.VAULT_KEY_VERSION });
});

ai.get('/ai/credentials', need('keys.test'), async (c) => {
  const rows = await c.get('deps').sql`
    SELECT k.id, k.provider_id, k.label, k.env, k.scope, k.last4, k.status, k.monthly_soft_budget_usd, k.last_used_at, k.last_test_at, k.last_test_result, k.created_at, k.revoked_at,
           (SELECT COALESCE(sum(cost_usd), 0) FROM ai_requests a WHERE a.credential_id = k.id AND a.created_at >= date_trunc('month', now())) AS spend_mtd_usd
    FROM provider_credentials k ORDER BY k.created_at DESC`;
  return c.json({ data: rows.map((r) => ({ ...r, spend_mtd_usd: Number(r.spend_mtd_usd) })) });
});

const b64 = z.string().regex(/^[A-Za-z0-9+/=]+$/).max(8192);
ai.post('/ai/credentials', need('keys.manage'), stepUp, async (c) => {
  const b = await parse(c, z.object({ provider_id: z.string(), label: z.string().min(2).max(60), env: z.enum(['production', 'staging', 'eval']), scope: z.enum(['production', 'non_production']), ciphertext: b64, wrapped_dek: b64, iv: b64, vault_key_version: z.number().int(), last4: z.string().length(4), monthly_soft_budget_usd: z.number().min(0).max(100_000).nullable().optional(), reason: z.string() }));
  const reason = reasonOf(b);
  const a = c.get('admin');
  const { sql } = c.get('deps');
  const [p] = await sql<Array<{ id: string; production_allowed: boolean }>>`SELECT id, production_allowed FROM ai_providers WHERE id = ${b.provider_id}`;
  if (!p) throw new ApiError('not_found', 'Unknown provider.');
  if (b.scope === 'production' && !p.production_allowed) throw new ApiError('invalid_request', `Provider "${p.id}" is not allowed in production by its terms; add this key with scope "non_production" (evals only).`);
  const id = `cred_${b.provider_id}_${b.env}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await sql.begin(async (tx) => {
    await tx`INSERT INTO provider_credentials (id, provider_id, label, env, scope, ciphertext, wrapped_dek, iv, vault_key_version, last4, status, monthly_soft_budget_usd, created_by)
             VALUES (${id}, ${b.provider_id}, ${b.label}, ${b.env}, ${b.scope}, ${unb64(b.ciphertext)}, ${unb64(b.wrapped_dek)}, ${unb64(b.iv)}, ${b.vault_key_version}, ${b.last4}, 'active', ${b.monthly_soft_budget_usd ?? null}, ${a.id})`;
    return { id, audit_id: await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'credential.create', target_type: 'credential', target_id: id, after: { provider_id: b.provider_id, label: b.label, env: b.env, scope: b.scope, last4: b.last4 }, reason, request_id: c.get('requestId') }) };
  });
  return c.json(res, 201);
});

ai.post('/ai/credentials/:id/test', need('keys.test'), async (c) => {
  const { sql, internal } = c.get('deps');
  const r = (await internal(`/internal/credentials/${encodeURIComponent(c.req.param('id'))}/test`)) as { ok: boolean; latency_ms: number; error_class?: string; json_mode_ok?: boolean };
  await sql`UPDATE provider_credentials SET last_test_at = now(), last_test_result = ${r.ok ? `ok ${r.latency_ms}ms${r.json_mode_ok === false ? ' (no JSON mode)' : ''}` : `failed: ${r.error_class}`} WHERE id = ${c.req.param('id')}`;
  return c.json(r);
});

for (const [verb, status] of [['activate', 'active'], ['standby', 'standby'], ['revoke', 'revoked']] as const) {
  ai.post(`/ai/credentials/:id/${verb}`, need('keys.manage'), stepUp, async (c) => {
    const reason = reasonOf(await parse(c, z.object({ reason: z.string() })));
    const a = c.get('admin');
    const res = await c.get('deps').sql.begin(async (tx) => {
      const [before] = await tx`SELECT status FROM provider_credentials WHERE id = ${c.req.param('id')} FOR UPDATE`;
      if (!before) throw new ApiError('not_found', 'Key not found.');
      if (before.status === 'revoked') throw new ApiError('conflict', 'Revoked keys cannot change. Add a new key.');
      await tx`UPDATE provider_credentials SET status = ${status}, revoked_at = ${status === 'revoked' ? new Date() : null}, revoked_by = ${status === 'revoked' ? a.id : null} WHERE id = ${c.req.param('id')}`;
      return { audit_id: await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: `credential.${verb}`, target_type: 'credential', target_id: c.req.param('id'), before, after: { status }, reason, request_id: c.get('requestId') }) };
    });
    await c.get('deps').internal('/internal/config/invalidate').catch(() => undefined);
    return c.json({ ...res, note: verb === 'revoke' ? 'Also revoke this key at the provider — that is the real kill switch.' : undefined });
  });
}

ai.get('/ai/models', need('dashboards.view'), async (c) => c.json({ data: await c.get('deps').sql`SELECT * FROM ai_models ORDER BY provider_id, id` }));

ai.post('/ai/models', need('models.edit'), async (c) => {
  const b = await parse(c, z.object({ provider_id: z.string(), provider_model_id: z.string().min(1).max(160), tier: z.enum(['cheap', 'strong', 'any']), structured: z.enum(['json_schema_strict', 'json_mode', 'none']), reasoning_control: z.boolean().default(false), input_per_mtok: z.number().min(0), cached_input_per_mtok: z.number().min(0).nullable().optional(), output_per_mtok: z.number().min(0), token_factor: z.number().min(0.5).max(3).default(1), source_url: z.string().max(500), reason: z.string() }));
  const reason = reasonOf(b);
  const a = c.get('admin');
  const id = `${b.provider_id}:${b.provider_model_id}`;
  const res = await c.get('deps').sql.begin(async (tx) => {
    await tx`INSERT INTO ai_models (id, provider_id, provider_model_id, tier, capabilities, status, approved_tasks, input_per_mtok, cached_input_per_mtok, output_per_mtok, token_factor, effective_from, source_url, checked_on)
             VALUES (${id}, ${b.provider_id}, ${b.provider_model_id}, ${b.tier}, ${tx.json({ structured: b.structured, reasoning_control: b.reasoning_control })}, 'candidate', '{}', ${b.input_per_mtok}, ${b.cached_input_per_mtok ?? null}, ${b.output_per_mtok}, ${b.token_factor}, current_date, ${b.source_url}, current_date)`;
    return { id, audit_id: await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'model.create', target_type: 'model', target_id: id, after: b, reason, request_id: c.get('requestId') }) };
  });
  return c.json(res, 201);
});

ai.patch('/ai/models/:id', need('models.edit'), async (c) => {
  const b = await parse(c, z.object({ status: z.enum(['candidate', 'eval_only', 'approved', 'retired']).optional(), approved_tasks: z.array(z.enum(['jd_extract', 'resume_extract', 'match_map', 'optimize', 'validate_entail', 'repair'])).optional(), eval_run_id: z.string().uuid().optional(), input_per_mtok: z.number().min(0).optional(), output_per_mtok: z.number().min(0).optional(), reason: z.string() }));
  const reason = reasonOf(b);
  const a = c.get('admin');
  const { sql } = c.get('deps');
  const id = decodeURIComponent(c.req.param('id'));
  if ((b.status === 'approved' || b.approved_tasks?.length) && b.status !== 'retired') {
    const [er] = b.eval_run_id ? await sql`SELECT passed, models FROM eval_runs WHERE id = ${b.eval_run_id}` : [];
    if (!er?.passed || !(er.models as string[]).includes(id)) throw new ApiError('precondition_failed', 'Approving a model for a step needs a passing eval run that used this model.');
  }
  const res = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT status, approved_tasks, input_per_mtok, output_per_mtok FROM ai_models WHERE id = ${id} FOR UPDATE`;
    if (!before) throw new ApiError('not_found', 'Model not found.');
    await tx`UPDATE ai_models SET status = COALESCE(${b.status ?? null}, status), approved_tasks = COALESCE(${b.approved_tasks ?? null}, approved_tasks),
             input_per_mtok = COALESCE(${b.input_per_mtok ?? null}, input_per_mtok), output_per_mtok = COALESCE(${b.output_per_mtok ?? null}, output_per_mtok), checked_on = current_date WHERE id = ${id}`;
    return { audit_id: await audit(tx, { actor_type: 'admin', actor_id: a.id, actor_role: a.role, action: 'model.update', target_type: 'model', target_id: id, before, after: b, reason, request_id: c.get('requestId') }) };
  });
  await c.get('deps').internal('/internal/config/invalidate').catch(() => undefined);
  return c.json(res);
});
