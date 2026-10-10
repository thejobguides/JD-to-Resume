import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractJobFromText } from '@jmo/job-extraction';
import { expect, test } from '@playwright/test';
import { ADMIN_API, api, db, health, login } from './live';

// The AI pipeline on real models (eval routing: AI_ROUTING=eval after `pnpm openrouter:setup` or `pnpm nvidia:setup`)
// and the opt-in saved content around it: job analysis with verbatim quotes, tailoring with SSE and verification,
// the three saved items, an admin opening one behind step-up (audited), and opting out deleting them.
// Synthetic data only: the repo's fixture job page and sample resume.

const ROOT = resolve(import.meta.dirname, '../../..');

test.describe.serial('live: AI on the eval routing + saved content', () => {
  const sql = db();
  test.afterAll(async () => {
    await sql.end({ timeout: 2 });
  });

  test('analyze → tailor on real models; inputs and result saved encrypted; admin view audited; opt-out deletes', async () => {
    test.skip(!(await health()), 'needs the dev API (pnpm dev:api)');
    const cfg = (await (await fetch(`${process.env.LIVE_API_URL ?? 'http://localhost:8787'}/v1/config`)).json()) as { config: { announcements?: Array<{ id: string }> } };
    test.skip(!cfg.config.announcements?.some((a) => a.id === 'eval-routing'), 'needs AI_ROUTING=eval and a configured eval routing (pnpm openrouter:setup)');

    const u = await login('ai-content');
    expect((await api('PATCH', '/v1/account/settings', u.token, { content_opt_in: true })).status).toBe(204);

    const html = readFileSync(resolve(ROOT, 'tests/fixtures/jd/lever-jsonld.html'), 'utf8').replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ');
    const job = await extractJobFromText(html.slice(html.indexOf('Acme Analytics is hiring'), html.indexOf('© Acme')).replace(/\n{2,}/g, '\n').trim());
    const a = await api<{ job_analysis_id: string; analysis: { requirements: Array<{ req_id: string; quote: string }> } }>('POST', '/v1/jobs/analyze', u.token, { jd_text: job.description_text, jd_hash: job.jd_hash, structured_hint: { title: 'Senior Data Engineer', company: 'Acme Analytics' } });
    expect(a.status).toBe(200);
    expect(a.json.analysis.requirements.length).toBeGreaterThan(3);
    for (const r of a.json.analysis.requirements) expect(job.description_text).toContain(r.quote);

    // Same request the extension builds: score against the hosted analysis, target its gaps.
    const { extractClaims, toClaimLite } = await import('@jmo/evidence');
    const { toOptResume } = await import('@jmo/resume');
    const { sampleResume } = await import('@jmo/resume/fixtures');
    const { scoreResume, selectTargets } = await import('@jmo/scoring');
    const { resume, claims } = extractClaims(sampleResume());
    const targets = selectTargets(scoreResume({ analysis: a.json.analysis as never, resume, claims }));
    const o = await api<{ optimization_id: string }>('POST', '/v1/optimizations', u.token, { job_analysis_id: a.json.job_analysis_id, resume: toOptResume(resume), claims: toClaimLite(claims), targets: { req_ids: targets, edit_budget: { bullets: 8, summary: true, skills_order: true } } }, { 'idempotency-key': `live-ai-${u.userId.slice(-12)}` });
    expect(o.status).toBe(202);
    const sse = await (await fetch(`${process.env.LIVE_API_URL ?? 'http://localhost:8787'}/v1/optimizations/${o.json.optimization_id}/events`, { headers: { authorization: `Bearer ${u.token}` } })).text();
    expect(sse).toMatch(/"step":"entailment"|"step":"gates"/);
    const result = await api<{ status: string; result: { bullets: Array<{ validation: string }>; summary: unknown } }>('GET', `/v1/optimizations/${o.json.optimization_id}`, u.token);
    expect(['succeeded', 'partial']).toContain(result.json.status);
    expect(result.json.result.bullets.every((b) => b.validation === 'entailed')).toBe(true);
    const models = await sql`SELECT DISTINCT model_id FROM ai_requests WHERE user_id = ${u.userId}`;
    expect(models.map((m) => String(m.model_id)).every((m) => !m.startsWith('mock:'))).toBe(true);
    await api('POST', `/v1/optimizations/${o.json.optimization_id}/scores`, u.token, { before_score: 55, after_score: 72, ceiling_score: 80 });

    const saved = await sql<Array<{ id: string; kind: string; meta: Record<string, unknown> }>>`SELECT id, kind, meta FROM stored_content WHERE user_id = ${u.userId} ORDER BY kind`;
    expect(saved.map((r) => r.kind)).toEqual(['job_post', 'result', 'resume']);
    expect(saved.find((r) => r.kind === 'result')!.meta).toMatchObject({ after_score: 72, before_score: 55 });

    // An admin opens the saved resume: step-up first, and the view is audited.
    const admin = async (method: string, path: string, token: string, body?: unknown) => {
      const r = await fetch(`${ADMIN_API}/admin/v1${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
    };
    await sql`DELETE FROM auth_verifications WHERE identifier = 'owner@example.com'`;
    const c1 = await (await fetch(`${ADMIN_API}/admin/v1/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com' }) })).json();
    const s = await (await fetch(`${ADMIN_API}/admin/v1/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', code: c1.dev_code }) })).json();
    const resumeRow = saved.find((r) => r.kind === 'resume')!;
    const opened = await admin('GET', `/content/${resumeRow.id}`, s.access_token);
    expect(opened.status).toBe(200); // the sign-in counts as a fresh step-up
    expect(opened.json.payload.resume.roles.length).toBeGreaterThan(0);
    expect((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'content.view' AND target_id = ${resumeRow.id}`)[0]!.n).toBe(1);

    expect((await api('PATCH', '/v1/account/settings', u.token, { content_opt_in: false })).status).toBe(204);
    expect((await sql`SELECT count(*)::int AS n FROM stored_content WHERE user_id = ${u.userId}`)[0]!.n).toBe(0);
  });
});
