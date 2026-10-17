import type { ReactNode } from 'react';

/** Visible keyboard focus for every interactive element (WCAG 2.4.7); mouse clicks don't show it. */
export const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600';

export function Button({
  children,
  onClick,
  disabled,
  kind = 'primary',
  small,
  type = 'button',
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  small?: boolean;
  type?: 'button' | 'submit';
  full?: boolean;
}) {
  const cls = {
    primary: 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 active:bg-indigo-800',
    secondary: 'border border-slate-300 bg-white text-slate-800 shadow-sm hover:border-slate-400 hover:bg-slate-50',
    ghost: 'text-indigo-700 hover:bg-indigo-50',
    danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700',
  }[kind];
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`${small ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm'} ${full ? 'flex w-full' : 'inline-flex'} items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${cls}`}>
      {children}
    </button>
  );
}

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'indigo' }) {
  const cls = { slate: 'bg-slate-100 text-slate-700 ring-slate-200', green: 'bg-emerald-50 text-emerald-800 ring-emerald-200', amber: 'bg-amber-50 text-amber-800 ring-amber-200', red: 'bg-rose-50 text-rose-700 ring-rose-200', indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200' }[tone];
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${cls}`}>{children}</span>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  // role=alert: screen readers announce the error as soon as it appears.
  return <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">{error instanceof Error ? error.message : String(error)}</p>;
}

export function Note({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'amber' | 'green' }) {
  const cls = { slate: 'border-slate-200 bg-slate-50 text-slate-700', amber: 'border-amber-200 bg-amber-50 text-amber-900', green: 'border-emerald-200 bg-emerald-50 text-emerald-900' }[tone];
  return <p className={`rounded-lg border px-3 py-2 text-xs leading-5 ${cls}`}>{children}</p>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-xs text-slate-600">
      <span aria-hidden="true" className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600 motion-reduce:animate-none" />
      {label ?? <span className="sr-only">Working…</span>}
    </span>
  );
}

export const inputCls = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-500 transition focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="mb-2 block">
      <span className="mb-1.5 block text-xs font-semibold text-slate-800">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function Bar({ value, tone = 'indigo', label }: { value: number; tone?: 'indigo' | 'green' | 'amber' | 'slate'; label: string }) {
  const cls = { indigo: 'bg-indigo-500', green: 'bg-emerald-500', amber: 'bg-amber-500', slate: 'bg-slate-400' }[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full transition-all ${cls}`} style={{ width: `${v}%` }} />
    </div>
  );
}
