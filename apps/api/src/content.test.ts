import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultConfig, generateSigningKeys } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { extractClaims, toClaimLite } from '@jmo/evidence';
import { analyzeJobText, extractJobFromText } from '@jmo/job-extraction';
import { toOptResume } from '@jmo/resume';
import { sampleResume } from '@jmo/resume/fixtures';
import { scoreResume, selectTargets } from '@jmo/scoring';
import { applyRetention, consoleMailer, createServices, loadEnv, readContent, type Services } from '@jmo/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbAvailable, freshDatabase } from '../../../tests/setup/db';
import { createApp } from './app';
import { resetRateLimits } from './middleware';

// The opt-in content store end to end through the public API: nothing without consent; job post, minimized resume
// and result saved and linked when opted in; encrypted at rest and bound to the user; export, delete, opt-out, expiry.

const up = await dbAvailable();

describe.skipIf(!up)('Opt-in saved content (Postgres)', () => {
  let sql: Sql;
  let services: Services;
  let app: ReturnType<typeof createApp>;
  const jdHtml = readFileSync(resolve(__dirname, '../../../tests/fixtures/jd/lever-jsonld.html'), 'utf8');
  const jdText = (() => {
    const t = jdHtml.replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ');
    return t.slice(t.indexOf('Acme Analytics is hiring'), t.indexOf('© Acme')).replace(/\n{2,}/g, '\n').trim();
  })();

  beforeAll(async () => {
    ({ sql } = await freshDatabase('jmo_test_content'));
    const signing = await generateSigningKeys();
    services = createServices(loadEnv({ ENV: 'test', DATABASE_URL: 'unused', CONFIG_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(signing.privateJwk) }), { sql, mailer: consoleMailer(() => undefined) });
    app = createApp(services);
  });
  afterAll(async () => {
    await sql?.end({ timeout: 2 });
  });

  const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const auth = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });
  async function login(email: string) {
    resetRateLimits();
    const r1 = await json('POST', '/v1/auth/otp/request', { email });
    const r2 = await json('POST', '/v1/auth/otp/verify', { email, code: ((await r1.json()) as { dev_code: string }).dev_code });
    return (await r2.json()) as { access_token: string; user: { id: string } };
  }
  async function useTheProduct(t: string, key: string) {
    resetRateLimits();
    const job = await extractJobFromText(jdText);
    const a = (await (await json('POST', '/v1/jobs/analyze', { jd_text: job.description_text, jd_hash: job.jd_hash, source: { host: 'jobs.lever.co' }, structured_hint: { title: 'Senior Data Engineer', company: 'Acme Analytics' } }, auth(t))).json()) as { job_analysis_id: string; analysis: Parameters<typeof scoreResume>[0]['analysis'] };
    const { resume, claims } = extractClaims(sampleResume());
    const before = scoreResume({ analysis: a.analysis, resume, claims });
    const r = await json('POST', '/v1/optimizations', { job_analysis_id: a.job_analysis_id, resume: toOptResume(resume), claims: toClaimLite(claims), targets: { req_ids: selectTargets(before), edit_budget: { bullets: 8, summary: true, skills_order: true } } }, auth(t, { 'idempotency-key': key }));
    const { optimization_id } = (await r.json()) as { optimization_id: string };
    await (await app.request(`/v1/optimizations/${optimization_id}/events`, { headers: auth(t) })).text();
    return { job, jobAnalysisId: a.job_analysis_id, optimizationId: optimization_id };
  }
  const rows = (userId: string) => sql<Array<{ id: string; kind: string; optimization_id: string | null; job_analysis_id: string | null; meta: Record<string, unknown>; ciphertext: Uint8Array; expires_at: Date }>>`
    SELECT id, kind, optimization_id, job_analysis_id, meta, ciphertext, expires_at FROM stored_content WHERE user_id = ${userId} ORDER BY created_at`;
  const optIn = async (t: string, on: boolean) => expect((await json('PATCH', '/v1/account/settings', { content_opt_in: on }, auth(t))).status).toBe(204);

  it('saves nothing for users who have not opted in', async () => {
    const u = await login('private@example.org');
    await useTheProduct(u.access_token, 'content-private-01');
    expect(await rows(u.user.id)).toHaveLength(0);
    expect(((await (await app.request('/v1/me', { headers: auth(u.access_token) })).json()) as { settings: { content_opt_in: boolean } }).settings.content_opt_in).toBe(false);
  });

  it('after opting in: the job post (once per job), the minimized resume and the result are saved and linked', async () => {
    const u = await login('helper@example.org');
    await optIn(u.access_token, true);
    expect((await sql`SELECT content_opt_in_at FROM users WHERE id = ${u.user.id}`)[0]!.content_opt_in_at).not.toBeNull();
    const run = await useTheProduct(u.access_token, 'content-helper-01');
    await useTheProduct(u.access_token, 'content-helper-02'); // same job again, second optimization
    const saved = await rows(u.user.id);
    expect(saved.map((r) => r.kind).sort()).toEqual(['job_post', 'result', 'result', 'resume', 'resume']);
    const jobPost = saved.find((r) => r.kind === 'job_post')!;
    expect(jobPost.job_analysis_id).toBe(run.jobAnalysisId);
    expect(jobPost.meta).toMatchObject({ title: expect.stringContaining('Senior Data Engineer'), host: 'jobs.lever.co', jd_hash: run.job.jd_hash, cache: 'hit' }); // the first test analyzed this job (shared cache)
    const linked = saved.filter((r) => r.optimization_id === run.optimizationId).map((r) => r.kind).sort();
    expect(linked).toEqual(['result', 'resume']);
    const result = saved.find((r) => r.kind === 'result' && r.optimization_id === run.optimizationId)!;
    expect(result.meta).toMatchObject({ status: expect.stringMatching(/succeeded|partial/), models: expect.any(Array) });
    const days = (result.expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);

    // Client scores are added to the stored result.
    await json('POST', `/v1/optimizations/${run.optimizationId}/scores`, { before_score: 52, after_score: 81, ceiling_score: 78 }, auth(u.access_token));
    expect((await rows(u.user.id)).find((r) => r.id === result.id)!.meta).toMatchObject({ before_score: 52, after_score: 78, ceiling_score: 78 });
  });

  it('content is encrypted at rest, minimized, and bound to its user', async () => {
    const u = await login('crypto@example.org');
    await optIn(u.access_token, true);
    await useTheProduct(u.access_token, 'content-crypto-01');
    const saved = await rows(u.user.id);
    for (const r of saved) expect(Buffer.from(r.ciphertext).toString('utf8')).not.toMatch(/Kafka|Globex|Senior Data Engineer/);
    const resumeRow = saved.find((r) => r.kind === 'resume')!;
    const opened = (await readContent(sql, services.env.CONTENT_ENCRYPTION_KEY, resumeRow.id))!;
    const payload = opened.payload as { resume: { roles: Array<{ employer: string }> }; claims: unknown[] };
    expect(payload.resume.roles.map((r) => r.employer)).toEqual(expect.arrayContaining(['Globex', 'Initech']));
    // What the extension sends is already minimized: no email or phone number in the stored resume.
    expect(JSON.stringify(payload)).not.toMatch(/@[a-z]+\.[a-z]+|\+?\d[\d\s().-]{8,}\d/i);
    // Moving a row to another user breaks decryption (the AAD binds it to its owner).
    const other = await login('thief@example.org');
    await sql`UPDATE stored_content SET user_id = ${other.user.id} WHERE id = ${resumeRow.id}`;
    await expect(readContent(sql, services.env.CONTENT_ENCRYPTION_KEY, resumeRow.id)).rejects.toThrow();
    await expect(readContent(sql, 'a-different-key-0123456789abcdef0123456789', saved[0]!.id)).rejects.toThrow();
  });

  it('the account export includes saved content, decrypted; "delete saved data" keeps the opt-in', async () => {
    const u = await login('exporter@example.org');
    await optIn(u.access_token, true);
    await useTheProduct(u.access_token, 'content-export-01');
    const exp = (await (await app.request('/v1/account/export', { headers: auth(u.access_token) })).json()) as { user: { content_opt_in: boolean }; saved_content: Array<{ kind: string; payload: Record<string, unknown>; user_id?: string }> };
    expect(exp.user.content_opt_in).toBe(true);
    expect(exp.saved_content.map((x) => x.kind).sort()).toEqual(['job_post', 'result', 'resume']);
    expect(exp.saved_content.find((x) => x.kind === 'job_post')!.payload.jd_text).toContain('Acme Analytics is hiring');
    expect(exp.saved_content[0]).not.toHaveProperty('user_id');

    const del = (await (await app.request('/v1/account/content', { method: 'DELETE', headers: auth(u.access_token) })).json()) as { deleted: number };
    expect(del.deleted).toBe(3);
    expect(await rows(u.user.id)).toHaveLength(0);
    expect((await sql`SELECT content_opt_in FROM users WHERE id = ${u.user.id}`)[0]!.content_opt_in).toBe(true);
  });

  it('opting out deletes everything saved and stops saving', async () => {
    const u = await login('quitter@example.org');
    await optIn(u.access_token, true);
    await useTheProduct(u.access_token, 'content-quit-0001');
    expect((await rows(u.user.id)).length).toBe(3);
    await optIn(u.access_token, false);
    expect(await rows(u.user.id)).toHaveLength(0);
    expect((await sql`SELECT content_opt_in, content_opt_in_at FROM users WHERE id = ${u.user.id}`)[0]).toMatchObject({ content_opt_in: false, content_opt_in_at: null });
    await useTheProduct(u.access_token, 'content-quit-0002');
    expect(await rows(u.user.id)).toHaveLength(0);
  });

  it('items expire after 12 months (retention job); account deletion removes them', async () => {
    const u = await login('expiry@example.org');
    await optIn(u.access_token, true);
    await useTheProduct(u.access_token, 'content-expiry-01');
    const [first] = await rows(u.user.id);
    await sql`UPDATE stored_content SET expires_at = now() - interval '1 minute' WHERE id = ${first!.id}`;
    expect(await readContent(sql, services.env.CONTENT_ENCRYPTION_KEY, first!.id)).toBeNull();
    const r = await applyRetention(sql, defaultConfig({ useMockAi: true }).retention);
    expect(r.stored_content).toBeGreaterThanOrEqual(1);
    expect((await rows(u.user.id)).length).toBe(2);
    expect((await app.request('/v1/account', { method: 'DELETE', headers: auth(u.access_token) })).status).toBe(202);
    expect((await sql`SELECT count(*)::int AS n FROM stored_content WHERE user_id = ${u.user.id}`)[0]!.n).toBe(0);
  });
});
