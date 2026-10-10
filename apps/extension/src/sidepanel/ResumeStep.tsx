import { extractClaims } from '@jmo/evidence';
import { ParseError } from '@jmo/resume';
import type { CanonicalResume, Role, Skill } from '@jmo/shared';
import { field, uuidv7 } from '@jmo/shared';
import { canonicalSkill, lookupSkill } from '@jmo/taxonomy';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { type LoadedResume, parseResumeFile, parseResumeText } from '../lib/files';
import { Badge, Button, Card, ErrorText, focusRing, inputCls, Note, Spinner } from '../ui/ui';
import { useStored } from './state';

const MIN_PASTE = 200;

export function ResumeStep({ base, onSave, onNext }: { base: LoadedResume | null; onSave: (r: LoadedResume | null) => Promise<void>; onNext: () => void }) {
  // Unsaved edits live in the encrypted store too, so switching steps or closing the panel doesn't lose them.
  const [storedDraft, saveDraft] = useStored<LoadedResume>('resume:draft');
  const [replacing, setReplacing] = useState(!base);
  const [error, setError] = useState<unknown>(null);
  const draft = storedDraft ?? null;
  const setDraft = (r: LoadedResume | null) => void saveDraft(r);
  const current = draft ?? base;
  if (storedDraft === undefined) return <p className="text-xs text-slate-600">Loading…</p>;

  if (!current || replacing) {
    return (
      <Upload
        onLoaded={(r) => {
          setDraft(r);
          setReplacing(false);
        }}
        onCancel={base ? () => setReplacing(false) : undefined}
      />
    );
  }
  return (
    <div className="space-y-3">
      {draft && base && <Note tone="amber">You have unsaved changes to your resume.</Note>}
      <ParseWarnings r={current} />
      <ResumeEditor
        key={current.resume.version_id}
        loaded={current}
        onChange={(resume) => setDraft({ ...current, resume })}
      />
      <div className="sticky bottom-0 flex gap-2 border-t border-slate-200 bg-white py-2">
        <Button
          onClick={async () => {
            setError(null);
            try {
              // Changed content is a new version: tailoring done for the old version no longer applies to it.
              await onSave(draft ? { ...current, resume: { ...current.resume, version_id: `v_${uuidv7().slice(0, 8)}` } } : current);
              await saveDraft(null);
              onNext();
            } catch (e) {
              setError(e);
            }
          }}
        >
          {draft ? 'Save and continue' : 'Continue'}
        </Button>
        <Button kind="secondary" onClick={() => setReplacing(true)}>Replace resume</Button>
        {draft && base && <Button kind="ghost" onClick={() => setDraft(null)}>Discard changes</Button>}
      </div>
      <ErrorText error={error} />
    </div>
  );
}

function Upload({ onLoaded, onCancel }: { onLoaded: (r: LoadedResume) => void; onCancel?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const load = async (fn: () => Promise<LoadedResume>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (!r.resume.experience.length && !r.resume.education.length) throw new Error('We couldn’t find work experience or education in this file. Check that it’s your resume, or paste the text instead.');
      onLoaded(r);
    } catch (e) {
      setError(e instanceof ParseError ? new Error(e.message) : e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Add your resume">
      <p className="mb-3 text-xs text-slate-600">It’s read and stored on this device only, encrypted. PDF, DOCX or TXT, up to 10 MB.</p>
      <label
        className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-300 p-6 text-center hover:border-indigo-400 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-indigo-600"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void load(() => parseResumeFile(f));
        }}
      >
        <span className="text-sm font-medium text-indigo-700">Choose a file</span>
        <span className="text-xs text-slate-600">or drop it here</span>
        {/* sr-only, not display:none: the input stays in the tab order so the upload works from the keyboard. */}
        <input
          type="file"
          aria-label="Choose your resume file (PDF, DOCX or TXT)"
          accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void load(() => parseResumeFile(f));
            e.target.value = '';
          }}
        />
      </label>
      {busy && <div className="mt-2"><Spinner label="Reading your resume…" /></div>}
      <ErrorText error={error} />
      <div className="mt-3">
        {!paste ? (
          <Button kind="ghost" small onClick={() => setPaste(true)}>Paste text instead</Button>
        ) : (
          <div className="space-y-2">
            <textarea className={`${inputCls} h-40 text-xs`} aria-label="Resume text" placeholder="Paste your resume text" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex items-center gap-2">
              <Button small disabled={text.trim().length < MIN_PASTE || busy} onClick={() => void load(() => parseResumeText(text))}>Use this text</Button>
              {text.trim().length < MIN_PASTE && <span className="text-[11px] text-slate-600">At least {MIN_PASTE} characters ({text.trim().length} so far)</span>}
            </div>
          </div>
        )}
      </div>
      {onCancel && <div className="mt-2"><Button kind="ghost" small onClick={onCancel}>Cancel</Button></div>}
    </Card>
  );
}

function ParseWarnings({ r }: { r: LoadedResume }) {
  const d = r.doc;
  const notes: string[] = [];
  if (d.columns_detected) notes.push('Two-column layout detected. Check that sections and bullets below are in the right order.');
  if (d.hidden_text_found) notes.push('Hidden or white text was found in the file and ignored. Some screening systems treat hidden text as keyword stuffing.');
  if (d.contact_in_header_only) notes.push('Your contact details are in the page header, which some screening systems skip. Our exports put them in the body.');
  if (d.tables_or_textboxes) notes.push('Tables or text boxes were found; their text may be read out of order by some systems.');
  return (
    <div className="space-y-1">
      <p className="text-xs text-slate-500">
        {r.file_name} · {r.resume.experience.length} roles · {r.resume.skills.length} skills
      </p>
      {notes.map((n) => <Note key={n} tone="amber">{n}</Note>)}
    </div>
  );
}

const edited = <T,>(value: T) => field(value, [], 1, 'user_edit');

function ResumeEditor({ loaded, onChange }: { loaded: LoadedResume; onChange: (r: CanonicalResume) => void }) {
  const r = loaded.resume;
  // Evidence levels come from the same claim extraction the scorer uses (the parser's default is "listed_only").
  const demonstrated = useMemo(() => new Set(extractClaims(r).resume.skills.filter((s) => s.evidence_level === 'demonstrated').map((s) => s.skill_id)), [r]);
  const update = (fn: (draft: CanonicalResume) => void) => {
    const next = structuredClone(r);
    fn(next);
    onChange(next);
  };
  return (
    <div className="space-y-3">
      <Card title="Check what we read">
        <p className="mb-2 text-xs text-slate-600">Fix anything we got wrong. Suggestions will only use what’s here.</p>
        <TextRow label="Name" value={r.personal.full_name?.value ?? ''} onSave={(v) => update((d) => void (d.personal.full_name = edited(v)))} />
        <TextRow label="Email" value={r.personal.emails[0]?.value ?? ''} onSave={(v) => update((d) => void (d.personal.emails = v ? [edited(v)] : []))} />
        <TextRow label="Phone" value={r.personal.phones[0]?.value ?? ''} onSave={(v) => update((d) => void (d.personal.phones = v ? [edited(v)] : []))} />
        <TextRow label="Location" value={r.personal.location?.value ?? ''} onSave={(v) => update((d) => void (d.personal.location = v ? edited(v) : undefined))} />
        <TextRow
          label="Summary"
          multiline
          value={r.summary?.value ?? ''}
          onSave={(v) => update((d) => void (d.summary = v ? { ...edited(v), summary_id: d.summary?.summary_id ?? 'sum_1' } : undefined))}
        />
      </Card>

      {r.experience.map((role, ri) => (
        <RoleCard key={role.role_id} role={role} onChange={(nr) => update((d) => void (d.experience[ri] = nr))} onRemove={() => update((d) => void d.experience.splice(ri, 1))} />
      ))}

      <Card title="Skills">
        <div className="flex flex-wrap gap-1">
          {r.skills.map((s, i) => (
            <span key={s.skill_id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs">
              {s.name.value}
              {!demonstrated.has(s.skill_id) && <span title="Listed, but not shown in any bullet" className="text-amber-700"><span aria-hidden="true">•</span><span className="sr-only">(listed, not shown in a bullet)</span></span>}
              <button className="text-slate-400 hover:text-rose-600" aria-label={`Remove ${s.name.value}`} onClick={() => update((d) => void d.skills.splice(i, 1))}>×</button>
            </span>
          ))}
        </div>
        <AddSkill onAdd={(name) => update((d) => void d.skills.push(newSkill(name)))} />
        <p className="mt-1 text-[11px] text-slate-600"><span className="text-amber-700">•</span> listed but not shown in any bullet — tailoring can surface these where your bullets support them.</p>
      </Card>

      {r.education.length > 0 && (
        <Card title="Education">
          {r.education.map((e) => (
            <p key={e.education_id} className="text-xs text-slate-700">
              {[e.degree?.value, e.field_of_study?.value].filter(Boolean).join(', ')} — {e.institution.value} {e.end?.value ? `(${e.end.value})` : ''}
            </p>
          ))}
        </Card>
      )}
    </div>
  );
}

function newSkill(name: string): Skill {
  const entry = lookupSkill(name);
  return {
    skill_id: `sk_${uuidv7().slice(-8)}`,
    name: edited(name),
    normalized: { canonical: canonicalSkill(name), ...(entry ? { taxonomy_id: entry.id } : {}), aliases: entry?.aliases ?? [] },
    ...(entry ? { category: entry.category as Skill['category'] } : {}),
    evidence_level: 'listed_only',
    claim_ids: [],
  };
}

function RoleCard({ role, onChange, onRemove }: { role: Role; onChange: (r: Role) => void; onRemove: () => void }) {
  const set = (fn: (r: Role) => void) => {
    const next = structuredClone(role);
    fn(next);
    onChange(next);
  };
  return (
    <Card
      title={<span>{role.title.value || 'Untitled role'} <span className="font-normal text-slate-500">· {role.employer.value}</span></span>}
      actions={<Button kind="ghost" small onClick={onRemove}>Remove</Button>}
    >
      <TextRow label="Title" value={role.title.value} onSave={(v) => set((r) => void (r.title = edited(v)))} />
      <TextRow label="Employer" value={role.employer.value} onSave={(v) => set((r) => void (r.employer = edited(v)))} />
      <div className="grid grid-cols-2 gap-2">
        <TextRow label="Start (YYYY-MM)" value={role.start?.value ?? ''} onSave={(v) => set((r) => void (r.start = v ? edited(v) : undefined))} />
        <TextRow label="End (YYYY-MM or present)" value={role.end?.value ?? ''} onSave={(v) => set((r) => void (r.end = v ? edited(v) : undefined))} />
      </div>
      <ul className="mt-1 space-y-1">
        {role.bullets.map((b, bi) => (
          <li key={b.bullet_id} className="flex gap-1">
            <span aria-hidden="true" className="mt-1.5 text-slate-500">•</span>
            <EditableText
              value={b.text}
              onSave={(v) =>
                set((r) => {
                  if (!v) r.bullets.splice(bi, 1);
                  else r.bullets[bi] = { ...b, text: v, prov: { span_ids: b.prov.span_ids, source: 'user_edit' } };
                })
              }
            />
          </li>
        ))}
      </ul>
      <Button kind="ghost" small onClick={() => set((r) => void r.bullets.push({ bullet_id: `${r.role_id}.b_${uuidv7().slice(-6)}`, text: 'New bullet — describe something you did', prov: { span_ids: [], source: 'user_edit' }, claim_ids: [] }))}>
        + Add bullet
      </Button>
    </Card>
  );
}

function TextRow({ label, value, onSave, multiline }: { label: string; value: string; onSave: (v: string) => void; multiline?: boolean }) {
  return (
    <div className="mb-1">
      <span className="block text-[11px] text-slate-600">{label}</span>
      {/* Single line unless asked (Summary): Name, Email, Title, dates… must not take line breaks, and Enter saves. */}
      <EditableText label={label} value={value} onSave={onSave} multiline={!!multiline} />
    </div>
  );
}

/** Click to edit; Enter (single line) or leaving the field saves, Escape cancels. */
function EditableText({ value, onSave, multiline = true, label = 'bullet' }: { value: string; onSave: (v: string) => void; multiline?: boolean; label?: string }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  if (!editing) {
    return (
      <button aria-label={`Edit ${label}: ${value || 'empty'}`} className={`w-full rounded px-1 text-left text-xs text-slate-800 hover:bg-slate-50 ${focusRing}`} onClick={() => { setV(value); setEditing(true); }}>
        {value || <span className="text-slate-500">—</span>}
      </button>
    );
  }
  let done = false; // Enter commits, and the unmount that follows must not commit a second time
  const commit = () => {
    if (done) return;
    done = true;
    setEditing(false);
    if (v.trim() !== value) onSave(v.trim());
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      done = true;
      setEditing(false);
    } else if (e.key === 'Enter' && !multiline) commit();
  };
  return multiline ? (
    <textarea autoFocus aria-label={label} className={`${inputCls} text-xs`} rows={3} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={keys} />
  ) : (
    <input autoFocus aria-label={label} className={`${inputCls} text-xs`} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={keys} />
  );
}

function AddSkill({ onAdd }: { onAdd: (name: string) => void }) {
  const [v, setV] = useState('');
  return (
    <form
      className="mt-2 flex gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onAdd(v.trim());
        setV('');
      }}
    >
      <input className={`${inputCls} text-xs`} aria-label="Add a skill you have" placeholder="Add a skill you have" value={v} onChange={(e) => setV(e.target.value)} />
      <Button small type="submit" kind="secondary">Add</Button>
    </form>
  );
}

export function ResumeSummary({ base }: { base: LoadedResume }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span>{base.resume.personal.full_name?.value ?? 'Your resume'} · {base.resume.experience.length} roles</span>
      <Badge tone="green">on this device</Badge>
    </div>
  );
}
