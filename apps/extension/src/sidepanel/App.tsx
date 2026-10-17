import { CONSENT_VERSION } from '@jmo/shared';
import { LogoMark } from '@jmo/ui';
import { Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { applyAndRescore, score } from '../lib/engine';
import type { LoadedResume } from '../lib/files';
import { type Account, useAccount } from '../ui/useAccount';
import { Badge, Button, focusRing, Note } from '../ui/ui';
import { ExportStep } from './ExportStep';
import { JobStep } from './JobStep';
import { MatchStep } from './MatchStep';
import { ResumeStep } from './ResumeStep';
import { type JobState, type Step, type TailorState, useStored } from './state';
import { TailorStep } from './TailorStep';

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'resume', label: 'Resume' },
  { id: 'job', label: 'Job' },
  { id: 'match', label: 'Match' },
  { id: 'tailor', label: 'Tailor' },
  { id: 'export', label: 'Export' },
];

export function App() {
  const account = useAccount();
  const [consent, setConsent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void chrome.storage.local.get('consent').then((r) => setConsent((r.consent as string | undefined) ?? null));
  }, []);
  if (consent === undefined || account.loading) return <p className="p-4 text-xs text-slate-500">Loading…</p>;
  if (consent !== CONSENT_VERSION) return <Consent onAccept={async () => { await chrome.storage.local.set({ consent: CONSENT_VERSION }); setConsent(CONSENT_VERSION); }} />;
  return <Main account={account} />;
}

function Main({ account }: { account: Account }) {
  const [base, setBase] = useStored<LoadedResume>('resume:base');
  const [job, setJob] = useStored<JobState>('job:current');
  const [tailor, setTailor] = useStored<TailorState>('tailor:current');
  const [step, setStep] = useState<Step | null>(null);
  const [updateReady, setUpdateReady] = useState(false);

  // Pick a starting step once storage has loaded.
  useEffect(() => {
    if (step || base === undefined || job === undefined || tailor === undefined) return;
    if (!base) setStep('resume');
    else if (!job) setStep('job');
    else if (tailor && tailor.job_hash === job.job.jd_hash) setStep('tailor');
    else setStep('match');
  }, [base, job, tailor, step]);

  // Context-menu selections jump straight to the Job step.
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      if (changes.pendingSelection?.newValue) setStep('job');
      if (changes.updateAvailable?.newValue) setUpdateReady(true);
    };
    void chrome.storage.session.get(['pendingSelection', 'updateAvailable']).then((r) => {
      if (r.pendingSelection) setStep('job');
      if (r.updateAvailable) setUpdateReady(true);
    });
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const scored = useMemo(() => (base && job ? score(job.analysis, base.resume, job.mappings) : null), [base, job]);
  const currentTailor = tailor && job && base && tailor.job_hash === job.job.jd_hash && tailor.resume_version === base.resume.version_id ? tailor : null;
  const applied = useMemo(() => {
    if (!scored || !job || !currentTailor?.result || currentTailor.status !== 'done') return null;
    const edits = Object.fromEntries(Object.entries(currentTailor.edits).filter(([id]) => currentTailor.accepted.includes(id)));
    return applyAndRescore(scored, job.analysis, currentTailor.result, { bullets: new Set(currentTailor.accepted), summary: currentTailor.summary, skillsOrder: currentTailor.skills, edits }, job.mappings);
  }, [scored, job, currentTailor]);

  const enabled: Record<Step, boolean> = {
    resume: true,
    job: !!base,
    match: !!base && !!job,
    tailor: !!base && !!job,
    export: !!base,
  };
  // Data can disappear under the open panel ("Delete all local data" in the settings page, another tab): never leave
  // the user on a step that can no longer render (an empty panel); fall back to the first step that can.
  useEffect(() => {
    if (step && !enabled[step]) setStep(!base ? 'resume' : 'job');
  });
  const announcements = (account.config?.announcements ?? []).filter((a) => a.plans.includes('all') || (account.me && a.plans.includes(account.me.plan)));
  const outdated = account.config && cmp(__EXT_VERSION__, account.config.min_extension_version) < 0;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-3 pt-2.5 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight text-slate-900">
            <LogoMark className="size-6 shrink-0" />
            <span className="truncate">Job Match Optimizer</span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {account.signedIn ? <Badge tone="indigo">{planLabel(account)}</Badge> : <button className={`rounded-md px-2 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 ${focusRing}`} onClick={() => void chrome.runtime.openOptionsPage()}>Sign in</button>}
            <button title="Settings" aria-label="Settings" className={`inline-flex size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 ${focusRing}`} onClick={() => void chrome.runtime.openOptionsPage()}>
              <Settings className="size-4" aria-hidden />
            </button>
          </span>
        </div>
        <nav aria-label="Steps" className="mt-2 flex text-[11px]">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              disabled={!enabled[s.id]}
              aria-current={step === s.id ? 'step' : undefined}
              onClick={() => setStep(s.id)}
              className={`flex-1 border-b-2 pb-2 pt-1 font-medium transition-colors ${focusRing} ${step === s.id ? 'border-indigo-600 font-semibold text-indigo-700' : 'border-transparent text-slate-600 hover:text-slate-900'} disabled:text-slate-400 disabled:hover:text-slate-400`}
            >
              {i + 1}. {s.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 space-y-3 p-3">
        {updateReady && (
          <Note tone="amber">
            An update is ready. <button className="font-medium underline" onClick={() => void chrome.runtime.sendMessage({ type: 'app.reload' })}>Reload now</button> (your work is saved).
          </Note>
        )}
        {outdated && <Note tone="amber">This version is out of date. Update the extension from chrome://extensions to keep AI features working.</Note>}
        {announcements.map((a) => <Note key={a.id}>{a.text}</Note>)}

        {step === 'resume' && <ResumeStep base={base ?? null} onSave={async (r) => { await setBase(r); }} onNext={() => setStep(job ? 'match' : 'job')} />}
        {step === 'job' && base && (
          <JobStep
            account={account}
            current={job ?? null}
            onDone={async (j) => {
              await setJob(j);
              setStep('match');
            }}
          />
        )}
        {step === 'match' && base && job && scored && (
          <MatchStep account={account} job={job} scored={scored} onMappings={async (m) => setJob({ ...job, ...(m ? { mappings: m } : {}) })} onTailor={() => setStep('tailor')} />
        )}
        {step === 'tailor' && base && job && scored && (
          <TailorStep account={account} base={base} job={job} scored={scored} tailor={tailor ?? null} setTailor={setTailor} setJob={setJob} applied={applied} onExport={() => setStep('export')} />
        )}
        {step === 'export' && base && <ExportStep account={account} base={base} scored={scored} job={job ?? null} tailor={currentTailor} applied={applied} />}
      </main>
    </div>
  );
}

function planLabel(a: Account): string {
  if (!a.me) return a.offline ? 'offline' : 'signed in';
  return { free: 'Free', pro_monthly: 'Pro', pro_quarterly: 'Pro', byok_annual: 'Own key', credit_pack: 'Credits' }[a.me.plan];
}

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function Consent({ onAccept }: { onAccept: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="min-h-screen space-y-4 bg-slate-50 p-4">
      <div className="flex items-center gap-2.5">
        <LogoMark className="size-9" />
        <h1 className="text-base font-semibold tracking-tight text-slate-900">Before you start</h1>
      </div>
      <ul className="list-disc space-y-2.5 rounded-xl border border-slate-200 bg-white p-4 pl-8 text-xs leading-5 text-slate-700 shadow-card marker:text-indigo-500">
        <li><b>Your resume stays on this device.</b> It’s read, scored and exported here, stored encrypted, and never uploaded as a file.</li>
        <li><b>When you use AI features</b> (tailoring, or refining a match), we send the parts needed — your experience, skills and summary, with your name and contact details removed — to our server and an AI provider that doesn’t train on it. Nothing is kept after it’s processed.</li>
        <li><b>Job text</b> you analyze is sent to our server so requirements can be extracted (and cached, without any link to you).</li>
        <li><b>Nothing is invented.</b> Suggestions may only use facts already in your resume, and you review every change.</li>
        <li><b>The match score is our estimate</b>, not an ATS score. No tool can see how a specific employer ranks you.</li>
      </ul>
      <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-white p-3 text-xs leading-5 shadow-card">
        <input type="checkbox" className="mt-0.5 size-4 accent-indigo-600" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>I understand. (Details in the <a className="text-indigo-700 underline" href={`${__WEB_URL__}/privacy`} target="_blank" rel="noreferrer">privacy notice</a>.)</span>
      </label>
      <Button full disabled={!ok} onClick={onAccept}>Continue</Button>
    </div>
  );
}
