import { toClaimLite } from '@jmo/evidence';
import { gaps, type RequirementResult, type ScoreResult } from '@jmo/scoring';
import { useState } from 'react';
import * as api from '../lib/api';
import { GOOGLE_ENABLED } from '../lib/api';
import { ambiguous, byokService, type Scored } from '../lib/engine';
import { GoogleButton } from '../ui/GoogleButton';
import type { Account } from '../ui/useAccount';
import { Badge, Bar, Button, Card, ErrorText, Note, Spinner } from '../ui/ui';
import type { JobState } from './state';

export function ScoreHeader({ result, label = 'Match estimate' }: { result: ScoreResult; label?: string }) {
  const tone = result.score >= 75 ? 'text-emerald-600' : result.score >= 55 ? 'text-amber-600' : 'text-rose-600';
  return (
    <div className="flex items-end gap-3">
      <div className={`text-4xl font-bold leading-none ${tone}`}>{result.score}</div>
      <div className="pb-0.5 text-xs text-slate-600">
        <div className="font-medium text-slate-800">{label}</div>
        <div>
          {result.confidence.label} confidence · range {result.range[0]}–{result.range[1]}
        </div>
      </div>
    </div>
  );
}

const STATE_TONE = { strong: 'green', partial: 'amber', weak: 'amber', none: 'red', unknown: 'slate' } as const;
const STATE_LABEL = { strong: 'Shown', partial: 'Partly shown', weak: 'Weak', none: 'Missing', unknown: 'Unclear' } as const;

function ReqRow({ r }: { r: RequirementResult }) {
  return (
    <li className="flex items-start justify-between gap-2 py-1">
      <div className="min-w-0">
        <p className="text-xs text-slate-800">{r.text}</p>
        {r.reason && <p className="text-[11px] text-slate-500">{r.reason}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
        {r.hard && <span className="text-[10px] text-slate-500">required</span>}
      </div>
    </li>
  );
}

export function MatchStep({
  account,
  job,
  scored,
  onMappings,
  onTailor,
}: {
  account: Account;
  job: JobState;
  scored: Scored;
  onMappings: (m: JobState['mappings']) => Promise<void>;
  onTailor: () => void;
}) {
  const r = scored.result;
  const g = gaps(r);
  const unclear = ambiguous(job.analysis, scored);
  const [refining, setRefining] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showAll, setShowAll] = useState(false);
  const canTailor = selectable(r);

  const refine = async () => {
    setRefining(true);
    setError(null);
    try {
      const evidence = toClaimLite(scored.claims);
      const res =
        account.mode.kind === 'byok'
          ? await byokService(account.mode.settings).mapMatches(unclear, evidence)
          : await api.mapMatches({ ...(job.job_analysis_id ? { job_analysis_id: job.job_analysis_id } : {}), requirements: unclear, evidence });
      await onMappings(res.mappings);
    } catch (e) {
      setError(e);
    } finally {
      setRefining(false);
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <ScoreHeader result={r} />
        <p className="mt-2 text-[11px] text-slate-500">
          Our estimate of how well your resume covers this posting’s requirements. It isn’t an ATS score — no one can see how a specific employer’s system ranks you.
        </p>
        {r.ceiling > r.score && (
          <Note tone="green">With the experience already in your resume, you can reach up to <b>{r.ceiling}</b> by surfacing it better.</Note>
        )}
        {r.eligibility.filter((e) => e.status === 'mismatch').map((e) => <Note key={e.kind} tone="amber">{e.detail}</Note>)}
        {job.analyzed_by === 'local' && <p className="mt-1 text-[11px] text-slate-500">Requirements were read on this device; AI analysis is usually more precise.</p>}
      </Card>

      <Card title="Next step">
        <TailorCta account={account} canTailor={canTailor} onTailor={onTailor} />
        {unclear.length > 0 && account.mode.kind !== 'local' && !job.mappings && (
          <div className="mt-2">
            <Button small kind="ghost" disabled={refining} onClick={() => void refine()}>Refine {unclear.length} unclear {unclear.length === 1 ? 'match' : 'matches'} with AI</Button>
            {refining && <Spinner />}
            <p className="text-[11px] text-slate-500">Sends those requirements and short evidence snippets from your resume (no contact details).</p>
          </div>
        )}
        <ErrorText error={error} />
      </Card>

      {g.not_surfaced.length > 0 && (
        <Card title={`Can be surfaced (${g.not_surfaced.length})`}>
          <p className="text-[11px] text-slate-500">You have evidence for these, but it isn’t visible where it counts. Tailoring targets these.</p>
          <ul className="divide-y divide-slate-100">{g.not_surfaced.map((x) => <ReqRow key={x.req_id} r={x} />)}</ul>
        </Card>
      )}
      {g.missing.length > 0 && (
        <Card title={`Missing (${g.missing.length})`}>
          <p className="text-[11px] text-slate-500">We found no evidence for these. Tailoring won’t invent them — if you do have this experience, add it in the Resume step.</p>
          <ul className="divide-y divide-slate-100">{g.missing.map((x) => <ReqRow key={x.req_id} r={x} />)}</ul>
        </Card>
      )}

      <Card title="Breakdown">
        <ul className="space-y-2">
          {r.categories.map((c) => (
            <li key={c.key}>
              <div className="flex justify-between text-xs">
                <span>{c.label}</span>
                <span className="text-slate-500">{c.value === null ? 'not in this posting' : `${Math.round(c.value * 100)}%`}</span>
              </div>
              {c.value !== null && <Bar label={c.label} value={c.value * 100} tone={c.value >= 0.75 ? 'green' : c.value >= 0.5 ? 'amber' : 'slate'} />}
            </li>
          ))}
        </ul>
        {r.title.target && (
          <p className="mt-2 text-[11px] text-slate-500">
            Title: “{r.title.target}” vs your closest “{r.title.best_match ?? '—'}” ({Math.round(r.title.value * 100)}%)
          </p>
        )}
      </Card>

      <Card title="Keywords" actions={<span className="text-[11px] text-slate-500">counted once each; repeating them doesn’t help</span>}>
        <div className="flex flex-wrap gap-1">
          {r.keywords.map((k) => (
            <Badge key={k.term} tone={k.where === 'bullet' ? 'green' : k.where === 'skills_or_summary' ? 'amber' : 'slate'}>
              {k.term}
              {k.where === 'missing' ? ' ✕' : ''}
              {/* The colour carries meaning; say it in words for screen readers too. */}
              <span className="sr-only">{k.where === 'bullet' ? ' (in a bullet)' : k.where === 'skills_or_summary' ? ' (skills or summary only)' : ' (missing)'}</span>
            </Badge>
          ))}
        </div>
      </Card>

      <Card title="Format checks">
        <ul className="space-y-0.5 text-xs">
          {r.structure.map((s) => (
            <li key={s.id} className={s.pass ? 'text-slate-600' : 'text-amber-700'}>{s.pass ? '✓' : '!'} {s.label}</li>
          ))}
        </ul>
        <p className="mt-1 text-[11px] text-slate-500">Exports use a single-column, text-based layout that passes these.</p>
      </Card>

      <button className="text-xs text-indigo-700" onClick={() => setShowAll((s) => !s)}>{showAll ? 'Hide' : 'Show'} all {r.requirements.length} requirements</button>
      {showAll && (
        <Card>
          <ul className="divide-y divide-slate-100">{r.requirements.filter((x) => x.category !== 'ignored').map((x) => <ReqRow key={x.req_id} r={x} />)}</ul>
        </Card>
      )}
    </div>
  );
}

function selectable(r: ScoreResult): boolean {
  return r.requirements.some((x) => x.state !== 'none' && x.state !== 'unknown' && (x.not_surfaced || x.state === 'partial' || x.state === 'weak'));
}

function TailorCta({ account, canTailor, onTailor }: { account: Account; canTailor: boolean; onTailor: () => void }) {
  const m = account.mode;
  if (!canTailor) return <Note tone="green">Your resume already surfaces everything it can for this job. Nothing to tailor.</Note>;
  if (m.kind === 'hosted') {
    const u = account.usage?.optimizations;
    const left = u ? Math.max(0, u.limit - u.used) + u.credits_remaining : null;
    // The daily cap applies even with runs left this month (credits lift it, like on the server).
    const dailyCapped = !!u && u.credits_remaining === 0 && u.daily_used >= u.daily_limit;
    const blocked = left === 0 || dailyCapped;
    return (
      <div>
        <Button full onClick={onTailor} disabled={blocked}>Tailor my resume</Button>
        <p className="mt-1 text-[11px] text-slate-600">
          {left === null ? '' : left === 0 ? 'You’ve used this month’s tailoring runs. ' : dailyCapped ? `You’ve reached today’s limit of ${u!.daily_limit} runs; it resets tomorrow. ` : `${left} left this period. `}
          Sends your experience with your name and contact details removed; nothing is stored.
        </p>
        {blocked && <Button kind="ghost" small onClick={() => void chrome.runtime.openOptionsPage()}>See plans</Button>}
      </div>
    );
  }
  if (m.kind === 'byok') return <Button full onClick={onTailor}>Tailor with my API key</Button>;
  const msg = {
    signed_out: 'Sign in to tailor your resume with AI — 3 free runs a month.',
    offline: 'You’re offline. Scoring works on this device; tailoring needs a connection.',
    paused: 'AI tailoring is paused right now. Scoring and exports still work.',
    needs_key: 'Your plan uses your own AI provider key. Add it in Settings.',
  }[m.reason];
  if (m.reason === 'signed_out') {
    return (
      <div className="space-y-2">
        <Note>{msg}</Note>
        {GOOGLE_ENABLED ? (
          <>
            <GoogleButton />
            <button className="w-full text-center text-xs text-indigo-700" onClick={() => void chrome.runtime.openOptionsPage()}>Use my email instead</button>
          </>
        ) : (
          <Button full onClick={() => void chrome.runtime.openOptionsPage()}>Sign in</Button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Note>{msg}</Note>
      {m.reason === 'needs_key' && <Button full onClick={() => void chrome.runtime.openOptionsPage()}>Add my key</Button>}
    </div>
  );
}

