import type { Sql } from '@jmo/db';
import { ApiError, type JobAnalysis, JobAnalysis as JobAnalysisSchema, type OptimizationEvent, type OptimizationResponse, type OptimizationResult, type OptimizeRequest, sha256Hex, uuidv7 } from '@jmo/shared';
import type { AiRuntime } from './ai-runtime';
import { saveContent } from './content-store';
import { openJson, sealJson } from './crypto';
import { release, reserve, settle } from './quota';

// Async optimization jobs (api-design.md §6.7–6.10). The Node runner executes in-process; the Workers
// deployment runs the same `execute()` inside a Cloudflare Workflow. Results sit in an encrypted mailbox ≤ 24 h.

type Listener = (e: OptimizationEvent) => void;

export class OptimizationRunner {
  private listeners = new Map<string, Set<Listener>>();
  private running = new Map<string, AbortController>();

  constructor(
    private sql: Sql,
    private ai: AiRuntime,
    private mailboxKey: string,
    /** Opt-in content store key: inputs and results are saved only for users who agreed (content-store.ts). */
    private contentKey: string | null = null,
  ) {}

  /** Saving for analysis must never break or slow down an optimization; failures are logged and dropped. */
  private async keep(item: Parameters<typeof saveContent>[2]) {
    if (!this.contentKey) return;
    try {
      await saveContent(this.sql, this.contentKey, item);
    } catch (e) {
      console.warn(`[content] not saved (${item.kind}): ${(e as Error).message}`);
    }
  }

  subscribe(id: string, fn: Listener): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(fn);
    this.listeners.set(id, set);
    return () => set.delete(fn);
  }

  private emit(id: string, e: OptimizationEvent) {
    for (const fn of this.listeners.get(id) ?? []) fn(e);
  }

  async create(user: { id: string; plan: string }, req: OptimizeRequest, idempotencyKey: string, meta: { requestId?: string; dailySpendUsd?: number }): Promise<{ optimization_id: string; status: string; replay: boolean }> {
    const [existing] = await this.sql<Array<{ id: string; status: string }>>`SELECT id, status FROM optimizations WHERE user_id = ${user.id} AND idempotency_key = ${idempotencyKey}`;
    if (existing) return { optimization_id: existing.id, status: existing.status, replay: true };

    let analysis: JobAnalysis | null = null;
    if (req.job_analysis_id) {
      const [row] = await this.sql<Array<{ analysis: unknown }>>`SELECT analysis FROM job_analyses WHERE id = ${req.job_analysis_id}`;
      if (row) analysis = JobAnalysisSchema.parse(row.analysis);
    }
    if (!analysis && req.job_analysis) analysis = req.job_analysis;
    if (!analysis) throw new ApiError('invalid_request', 'job_analysis_id is unknown and no job_analysis was provided.');

    const { config, snapshot } = await this.ai.ready();
    const reservation = await reserve(this.sql, config, user.id, 'optimization', { dailySpendUsd: meta.dailySpendUsd ?? 0 });
    const id = uuidv7();
    try {
      await this.sql`INSERT INTO optimizations (id, user_id, job_analysis_id, idempotency_key, status, step, reservation_id, config_snapshot_id)
                     VALUES (${id}, ${user.id}, ${req.job_analysis_id ?? null}, ${idempotencyKey}, 'queued', 'queued', ${reservation.reservation_id}, ${snapshot})`;
    } catch (e) {
      await release(this.sql, reservation.reservation_id);
      throw e;
    }
    await this.keep({
      userId: user.id,
      kind: 'resume',
      optimizationId: id,
      jobAnalysisId: req.job_analysis_id ?? null,
      payload: { resume: req.resume, claims: req.claims, targets: req.targets, options: req.options },
      meta: { roles: req.resume.roles.length, bullets: req.resume.roles.reduce((n, r) => n + r.bullets.length, 0), claims: req.claims.length, targets: req.targets.req_ids.length, job_title: analysis.title || null, company: analysis.company || null },
    });
    void this.execute(id, user, req, analysis, reservation.reservation_id, snapshot, meta.requestId);
    return { optimization_id: id, status: 'queued', replay: false };
  }

  async execute(id: string, user: { id: string; plan: string }, req: OptimizeRequest, analysis: JobAnalysis, reservationId: string, snapshot: string, requestId?: string) {
    const ctrl = new AbortController();
    this.running.set(id, ctrl);
    const update = async (status: OptimizationEvent['status'], step: string, progress: number) => {
      await this.sql`UPDATE optimizations SET status = ${status}, step = ${step}, progress = ${progress}, started_at = COALESCE(started_at, now()) WHERE id = ${id}`;
      this.emit(id, { status, step, progress });
    };
    let cost = 0;
    try {
      await update('running', 'rewrite', 0.05);
      const { service } = await this.ai.ready();
      const out = await service.optimize(req, analysis, { userId: user.id, optimizationId: id, plan: user.plan, configSnapshotId: snapshot, bucketKey: user.id, signal: ctrl.signal, ...(requestId ? { requestId } : {}) }, (e) => update(e.status, e.step, e.progress));
      cost = out.meta.cost_usd;
      if (ctrl.signal.aborted) throw new ApiError('conflict', 'canceled');
      const sealed = await sealJson(out.result, this.mailboxKey, id);
      const status = out.result.bullets.length || out.result.summary || out.result.skills_order.length ? 'succeeded' : 'partial';
      await this.sql.begin(async (tx) => {
        await tx`INSERT INTO optimization_mailbox (optimization_id, iv, ciphertext, expires_at) VALUES (${id}, ${sealed.iv}, ${sealed.ciphertext}, now() + interval '24 hours')
                 ON CONFLICT (optimization_id) DO UPDATE SET iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, expires_at = EXCLUDED.expires_at`;
        await tx`UPDATE optimizations SET status = ${status}, step = 'done', progress = 1, finished_at = now(), cost_usd = ${cost},
                 gates = ${tx.json(out.meta.gates)}, meta = ${tx.json(out.meta as never)},
                 change_summary = ${tx.json({ bullets_changed: out.result.bullets.length, summary: !!out.result.summary, skills_reordered: out.result.skills_order.length > 0, reverted: out.result.reverted.length, emphasized: [...new Set(out.result.bullets.flatMap((b) => b.emphasized_req_ids))], not_addressable: out.result.not_addressable.map((n) => n.req_id) })}
                 WHERE id = ${id}`;
      });
      await settle(this.sql, reservationId, cost, id);
      await this.keep({
        userId: user.id,
        kind: 'result',
        optimizationId: id,
        jobAnalysisId: req.job_analysis_id ?? null,
        payload: out.result,
        meta: { status, bullets_changed: out.result.bullets.length, summary_changed: !!out.result.summary, reverted: out.result.reverted.length, not_addressable: out.result.not_addressable.length, gates: out.meta.gates, models: out.meta.models, prompt_versions: out.meta.prompt_versions, cost_usd: cost, duration_ms: out.meta.duration_ms },
      });
      this.emit(id, { status, step: 'done', progress: 1 });
    } catch (e) {
      const canceled = ctrl.signal.aborted;
      const code = canceled ? 'canceled' : e instanceof ApiError ? e.code : (e as Error).name === 'AiUnavailableError' ? 'ai_unavailable' : 'processing_failed';
      await this.sql`UPDATE optimizations SET status = ${canceled ? 'canceled' : 'failed'}, error_code = ${code}, finished_at = now() WHERE id = ${id}`;
      await release(this.sql, reservationId, cost);
      await this.keep({ userId: user.id, kind: 'result', optimizationId: id, jobAnalysisId: req.job_analysis_id ?? null, payload: { error: code }, meta: { status: canceled ? 'canceled' : 'failed', error_code: code } });
      this.emit(id, { status: canceled ? 'canceled' : 'failed', step: code, progress: 1 });
    } finally {
      this.running.delete(id);
    }
  }

  async cancel(userId: string, id: string) {
    const [row] = await this.sql<Array<{ status: string }>>`SELECT status FROM optimizations WHERE id = ${id} AND user_id = ${userId}`;
    if (!row) throw new ApiError('not_found', 'Optimization not found.');
    this.running.get(id)?.abort();
    return { status: row.status };
  }

  async get(userId: string, id: string, opts: { ack?: boolean } = {}): Promise<OptimizationResponse> {
    const [row] = await this.sql<Array<{ status: OptimizationResponse['status']; meta: OptimizationResponse['meta']; error_code: string | null }>>`
      SELECT status, meta, error_code FROM optimizations WHERE id = ${id} AND user_id = ${userId}`;
    if (!row) throw new ApiError('not_found', 'Optimization not found.');
    let result: OptimizationResult | null = null;
    const [mb] = await this.sql<Array<{ iv: Uint8Array; ciphertext: Uint8Array; expires_at: Date }>>`SELECT iv, ciphertext, expires_at FROM optimization_mailbox WHERE optimization_id = ${id}`;
    if (mb && mb.expires_at > new Date()) result = await openJson<OptimizationResult>(mb.iv, mb.ciphertext, this.mailboxKey, id);
    if (mb && opts.ack) await this.sql`DELETE FROM optimization_mailbox WHERE optimization_id = ${id}`;
    return {
      optimization_id: id,
      status: row.status,
      result,
      meta: row.meta,
      error: row.error_code ? { code: row.error_code, message: row.error_code === 'ai_unavailable' ? 'Optimization is temporarily unavailable. Your quota was not used.' : 'Optimization failed. Your quota was not used.' } : null,
    };
  }

  async status(userId: string, id: string): Promise<OptimizationEvent | null> {
    const [row] = await this.sql<Array<{ status: OptimizationEvent['status']; step: string | null; progress: string }>>`SELECT status, step, progress FROM optimizations WHERE id = ${id} AND user_id = ${userId}`;
    return row ? { status: row.status, ...(row.step ? { step: row.step } : {}), progress: Number(row.progress) } : null;
  }

  async list(userId: string, limit = 20) {
    return this.sql`SELECT o.id, o.status, o.before_score, o.after_score, o.ceiling_score, o.created_at, j.title, j.company
                    FROM optimizations o LEFT JOIN jobs j ON j.id = o.job_id WHERE o.user_id = ${userId} ORDER BY o.created_at DESC LIMIT ${limit}`;
  }

  async recordScores(userId: string, id: string, s: { before_score: number; after_score: number; ceiling_score: number }) {
    await this.sql`UPDATE optimizations SET before_score = ${s.before_score}, after_score = ${Math.min(s.after_score, s.ceiling_score)}, ceiling_score = ${s.ceiling_score} WHERE id = ${id} AND user_id = ${userId}`;
  }

  async purgeExpiredMailboxes() {
    await this.sql`DELETE FROM optimization_mailbox WHERE expires_at < now()`;
  }
}

export async function requestHash(body: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(body));
}
