import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

// Small UI kit (Tailwind). Everything is rendered as text — no dangerouslySetInnerHTML anywhere (threat #27).

export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-card sm:p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {title && <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ children, onClick, kind = 'primary', disabled, type = 'button', small }: { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; type?: 'button' | 'submit'; small?: boolean }) {
  const styles = {
    primary: 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 active:bg-indigo-800',
    secondary: 'bg-white text-slate-800 border border-slate-300 shadow-sm hover:border-slate-400 hover:bg-slate-50',
    danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700',
    ghost: 'text-indigo-700 hover:bg-indigo-50',
  }[kind];
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`${small ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm'} inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${styles}`}>
      {children}
    </button>
  );
}

export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-slate-600">{label}</div>
        {icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600 [&_svg]:size-4">{icon}</span>}
      </div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs leading-5 text-slate-500">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'indigo' }) {
  const t = { slate: 'bg-slate-100 text-slate-700 ring-slate-200', green: 'bg-emerald-50 text-emerald-800 ring-emerald-200', amber: 'bg-amber-50 text-amber-800 ring-amber-200', red: 'bg-rose-50 text-rose-800 ring-rose-200', indigo: 'bg-indigo-50 text-indigo-800 ring-indigo-200' }[tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${t}`}>{children}</span>;
}

export function Table<T>({ rows, cols, empty = 'Nothing here yet.', onRow }: { rows: T[]; cols: Array<{ h: string; r: (row: T) => ReactNode; right?: boolean }>; empty?: string; onRow?: (row: T) => void }) {
  if (!rows.length) return <p className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-sm text-slate-500">{empty}</p>;
  // Phones: the table keeps its columns and scrolls sideways inside the card instead of squashing them.
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className={`w-full text-sm ${cols.length > 3 ? 'min-w-[36rem]' : ''}`}>
        <thead>
          <tr className="border-y border-slate-200 bg-slate-50/80 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            {cols.map((c) => (
              <th key={c.h} scope="col" className={`whitespace-nowrap px-4 py-2.5 font-medium first:pl-4 sm:first:pl-5 sm:last:pr-5 ${c.right ? 'text-right' : ''}`}>{c.h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row, i) => (
            <tr key={i} className={`transition-colors ${onRow ? 'cursor-pointer hover:bg-indigo-50/40' : 'hover:bg-slate-50/60'}`} onClick={onRow ? () => onRow(row) : undefined}>
              {cols.map((c) => (
                <td key={c.h} className={`px-4 py-3 align-top text-slate-700 sm:first:pl-5 sm:last:pr-5 ${c.right ? 'text-right tabular-nums' : ''}`}>{c.r(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Escape closes the topmost open dialog only (the reason prompt can sit on top of a detail dialog).
const escapeStack: Array<() => void> = [];
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && escapeStack.length) escapeStack[escapeStack.length - 1]!();
  });
}

export function Modal({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const close = () => closeRef.current();
    escapeStack.push(close);
    return () => {
      const i = escapeStack.lastIndexOf(close);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-slate-900/50 backdrop-blur-sm sm:items-start sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-pop sm:mt-16 sm:rounded-2xl sm:p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button type="button" aria-label="Close dialog" className="-m-1.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900" onClick={onClose}>
            <X className="size-5" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-sm font-medium text-slate-800">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-500 transition focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50';

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string; details?: { errors?: Array<{ path?: string; message: string } | string> } };
  return (
    <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
      {e.message ?? String(error)}
      {e.details?.errors && (
        <ul className="mt-1 list-disc pl-5">
          {e.details.errors.map((x, i) => (
            <li key={i}>{typeof x === 'string' ? x : `${x.path ? `${x.path}: ` : ''}${x.message}`}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const usd = (n: number | null | undefined, digits = 2) => (n === null || n === undefined ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
export const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(digits)}%`);
export const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
export const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');

/** Every write needs a reason (stored in the audit log). */
let reasonResolver: ((r: string | null) => void) | null = null;
let setReasonOpen: ((o: { open: boolean; title: string }) => void) | null = null;
export function askReason(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    reasonResolver = resolve;
    setReasonOpen?.({ open: true, title });
  });
}
export function ReasonHost() {
  const [state, setState] = useState({ open: false, title: '' });
  const [text, setText] = useState('');
  useEffect(() => {
    setReasonOpen = setState;
  }, []);
  const close = (v: string | null) => {
    setState({ open: false, title: '' });
    setText('');
    reasonResolver?.(v);
  };
  return (
    <Modal open={state.open} title={state.title} onClose={() => close(null)}>
      <Field label="Reason (saved in the audit log)" hint="At least 10 characters.">
        <textarea className={inputCls} rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </Field>
      <div className="flex justify-end gap-2">
        <Button kind="secondary" onClick={() => close(null)}>Cancel</Button>
        <Button disabled={text.trim().length < 10} onClick={() => close(text.trim())}>Confirm</Button>
      </div>
    </Modal>
  );
}
