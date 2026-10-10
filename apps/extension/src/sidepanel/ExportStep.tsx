import type { TemplateId } from '@jmo/resume/generate';
import { useState } from 'react';
import * as api from '../lib/api';
import type { Applied, Scored } from '../lib/engine';
import { type ExportFormat, exportResume, type LoadedResume, saveBlob } from '../lib/files';
import * as store from '../lib/store';
import type { Account } from '../ui/useAccount';
import { Button, Card, ErrorText, focusRing, Note } from '../ui/ui';
import type { HistoryItem, JobState, TailorState } from './state';

const TEMPLATES: Array<{ id: TemplateId; name: string; detail: string }> = [
  { id: 'classic', name: 'Classic', detail: 'Serif headings, traditional spacing' },
  { id: 'modern', name: 'Modern', detail: 'Clean sans-serif, compact' },
];

export function ExportStep({ account, base, scored, job, tailor, applied }: { account: Account; base: LoadedResume; scored: Scored | null; job: JobState | null; tailor: TailorState | null; applied: Applied | null }) {
  const [which, setWhich] = useState<'tailored' | 'original'>(applied ? 'tailored' : 'original');
  const [template, setTemplate] = useState<TemplateId>('classic');
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [rated, setRated] = useState(false);
  const resume = which === 'tailored' && applied ? applied.resume : base.resume;

  const recordOnce = async () => {
    if (!tailor || !applied || !scored || which !== 'tailored') return;
    const id = `history:${tailor.id}`;
    if (await store.get(id)) return;
    const item: HistoryItem = {
      id: tailor.id,
      at: new Date().toISOString(),
      ...(job?.job.fields.title ? { title: job.job.fields.title } : {}),
      ...(job?.job.fields.company ? { company: job.job.fields.company } : {}),
      before: scored.result.score,
      after: applied.after.score,
      ceiling: scored.result.ceiling,
      resume: applied.resume,
      attested: tailor.attested,
    };
    await store.put(id, item);
    // Scores only (three numbers) so we can measure whether tailoring helps; no content.
    if (tailor.optimization_id) void api.postScores(tailor.optimization_id, { before_score: item.before, after_score: item.after, ceiling_score: item.ceiling }).catch(() => undefined);
  };

  const download = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      const { blob, name } = await exportResume(resume, format, template, job?.job.fields.company);
      saveBlob(blob, name);
      await recordOnce();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {applied && (
        <Card title="Which version?">
          {/* A real radio group: one tab stop, arrow keys move between the options. */}
          <fieldset className="space-y-1 text-xs">
            <legend className="sr-only">Version to export</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="export-version" checked={which === 'tailored'} onChange={() => setWhich('tailored')} /> Tailored for {job?.job.fields.company ?? 'this job'} — match estimate {applied.after.score}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="export-version" checked={which === 'original'} onChange={() => setWhich('original')} /> Original{scored ? ` — match estimate ${scored.result.score}` : ''}
            </label>
          </fieldset>
        </Card>
      )}
      <Card title="Template">
        <div className="grid grid-cols-2 gap-2">
          {TEMPLATES.map((t) => (
            <button key={t.id} aria-pressed={template === t.id} onClick={() => setTemplate(t.id)} className={`rounded-md border p-2 text-left text-xs ${focusRing} ${template === t.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:bg-slate-50'}`}>
              <div className="font-medium">{t.name}</div>
              <div className="text-[11px] text-slate-600">{t.detail}</div>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Both are single-column, text-based and use standard section headings, so screening software can read them.</p>
      </Card>
      <Card title="Download">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void download('pdf')} disabled={!!busy}>{busy === 'pdf' ? 'Preparing…' : 'PDF'}</Button>
          <Button kind="secondary" onClick={() => void download('docx')} disabled={!!busy}>{busy === 'docx' ? 'Preparing…' : 'Word (DOCX)'}</Button>
          <Button kind="secondary" onClick={() => void download('txt')} disabled={!!busy}>Plain text</Button>
        </div>
        <div className="mt-2"><ErrorText error={error} /></div>
        <Note>Read it through before you send it. You’re responsible for what your resume says.</Note>
      </Card>
      {tailor?.optimization_id && account.signedIn && !rated && (
        <Card>
          <div className="flex items-center justify-between text-xs">
            <span>Were these suggestions useful?</span>
            <span className="flex gap-1">
              <Button small kind="secondary" onClick={() => { setRated(true); void api.sendFeedback({ optimization_id: tailor.optimization_id!, target: 'general', rating: 1 }).catch(() => undefined); }}>Yes</Button>
              <Button small kind="secondary" onClick={() => { setRated(true); void api.sendFeedback({ optimization_id: tailor.optimization_id!, target: 'general', rating: -1 }).catch(() => undefined); }}>No</Button>
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
