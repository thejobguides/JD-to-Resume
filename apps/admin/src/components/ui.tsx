import { type ReactNode, useEffect, useRef, useState } from 'react';

// Small UI kit (Tailwind). Everything is rendered as text — no dangerouslySetInnerHTML anywhere (threat #27).

export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-slate-700">{title}</h2>}
          {actions && <div className="flex gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ children, onClick, kind = 'primary', disabled, type = 'button', small }: { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; type?: 'button' | 'submit'; small?: boolean }) {
  const styles = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
    ghost: 'text-indigo-700 hover:bg-indigo-50',
  }[kind];
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`${small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'} rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${styles}`}>
      {children}
    </button>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'indigo' }) {
  const t = { slate: 'bg-slate-100 text-slate-700', green: 'bg-emerald-100 text-emerald-800', amber: 'bg-amber-100 text-amber-800', red: 'bg-rose-100 text-rose-800', indigo: 'bg-indigo-100 text-indigo-800' }[tone];
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

export function Table<T>({ rows, cols, empty = 'Nothing here yet.', onRow }: { rows: T[]; cols: Array<{ h: string; r: (row: T) => ReactNode; right?: boolean }>; empty?: string; onRow?: (row: T) => void }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-slate-500">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            {cols.map((c) => (
              <th key={c.h} className={`px-2 py-1.5 font-medium ${c.right ? 'text-right' : ''}`}>{c.h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={`border-b border-slate-100 ${onRow ? 'cursor-pointer hover:bg-slate-50' : ''}`} onClick={onRow ? () => onRow(row) : undefined}>
              {cols.map((c) => (
                <td key={c.h} className={`px-2 py-1.5 align-top ${c.right ? 'text-right tabular-nums' : ''}`}>{c.r(row)}</td>
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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="mt-16 w-full max-w-lg rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-base font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string; details?: { errors?: Array<{ path?: string; message: string } | string> } };
  return (
    <div role="alert" className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
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
