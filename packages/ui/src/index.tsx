import { useId } from 'react';

// Shared brand pieces for the website, the admin panel and the extension.

/** The brand mark: a resume page with a check, on the indigo→violet gradient. Decorative unless given a `title`. */
export function LogoMark({ className = 'size-8', title }: { className?: string; title?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" className={className} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#9333ea" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <path d="M11.5 7.5h6.6l4.4 4.4v11.6a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 10 23.5v-14.5a1.5 1.5 0 0 1 1.5-1.5z" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M17.8 7.7v4.5h4.5" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M13.2 17.6l2.2 2.2 4.1-4.4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Mark + wordmark, with an optional second line (e.g. "Admin"). */
export function Logo({ className = '', suffix }: { className?: string; suffix?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className="size-8 shrink-0" />
      <span className="flex flex-col leading-tight">
        <span className="text-[15px] font-semibold tracking-tight text-slate-900">Job Match Optimizer</span>
        {suffix && <span className="text-xs font-medium text-slate-500">{suffix}</span>}
      </span>
    </span>
  );
}

/** Joins class names, skipping falsy ones. */
export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}
