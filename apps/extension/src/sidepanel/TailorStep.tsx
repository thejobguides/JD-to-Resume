import type { Violation } from '@jmo/evidence';
import type { ScoreResult } from '@jmo/scoring';
import type { ChangedBullet, OptimizationResult } from '@jmo/shared';
import { uuidv7 } from '@jmo/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api';
import { type Applied, buildOptimizeRequest, byokService, checkUserEdit, score, type Scored } from '../lib/engine';
import type { LoadedResume } from '../lib/files';
import type { Account } from '../ui/useAccount';
import { Badge, Bar, Button, Card, ErrorText, inputCls, Note } from '../ui/ui';
import type { JobState, TailorState } from './state';

const STEP_LABEL: Record<string, string> = {
  queued: 'Waiting to start',
  running: 'Rewriting with your evidence',
  optimize: 'Rewriting with your evidence',
  validating: 'Checking every change against your resume',
  validate_entail: 'Checking every change against your resume',
  gates: 'Checking numbers, names and dates',
  repairing: 'Fixing changes that didn’t pass',
  repair: 'Fixing changes that didn’t pass',
};

const REVERT_REASON: Record<string, string> = {
  new_number: 'added a number that isn’t in your resume',
  new_entity: 'mentioned a company, product or certification you don’t list',
  new_skill_or_tool: 'mentioned a skill or tool you don’t list',
  unknown_skill: 'mentioned a skill you don’t list',
  cross_role_transplant: 'moved facts from one role into another',
  ownership_upgrade: 'overstated your role (e.g. “led” instead of “contributed”)',
  proficiency_upgrade: 'overstated your proficiency',
  years_inflation: 'claimed more years of experience than your dates show',
  anachronism: 'mentioned a technology that didn’t exist at the time',
  listed_only_promoted: 'claimed hands-on use of a skill you only list',
  entailment_embellished: 'said more than your resume supports',
  entailment_unsupported: 'wasn’t supported by your resume',
  entailment_contradicted: 'contradicted your resume',
  validation_failed: 'couldn’t be verified',
};

export function TailorStep({
  account,
  base,
  job,
  scored,
  tailor,
  setTailor,
  setJob,
  applied,
  onExport,
}: {
  account: Account;
  base: LoadedResume;
  job: JobState;
  scored: Scored;
  tailor: TailorState | null;
  setTailor: (t: TailorState | null) => Promise<void>;
  setJob: (j: JobState) => Promise<void>;
  applied: Applied | null;
  onExport: () => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [live, setLive] = useState<{ step?: string; progress: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const current = tailor && tailor.job_hash === job.job.jd_hash && tailor.resume_version === base.resume.version_id ? tailor : null;

  const finish = async (t: TailorState, result: OptimizationResult, models: string[]) => {
    await setTailor({
      ...t,
      status: 'done',
      result,
      models,
      accepted: result.bullets.filter((b) => b.validation === 'entailed').map((b) => b.bullet_id),
      summary: result.summary?.validation === 'entailed',
      skills: result.skills_order.length > 0,
    });
  };

  const followHosted = async (t: TailorState) => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    await api.followOptimization(t.optimization_id!, (e) => setLive({ ...(e.step ? { step: e.step } : { step: e.status }), progress: e.progress }), ctrl.signal);
    const o = await api.getOptimization(t.optimization_id!);
    if ((o.status === 'succeeded' || o.status === 'partial') && o.result) {
      await finish(t, o.result, o.meta?.models ?? []);
      void api.getOptimization(t.optimization_id!, true).catch(() => undefined); // ack: the server deletes its encrypted copy
    } else {
      await setTailor({ ...t, status: o.status === 'canceled' ? 'canceled' : 'failed', error: o.error?.message ?? 'Tailoring didn’t finish. Your quota was not used.' });
    }
  };

  const run = async (t: TailorState) => {
    setError(null);
    try {
      if (t.mode === 'hosted') {
        if (!t.optimization_id) {
          const r = await api.createOptimization(t.request, t.idempotency_key);
          t = { ...t, optimization_id: r.optimization_id };
          await setTailor(t);
        }
        await followHosted(t);
      } else {
        if (account.mode.kind !== 'byok') throw new Error('Add your API key in Settings first.');
        const ctrl = new AbortController();
        abort.current = ctrl;
        const out = await byokService(account.mode.settings).optimize(t.request, job.analysis, { signal: ctrl.signal }, (e) => setLive({ step: e.step, progress: e.progress }));
        await finish(t, out.result, out.meta.models);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      await setTailor({ ...t, status: 'failed', error: (e as Error).message });
      setError(e);
    } finally {
      setLive(null);
    }
  };

  // Resume a run after the panel was closed (hosted runs keep going on the server).
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !current || current.status !== 'running') return;
    resumed.current = true;
    if (current.mode === 'hosted') void run(current);
    else void setTailor({ ...current, status: 'failed', error: 'Interrupted when the panel closed. Run it again.' });
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const start = async () => {
    setError(null);
    try {
      const mode = account.mode;
      if (mode.kind === 'local') throw new Error('Sign in (or add your key) to tailor.');
      let j = job;
      let s = scored;
      // Hosted runs use the server's analysis (by id) so the server checks the same requirements we score.
      if (mode.kind === 'hosted' && (j.analyzed_by !== 'hosted' || !j.job_analysis_id)) {
        const r = await api.analyzeJob(j.job);
        j = { ...j, analysis: r.analysis, job_analysis_id: r.job_analysis_id, analyzed_by: 'hosted' };
        delete j.mappings;
        await setJob(j);
        s = score(j.analysis, base.resume);
      }
      const request = buildOptimizeRequest(s, j.analysis, mode.kind === 'hosted' ? j.job_analysis_id : undefined);
      if (!request.targets.req_ids.length) throw new Error('Nothing to tailor for this job.');
      const t: TailorState = {
        id: uuidv7(),
        mode: mode.kind,
        idempotency_key: uuidv7(),
        request,
        job_hash: j.job.jd_hash,
        resume_version: base.resume.version_id,
        status: 'running',
        accepted: [],
        summary: false,
        skills: false,
        edits: {},
        attested: [],
      };
      await setTailor(t);
      setLive({ progress: 0.02, step: 'queued' });
      resumed.current = true;
      await run(t);
    } catch (e) {
      setError(e);
    }
  };

  if (!current || current.status === 'failed' || current.status === 'canceled') {
    const quota = error instanceof api.ApiFailure && ['quota_exceeded', 'concurrency_limit'].includes(error.code);
    return (
      <div className="space-y-3">
        <Card title="Tailor your resume">
          <ul className="mb-3 list-disc space-y-1 pl-4 text-xs text-slate-600">
            <li>Rewrites up to 8 bullets, your summary and the order of your skills to surface what this job asks for.</li>
            <li>Only uses facts already in your resume. Every change is checked; anything unsupported is dropped.</li>
            <li>You review each change before anything is used.</li>
          </ul>
          {current?.error && <Note tone="amber">{current.error}</Note>}
          <Button full onClick={() => void start()}>{current ? 'Try again' : 'Start tailoring'}</Button>
          <div className="mt-2"><ErrorText error={error} /></div>
          {quota && <Button kind="ghost" small onClick={() => void chrome.runtime.openOptionsPage()}>See plans</Button>}
        </Card>
      </div>
    );
  }

  if (current.status === 'running') {
    const p = live?.progress ?? current.progress ?? 0.05;
    return (
      <Card title="Tailoring…">
        <p className="mb-2 text-xs text-slate-600">{STEP_LABEL[live?.step ?? ''] ?? 'Working'}</p>
        <Bar label="Tailoring progress" value={p * 100} />
        <p className="mt-2 text-[11px] text-slate-500">Usually 20–60 seconds. {current.mode === 'hosted' ? 'You can close this panel; it keeps running.' : 'Keep this panel open.'}</p>
        <div className="mt-3">
          <Button
            kind="secondary"
            small
            onClick={async () => {
              abort.current?.abort();
              if (current.optimization_id) await api.cancelOptimization(current.optimization_id).catch(() => undefined);
              await setTailor({ ...current, status: 'canceled', error: 'Canceled.' });
            }}
          >
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  return <Review tailor={current} job={job} before={scored.result} applied={applied} setTailor={setTailor} onExport={onExport} />;
}

function Review({ tailor, job, before, applied, setTailor, onExport }: { tailor: TailorState; job: JobState; before: ScoreResult; applied: Applied | null; setTailor: (t: TailorState) => Promise<void>; onExport: () => void }) {
  const result = tailor.result!;
  const claims = useMemo(() => new Map(tailor.request.claims.map((c) => [c.claim_id, c])), [tailor.request.claims]);
  const roles = useMemo(() => new Map(tailor.request.resume.roles.map((r) => [r.role_id, r])), [tailor.request.resume.roles]);
  const reqText = useMemo(() => new Map(job.analysis.requirements.map((r) => [r.req_id, r.text])), [job.analysis.requirements]);
  const bulletRole = useMemo(() => new Map(tailor.request.resume.roles.flatMap((r) => r.bullets.map((b) => [b.bullet_id, `${r.title}, ${r.employer}`] as const))), [tailor.request.resume.roles]);
  const set = (patch: Partial<TailorState>) => void setTailor({ ...tailor, ...patch });
  const toggle = (id: string, on: boolean) => set({ accepted: on ? [...new Set([...tailor.accepted, id])] : tailor.accepted.filter((x) => x !== id) });
  const after = applied?.after;

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex items-center justify-between">
          <div className="text-xs text-slate-600">Match estimate</div>
          <div className="text-sm">
            <span className="text-slate-600">{before.score}</span> → <b className="text-emerald-700">{after?.score ?? before.score}</b>
            <span className="ml-1 text-[11px] text-slate-600">(max {before.ceiling})</span>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">Same scoring as before, capped at what your experience supports. Updates as you accept or reject changes.</p>
        <div className="mt-2 flex gap-2">
          {/* "Verified" applies to the summary too: an unverified summary is never accepted in bulk. */}
          <Button small kind="secondary" onClick={() => set({ accepted: result.bullets.filter((b) => b.validation === 'entailed').map((b) => b.bullet_id), summary: result.summary?.validation === 'entailed', skills: result.skills_order.length > 0 })}>Accept all verified</Button>
          <Button small kind="ghost" onClick={() => set({ accepted: [], summary: false, skills: false })}>Reject all</Button>
        </div>
      </Card>

      {result.summary && (
        <ChangeCard
          title="Summary"
          before={result.summary.original_text ?? '(none)'}
          after={result.summary.text}
          why={result.summary.why}
          verified={result.summary.validation === 'entailed'}
          accepted={tailor.summary}
          onToggle={(on) => set({ summary: on })}
          evidence={result.summary.claim_ids.map((id) => claims.get(id)?.text).filter((t): t is string => !!t)}
        />
      )}

      {result.bullets.map((b) => (
        <BulletChange
          key={b.bullet_id}
          change={b}
          roleLabel={`${roles.get(b.role_id)?.title ?? ''} · ${roles.get(b.role_id)?.employer ?? ''}`}
          tailor={tailor}
          evidence={b.claim_ids.map((id) => claims.get(id)?.text).filter((t): t is string => !!t)}
          emphasized={b.emphasized_req_ids.map((id) => reqText.get(id)).filter((t): t is string => !!t)}
          onToggle={(on) => toggle(b.bullet_id, on)}
          onEdit={(text, attested) =>
            set({
              edits: { ...tailor.edits, [b.bullet_id]: text },
              accepted: [...new Set([...tailor.accepted, b.bullet_id])],
              attested: attested ? [...new Set([...tailor.attested, b.bullet_id])] : tailor.attested.filter((x) => x !== b.bullet_id),
            })
          }
        />
      ))}

      {result.skills_order.length > 0 && (
        <Card title="Skills order" actions={<Toggle label="Use the new skills order" on={tailor.skills} onChange={(on) => set({ skills: on })} />}>
          <p className="text-xs text-slate-700">{result.skills_order.map((id) => tailor.request.resume.skills.find((s) => s.skill_id === id)?.name).filter(Boolean).join(', ')}</p>
          <p className="mt-1 text-[11px] text-slate-500">Moves the skills this job asks for to the front. No skills are added.</p>
        </Card>
      )}

      {result.reverted.length > 0 && (
        <Card title={`Dropped ${result.reverted.length} suggestion${result.reverted.length === 1 ? '' : 's'}`}>
          <p className="text-[11px] text-slate-500">These couldn’t be verified against your resume, so we kept your original wording.</p>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
            {result.reverted.map((r) => (
              <li key={r.bullet_id}>• {bulletRole.get(r.bullet_id) ?? 'Summary'}: {REVERT_REASON[r.reason] ?? r.reason.replace(/_/g, ' ')}</li>
            ))}
          </ul>
        </Card>
      )}

      {result.not_addressable.length > 0 && (
        <Card title="Couldn’t improve">
          <ul className="space-y-0.5 text-xs text-slate-600">
            {result.not_addressable.map((n) => <li key={n.req_id}>• {reqText.get(n.req_id) ?? n.req_id}</li>)}
          </ul>
          <p className="mt-1 text-[11px] text-slate-500">No evidence for these in your resume. If you have the experience, add it in the Resume step and run again.</p>
        </Card>
      )}

      <div className="sticky bottom-0 border-t border-slate-200 bg-white py-2">
        <Button full onClick={onExport} disabled={!tailor.accepted.length && !tailor.summary && !tailor.skills}>Continue to export</Button>
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1 text-xs">
      <input type="checkbox" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} /> Use
    </label>
  );
}

function ChangeCard({ title, before, after, why, verified, accepted, onToggle, evidence }: { title: string; before: string; after: string; why: string; verified: boolean; accepted: boolean; onToggle: (on: boolean) => void; evidence: string[] }) {
  const [showEv, setShowEv] = useState(false);
  return (
    <Card title={<span className="text-xs">{title}</span>} actions={<Toggle label={`Use the new ${title.toLowerCase()}`} on={accepted} onChange={onToggle} />}>
      <p className="text-xs text-slate-500 line-through decoration-slate-400"><span className="sr-only">Before: </span>{before}</p>
      <p className="mt-1 text-xs text-slate-900">{after}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {verified ? <Badge tone="green">Verified against your resume</Badge> : <Badge tone="amber">Not verified</Badge>}
        {evidence.length > 0 && <button className="text-[11px] text-indigo-700" onClick={() => setShowEv((s) => !s)}>{showEv ? 'Hide' : 'Show'} evidence</button>}
      </div>
      {why && <p className="mt-1 text-[11px] text-slate-500">{why}</p>}
      {showEv && <ul className="mt-1 space-y-0.5 rounded bg-slate-50 p-2 text-[11px] text-slate-600">{evidence.map((e) => <li key={e}>“{e}”</li>)}</ul>}
    </Card>
  );
}

function BulletChange({
  change,
  roleLabel,
  tailor,
  evidence,
  emphasized,
  onToggle,
  onEdit,
}: {
  change: ChangedBullet;
  roleLabel: string;
  tailor: TailorState;
  evidence: string[];
  emphasized: string[];
  onToggle: (on: boolean) => void;
  onEdit: (text: string, attested: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(tailor.edits[change.bullet_id] ?? change.text);
  const [problems, setProblems] = useState<Violation[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [showEv, setShowEv] = useState(false);
  const shown = tailor.edits[change.bullet_id] ?? change.text;
  const accepted = tailor.accepted.includes(change.bullet_id);

  const save = () => {
    const report = checkUserEdit(tailor.request, change, text);
    const hard = report.violations.filter((v) => !v.soft);
    if (hard.length && !confirm) {
      setProblems(hard);
      return;
    }
    onEdit(text, hard.length > 0);
    setProblems(null);
    setEditing(false);
  };

  return (
    <Card title={<span className="text-xs font-normal text-slate-600">{roleLabel}</span>} actions={<Toggle label={`Use the rewritten bullet: ${shown.slice(0, 60)}`} on={accepted} onChange={onToggle} />}>
      <p className="text-xs text-slate-500 line-through decoration-slate-400"><span className="sr-only">Before: </span>{change.original_text}</p>
      {!editing ? (
        <p className="mt-1 text-xs text-slate-900">{shown}</p>
      ) : (
        <div className="mt-1 space-y-1">
          <textarea className={`${inputCls} text-xs`} aria-label="Edit this bullet" rows={4} value={text} onChange={(e) => { setText(e.target.value); setProblems(null); setConfirm(false); }} />
          {problems && (
            <div className="rounded bg-amber-50 p-2 text-[11px] text-amber-900">
              <p className="font-medium">Your edit says something your resume doesn’t:</p>
              <ul className="list-disc pl-4">{problems.map((p) => <li key={p.code + p.detail}>{p.detail}</li>)}</ul>
              <label className="mt-1 flex items-start gap-1">
                <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" />
                <span>This is true. I’m adding it as my own statement.</span>
              </label>
            </div>
          )}
          <div className="flex gap-1">
            <Button small onClick={save} disabled={!!problems && !confirm}>Save</Button>
            <Button small kind="ghost" onClick={() => { setEditing(false); setText(shown); setProblems(null); }}>Cancel</Button>
          </div>
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {tailor.attested.includes(change.bullet_id) ? (
          <Badge tone="amber">Your statement</Badge>
        ) : tailor.edits[change.bullet_id] ? (
          <Badge tone="green">Your edit · checked</Badge>
        ) : change.validation === 'entailed' ? (
          <Badge tone="green">Verified against your resume</Badge>
        ) : (
          <Badge tone="amber">Not verified</Badge>
        )}
        {change.repaired && <Badge>fixed after checks</Badge>}
        {!editing && <button className="text-[11px] text-indigo-700" onClick={() => setEditing(true)}>Edit</button>}
        {evidence.length > 0 && <button className="text-[11px] text-indigo-700" onClick={() => setShowEv((s) => !s)}>{showEv ? 'Hide' : 'Show'} evidence</button>}
      </div>
      {change.why && <p className="mt-1 text-[11px] text-slate-500">{change.why}</p>}
      {emphasized.length > 0 && <p className="mt-1 text-[11px] text-slate-500">Addresses: {emphasized.join('; ')}</p>}
      {showEv && <ul className="mt-1 space-y-0.5 rounded bg-slate-50 p-2 text-[11px] text-slate-600">{evidence.map((e) => <li key={e}>“{e}”</li>)}</ul>}
    </Card>
  );
}
