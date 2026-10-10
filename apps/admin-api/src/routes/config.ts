import { NAMESPACES, type Namespace } from '@jmo/config';
import { activateVersion, createDraft, getActive, listVersions, rollback, validateVersion } from '@jmo/server';
import { ApiError } from '@jmo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminEnv } from '../context';
import { can, NAMESPACE_PERM, need, reasonOf, stepUp } from '../guard';
import { parse } from '../util';

// Runtime config lifecycle (admin-panel.md §6.2) + eval runs (§6.3).

export const config = new Hono<AdminEnv>();

const NS = z.enum(NAMESPACES);
const ENV = z.enum(['production', 'eval']);
const DANGEROUS = new Set<Namespace>(['ai_routing', 'budgets', 'plans', 'retention', 'kill_switches']);

function checkNs(role: Parameters<typeof can>[0], ns: Namespace) {
  if (!can(role, NAMESPACE_PERM[ns])) throw new ApiError('forbidden', `Your role cannot change ${ns}.`);
}

config.get('/config', need('dashboards.view'), async (c) => {
  const { sql } = c.get('deps');
  const env = ENV.parse(c.req.query('env') ?? 'production');
  const rows = await sql`SELECT namespace, version, activated_at FROM config_versions WHERE env = ${env} AND status = 'active' ORDER BY namespace`;
  const drafts = await sql`SELECT namespace, count(*)::int AS n FROM config_versions WHERE env = ${env} AND status = 'draft' GROUP BY namespace`;
  return c.json({ data: NAMESPACES.map((ns) => ({ namespace: ns, active: rows.find((r) => r.namespace === ns) ?? null, drafts: drafts.find((d) => d.namespace === ns)?.n ?? 0, editable: can(c.get('admin').role, NAMESPACE_PERM[ns]) })) });
});

config.get('/config/:ns', need('dashboards.view'), async (c) => {
  const ns = NS.parse(c.req.param('ns'));
  const env = ENV.parse(c.req.query('env') ?? 'production');
  const { sql } = c.get('deps');
  return c.json({ namespace: ns, env, active: await getActive(sql, ns, env), versions: await listVersions(sql, ns, env) });
});

config.get('/config/versions/:id', need('dashboards.view'), async (c) => {
  const [row] = await c.get('deps').sql`SELECT id, namespace, env, version, data, status, change_note, created_at, activated_at, eval_run_id FROM config_versions WHERE id = ${c.req.param('id')}`;
  if (!row) throw new ApiError('not_found', 'Not found.');
  return c.json(row);
});

config.post('/config/:ns/versions', async (c) => {
  const ns = NS.parse(c.req.param('ns'));
  checkNs(c.get('admin').role, ns);
  const b = await parse(c, z.object({ env: ENV.default('production'), data: z.unknown(), change_note: z.string() }));
  const a = c.get('admin');
  // Support may only turn kill switches ON (switch features OFF) — never re-enable (admin-panel.md §4.2).
  if (ns === 'kill_switches' && a.role === 'support') {
    const active = await getActive(c.get('deps').sql, ns, b.env);
    const cur = (active?.data ?? {}) as Record<string, unknown>;
    const next = b.data as Record<string, unknown>;
    for (const k of Object.keys(cur)) if (typeof cur[k] === 'boolean' && cur[k] === true && next[k] === false) throw new ApiError('forbidden', 'Support can only switch features off.');
  }
  return c.json(await createDraft(c.get('deps').sql, ns, b.env, b.data, b.change_note, { id: a.id, role: a.role, requestId: c.get('requestId') }), 201);
});

config.post('/config/versions/:id/validate', need('dashboards.view'), async (c) => c.json(await validateVersion(c.get('deps').sql, c.req.param('id'))));

config.post('/config/versions/:id/activate', async (c) => {
  const { sql, internal } = c.get('deps');
  const [row] = await sql<Array<{ namespace: Namespace }>>`SELECT namespace FROM config_versions WHERE id = ${c.req.param('id')}`;
  if (!row) throw new ApiError('not_found', 'Not found.');
  checkNs(c.get('admin').role, row.namespace);
  if (DANGEROUS.has(row.namespace)) await stepUp(c, async () => undefined);
  const b = await parse(c, z.object({ reason: z.string(), eval_run_id: z.string().uuid().nullable().optional() }));
  const a = c.get('admin');
  const res = await activateVersion(sql, c.req.param('id'), { id: a.id, role: a.role, requestId: c.get('requestId') }, { reason: reasonOf(b), evalRunId: b.eval_run_id ?? null });
  c.get('deps').config.invalidate();
  await internal('/internal/config/invalidate').catch(() => undefined);
  return c.json(res);
});

config.post('/config/:ns/rollback', async (c) => {
  const ns = NS.parse(c.req.param('ns'));
  checkNs(c.get('admin').role, ns);
  const b = await parse(c, z.object({ env: ENV.default('production'), reason: z.string() }));
  const a = c.get('admin');
  const res = await rollback(c.get('deps').sql, ns, b.env, { id: a.id, role: a.role, requestId: c.get('requestId') }, reasonOf(b));
  c.get('deps').config.invalidate();
  await c.get('deps').internal('/internal/config/invalidate').catch(() => undefined);
  return c.json(res);
});

// ── Evals (smoke suite runs inside the API, which holds the keys) ──
config.get('/evals', need('dashboards.view'), async (c) => c.json({ data: await c.get('deps').sql`SELECT id, suite, git_sha, models, prompt_versions, metrics, passed, created_at FROM eval_runs ORDER BY created_at DESC LIMIT 100` }));

config.post('/evals/run', need('config.ai'), async (c) => {
  const b = await parse(c, z.object({ version_id: z.string().uuid().optional(), routing: z.unknown().optional(), label: z.string().max(80).optional() }));
  let routing = b.routing;
  if (b.version_id) {
    const [row] = await c.get('deps').sql`SELECT data, namespace FROM config_versions WHERE id = ${b.version_id}`;
    if (!row || row.namespace !== 'ai_routing') throw new ApiError('invalid_request', 'Eval runs take an ai_routing version.');
    routing = row.data;
  }
  if (!routing) routing = (await c.get('deps').config.get()).config.ai_routing;
  const res = (await c.get('deps').internal('/internal/evals/run', { routing, label: b.label ?? `admin:${c.get('admin').email}` })) as { eval_run_id: string };
  if (b.version_id) await c.get('deps').sql`UPDATE config_versions SET eval_run_id = ${res.eval_run_id} WHERE id = ${b.version_id} AND status = 'draft'`;
  return c.json(res);
});
