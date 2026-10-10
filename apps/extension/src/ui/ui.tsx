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
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
    ghost: 'text-indigo-700 hover:bg-indigo-50',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
  }[kind];
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`${small ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm'} ${full ? 'w-full' : ''} rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-50 ${focusRing} ${cls}`}>
      {children}
    </button>
  );
}

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-3">
      {(title || actions) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'red' | 'indigo' }) {
  const cls = { slate: 'bg-slate-100 text-slate-700', green: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-800', red: 'bg-rose-50 text-rose-700', indigo: 'bg-indigo-50 text-indigo-700' }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  // role=alert: screen readers announce the error as soon as it appears.
  return <p role="alert" className="rounded-md bg-rose-50 p-2 text-xs text-rose-700">{error instanceof Error ? error.message : String(error)}</p>;
}

export function Note({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'amber' | 'green' }) {
  const cls = { slate: 'bg-slate-50 text-slate-600', amber: 'bg-amber-50 text-amber-800', green: 'bg-emerald-50 text-emerald-800' }[tone];
  return <p className={`rounded-md p-2 text-xs ${cls}`}>{children}</p>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-xs text-slate-600">
      <span aria-hidden="true" className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600 motion-reduce:animate-none" />
      {label ?? <span className="sr-only">Working…</span>}
    </span>
  );
}

export const inputCls = 'w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="mb-2 block">
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export function Bar({ value, tone = 'indigo', label }: { value: number; tone?: 'indigo' | 'green' | 'amber' | 'slate'; label: string }) {
  const cls = { indigo: 'bg-indigo-500', green: 'bg-emerald-500', amber: 'bg-amber-500', slate: 'bg-slate-400' }[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} className="h-1.5 w-full rounded-full bg-slate-100">
      <div className={`h-1.5 rounded-full ${cls}`} style={{ width: `${v}%` }} />
    </div>
  );
}
