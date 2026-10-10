import { DEFAULT_ADAPTERS } from '@jmo/job-extraction';
import type { ExtractedJob } from '@jmo/shared';
import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import { byokService } from '../lib/engine';
import { analyzeLocally, extractFromActiveTab, jobFromText, PageAccessError } from '../lib/job';
import type { Account } from '../ui/useAccount';
import { Badge, Button, Card, ErrorText, inputCls, Note, Spinner } from '../ui/ui';
import type { JobState } from './state';

const WARNINGS: Record<string, string> = {
  hidden_text_removed: 'Hidden text on the page was ignored.',
  truncated: 'This posting is very long; we used the first 20,000 characters.',
  structured_visible_conflict: 'The page’s structured data didn’t match what’s shown, so we read the visible text. Check it below.',
  posting_closed: 'This posting says it’s closed or expired.',
};

export function JobStep({ account, current, onDone }: { account: Account; current: JobState | null; onDone: (j: JobState) => Promise<void> }) {
  const [job, setJob] = useState<ExtractedJob | null>(current?.job ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const [showText, setShowText] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Text sent from the context menu ("Analyze selected text as a job description").
  useEffect(() => {
    const take = async () => {
      const { pendingSelection } = (await chrome.storage.session.get('pendingSelection')) as { pendingSelection?: { text: string; pageUrl: string; pageTitle: string; at: number } };
      if (!pendingSelection || Date.now() - pendingSelection.at > 5 * 60_000) return;
      await chrome.storage.session.remove('pendingSelection');
      if (pendingSelection.text.trim().length < 40) return setError(new Error('Select more of the job description, then try again.'));
      setJob(await jobFromText(pendingSelection.text, { url: pendingSelection.pageUrl, title: pendingSelection.pageTitle }));
    };
    const takeSafely = () => take().catch(setError);
    void takeSafely();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes.pendingSelection?.newValue) void takeSafely();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const adapters = account.config?.extractors.length ? account.config.extractors.filter((a) => a.enabled) : DEFAULT_ADAPTERS;

  const readPage = async () => {
    setBusy('Reading the job posting…');
    setError(null);
    try {
      setJob(await extractFromActiveTab(adapters));
    } catch (e) {
      setError(e);
      if (e instanceof PageAccessError && e.reason !== 'restricted_page') setPaste(true);
    } finally {
      setBusy(null);
    }
  };

  const analyze = async (j: ExtractedJob) => {
    setBusy('Analyzing the requirements…');
    setError(null);
    setNotice(null);
    try {
      const mode = account.mode;
      let state: JobState;
      if (mode.kind === 'hosted') {
        try {
          const r = await api.analyzeJob(j);
          state = { job: j, analysis: r.analysis, job_analysis_id: r.job_analysis_id, analyzed_by: 'hosted', at: new Date().toISOString() };
        } catch (e) {
          if (!(e instanceof api.ApiFailure) || !['quota_exceeded', 'offline', 'ai_unavailable', 'rate_limited', 'maintenance'].includes(e.code)) throw e;
          setNotice(`${e.message} We used on-device analysis instead.`);
          state = { job: j, analysis: analyzeLocally(j), analyzed_by: 'local', at: new Date().toISOString() };
        }
      } else if (mode.kind === 'byok') {
        const r = await byokService(mode.settings).analyzeJob(j.description_text, { ...(j.fields.title ? { title: j.fields.title } : {}), ...(j.fields.company ? { company: j.fields.company } : {}), location: j.fields.location });
        state = { job: j, analysis: r.analysis, analyzed_by: r.fallback ? 'local' : 'byok', at: new Date().toISOString() };
      } else {
        state = { job: j, analysis: analyzeLocally(j), analyzed_by: 'local', at: new Date().toISOString() };
      }
      await onDone(state);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <Card title="Job posting">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void readPage()} disabled={!!busy}>Analyze this page</Button>
          <Button kind="secondary" onClick={() => setPaste((p) => !p)} disabled={!!busy}>Paste text</Button>
        </div>
        <p className="mt-2 text-[11px] text-slate-600">Or select the description on any page, right-click, and choose “Analyze selected text as a job description”.</p>
        {paste && (
          <div className="mt-2 space-y-2">
            <textarea className={`${inputCls} h-36 text-xs`} aria-label="Job description text" placeholder="Paste the job description" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex items-center gap-2">
              <Button
                small
                kind="secondary"
                disabled={text.trim().length < 100}
                onClick={async () => {
                  setError(null);
                  try {
                    setJob(await jobFromText(text));
                    setPaste(false);
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                Use this text
              </Button>
              {text.trim().length < 100 && <span className="text-[11px] text-slate-600">At least 100 characters ({text.trim().length} so far)</span>}
            </div>
          </div>
        )}
        {busy && <div className="mt-2"><Spinner label={busy} /></div>}
        <div className="mt-2"><ErrorText error={error} /></div>
      </Card>

      {job && (
        <Card
          title={job.fields.title || 'Untitled posting'}
          actions={<Badge tone={job.source.confidence >= 0.7 ? 'green' : 'amber'}>{job.source.adapter}</Badge>}
        >
          <p className="text-xs text-slate-600">{[job.fields.company, job.fields.location.join(' · ')].filter(Boolean).join(' — ') || job.source.host}</p>
          <div className="mt-2 space-y-1">
            {job.warnings.filter((w) => WARNINGS[w]).map((w) => <Note key={w} tone="amber">{WARNINGS[w]}</Note>)}
          </div>
          <button className="mt-2 text-xs text-indigo-700" onClick={() => setShowText((s) => !s)}>{showText ? 'Hide text' : `Show text (${job.description_text.length.toLocaleString()} characters)`}</button>
          {showText && <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-700">{job.description_text}</pre>}
          <div className="mt-3">
            <Button full disabled={!!busy} onClick={() => void analyze(job)}>
              {current?.job.jd_hash === job.jd_hash ? 'Re-analyze' : 'Analyze requirements'}
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {account.mode.kind === 'hosted' ? 'The job text is sent to our server for analysis (no resume data).' : account.mode.kind === 'byok' ? 'Analyzed with your own API key.' : 'Analyzed on this device.'}
          </p>
        </Card>
      )}
      {notice && <Note tone="amber">{notice}</Note>}
    </div>
  );
}
