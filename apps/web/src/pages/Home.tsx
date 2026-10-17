import { cx, LogoMark } from '@jmo/ui';
import { ArrowRight, BadgeCheck, Check, ChevronDown, Download, FileText, Gauge, MousePointerClick, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { plans as fetchPlans, type PublicPlan } from '../api';
import { buttonCls, Link } from '../App';

const STORE = import.meta.env.VITE_CHROME_STORE_URL;

export function HomePage() {
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    // The API sleeps when idle on the free hosting plan and takes up to a minute to answer the first request; say so
    // instead of showing an empty section, and retry once if that first request fails while it starts.
    let live = true;
    const slowTimer = setTimeout(() => live && setSlow(true), 3_000);
    fetchPlans()
      .catch(() => new Promise<Awaited<ReturnType<typeof fetchPlans>>>((ok, fail) => setTimeout(() => fetchPlans().then(ok, fail), 5_000)))
      .then((r) => live && setPlans(r.plans))
      .catch(() => live && setPlans([]))
      .finally(() => clearTimeout(slowTimer));
    if (location.hash === '#pricing') setTimeout(() => document.getElementById('pricing')?.scrollIntoView(), 50);
    return () => {
      live = false;
      clearTimeout(slowTimer);
    };
  }, []);
  return (
    <>
      <Hero />
      <HowItWorks />
      <Principles />
      <Pricing plans={plans} slow={slow} />
      <Faq />
      <FinalCta />
    </>
  );
}

function PrimaryCta({ className = '' }: { className?: string }) {
  return STORE ? (
    <a href={STORE} className={buttonCls('primary', 'lg', className)}>
      Add to Chrome — it’s free
      <ArrowRight className="size-4" aria-hidden />
    </a>
  ) : (
    <span className={cx('inline-flex h-12 items-center gap-2 rounded-lg bg-slate-100 px-5 text-sm font-medium text-slate-700 ring-1 ring-slate-200', className)}>
      <Sparkles className="size-4 text-indigo-600" aria-hidden />
      Chrome Web Store listing coming soon
    </span>
  );
}

// ── Hero ──

function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(60rem_40rem_at_15%_-10%,var(--color-indigo-100),transparent_60%),radial-gradient(50rem_35rem_at_100%_0%,var(--color-fuchsia-100),transparent_55%)]" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,rgb(15_23_42/0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgb(15_23_42/0.04)_1px,transparent_1px)] bg-[size:44px_44px] [mask-image:radial-gradient(ellipse_at_top,black_40%,transparent_75%)]" />
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 sm:pt-16 lg:grid-cols-[1.25fr_1fr] lg:gap-14 lg:px-8 lg:pb-24 lg:pt-24">
        <div className="animate-fade-up">
          <p className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white/80 px-3 py-1 text-xs font-semibold text-indigo-700 shadow-sm">
            <ShieldCheck className="size-3.5" aria-hidden />
            Chrome extension · Private by design
          </p>
          <h1 className="mt-5 text-4xl font-bold leading-[1.08] tracking-tight text-slate-900 sm:text-5xl lg:text-[3.25rem]">
            Tailor your resume to the job in front of you — <span className="text-brand-gradient">without inventing anything.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-slate-600">
            A Chrome extension that reads the job posting, compares it with your resume, and suggests rewrites you can accept or reject. Every suggestion is checked against what your resume already says.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <PrimaryCta />
            <a href="#pricing" className={buttonCls('secondary', 'lg')}>See pricing</a>
          </div>
          <ul className="mt-8 flex flex-col gap-2.5 text-sm text-slate-700 sm:flex-row sm:flex-wrap sm:gap-x-6">
            {['Resume stays on your device', 'No made-up experience', 'Free plan, no card'].map((t) => (
              <li key={t} className="flex items-center gap-2">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700"><Check className="size-3.5" strokeWidth={3} aria-hidden /></span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <ProductPreview />
      </div>
    </section>
  );
}

/** A drawing of the side panel (not interactive): match estimate, requirements and one suggested rewrite. */
function ProductPreview() {
  const reqs: Array<[string, 'met' | 'partial' | 'gap']> = [
    ['Python and SQL in production', 'met'],
    ['Orchestration with Airflow', 'met'],
    ['Data modeling (dbt)', 'partial'],
    ['Streaming with Kafka', 'gap'],
  ];
  return (
    <div className="relative mx-auto w-full max-w-md animate-fade-up [animation-delay:120ms] lg:max-w-none">
      <div aria-hidden className="absolute -inset-4 -z-10 rounded-[2rem] bg-gradient-to-tr from-indigo-200/60 via-violet-200/40 to-fuchsia-200/50 blur-2xl" />
      <figure role="img" aria-label="Preview of the extension: a 78% match estimate, the posting’s requirements and a suggested rewrite to accept or reject." className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-pop">
        <div aria-hidden>
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div className="flex items-center gap-2">
              <LogoMark className="size-6" />
              <span className="text-sm font-semibold">Match</span>
            </div>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((i) => <span key={i} className={cx('h-1.5 w-6 rounded-full', i <= 3 ? 'bg-indigo-500' : 'bg-slate-200')} />)}
            </div>
          </div>
          <div className="space-y-4 p-4 sm:p-5">
            <div className="flex items-center gap-4">
              <ScoreRing value={78} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">Senior Data Engineer</p>
                <p className="text-xs text-slate-600">Acme Analytics · Remote</p>
                <p className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">Medium confidence</p>
              </div>
            </div>
            <ul className="space-y-1.5">
              {reqs.map(([label, state]) => (
                <li key={label} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs">
                  <span className="truncate text-slate-700">{label}</span>
                  <span className={cx('shrink-0 rounded-full px-2 py-0.5 font-medium', state === 'met' && 'bg-emerald-100 text-emerald-800', state === 'partial' && 'bg-amber-100 text-amber-800', state === 'gap' && 'bg-rose-100 text-rose-800')}>
                    {state === 'met' ? 'Covered' : state === 'partial' ? 'Partly' : 'Gap'}
                  </span>
                </li>
              ))}
            </ul>
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-700"><Sparkles className="size-3.5" /> Suggested rewrite</p>
              <p className="mt-2 rounded-md bg-rose-50 px-2 py-1.5 text-xs text-rose-900 line-through decoration-rose-400">Built data pipelines for reporting.</p>
              <p className="mt-1.5 rounded-md bg-emerald-50 px-2 py-1.5 text-xs text-emerald-900">Built Airflow pipelines in Python and SQL that feed daily reporting for 40 teams.</p>
              <div className="mt-2.5 flex items-center justify-between">
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-800"><BadgeCheck className="size-3.5" /> Supported by your resume</span>
                <span className="flex gap-1.5">
                  <span className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700">Reject</span>
                  <span className="rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white">Accept</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </figure>
    </div>
  );
}

function ScoreRing({ value }: { value: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative size-16 shrink-0">
      <svg viewBox="0 0 64 64" className="size-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--color-slate-100)" strokeWidth="7" />
        <circle cx="32" cy="32" r={r} fill="none" stroke="url(#ring)" strokeWidth="7" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} />
        <defs>
          <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--color-indigo-500)" />
            <stop offset="1" stopColor="var(--color-violet-500)" />
          </linearGradient>
        </defs>
      </svg>
      <span className="absolute inset-0 grid place-items-center text-base font-bold text-slate-900">{value}%</span>
    </div>
  );
}

// ── Sections ──

function Section({ id, eyebrow, title, intro, children, tone = 'white' }: { id?: string; eyebrow: string; title: string; intro?: string; children: ReactNode; tone?: 'white' | 'muted' }) {
  return (
    <section id={id} className={cx('py-16 sm:py-24', tone === 'muted' && 'bg-slate-50')}>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold text-indigo-700">{eyebrow}</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
          {intro && <p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">{intro}</p>}
        </div>
        <div className="mt-12 sm:mt-14">{children}</div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { icon: FileText, title: 'Add your resume', body: 'Upload a PDF, Word or text file. It’s read and stored in the extension on your device, encrypted.' },
    { icon: MousePointerClick, title: 'Open a job posting', body: 'Press Alt+J or click the toolbar icon. The side panel reads the posting and shows how well your resume covers it.' },
    { icon: Download, title: 'Review and export', body: 'Accept or reject each suggested change, then download your tailored resume as PDF or Word.' },
  ];
  return (
    <Section eyebrow="How it works" title="From job posting to tailored resume in minutes" intro="Everything happens in a side panel next to the posting, so you never copy and paste between tabs.">
      <ol className="grid gap-6 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="relative rounded-2xl border border-slate-200 bg-white p-6 shadow-card">
            <div className="flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-xl bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100"><s.icon className="size-5" aria-hidden /></span>
              <span className="text-sm font-semibold text-slate-500">Step {i + 1}</span>
            </div>
            <h3 className="mt-5 text-lg font-semibold text-slate-900">{s.title}</h3>
            <p className="mt-2 text-[15px] leading-7 text-slate-600">{s.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Principles() {
  const items = [
    { icon: ShieldCheck, title: 'Your resume stays on your device', body: 'Parsing, scoring and exports run in your browser. When you ask for AI rewrites, we send a minimized copy with your name and contact details replaced by placeholders, and we do not store it.' },
    { icon: BadgeCheck, title: 'No made-up experience', body: 'Rewrites may only use facts already in your resume. Numbers, employers, skills and dates are checked; anything unsupported is dropped and shown to you.' },
    { icon: Gauge, title: 'An honest match estimate', body: 'The match score is our own estimate of how well your resume covers the posting, with a confidence level. It is not an ATS score — no one can see how a given employer’s system ranks you.' },
  ];
  return (
    <Section eyebrow="Built to be trusted" title="Better applications, without the risk" tone="muted">
      <div className="grid gap-6 md:grid-cols-3">
        {items.map((it) => (
          <div key={it.title} className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-200">
            <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-lift"><it.icon className="size-5" aria-hidden /></span>
            <h3 className="mt-5 text-lg font-semibold text-slate-900">{it.title}</h3>
            <p className="mt-2 text-[15px] leading-7 text-slate-600">{it.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── Pricing ──

/** Subscriptions and the free plan go in the main row; one-time and yearly add-ons below. */
const isAddOn = (p: PublicPlan) => !!p.price && (!p.price.interval || /year/.test(p.price.interval));

function Pricing({ plans, slow }: { plans: PublicPlan[] | null; slow: boolean }) {
  const main = (plans ?? []).filter((p) => !isAddOn(p));
  const addOns = (plans ?? []).filter(isAddOn);
  return (
    <Section id="pricing" eyebrow="Pricing" title="Simple plans that grow with your search" intro="Start free. Upgrade from inside the extension when you need more. Prices in USD.">
      {plans === null && (
        <>
          <div className="grid gap-6 md:grid-cols-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-80 animate-pulse rounded-2xl border border-slate-200 bg-slate-50" />
            ))}
          </div>
          <p role="status" className="mt-6 text-center text-sm text-slate-600">
            {slow ? 'Loading prices… the server is waking up after being idle, which can take up to a minute.' : 'Loading prices…'}
          </p>
        </>
      )}
      {plans?.length === 0 && (
        <p className="mx-auto flex max-w-md items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          Pricing is unavailable right now. Please reload the page in a minute.
        </p>
      )}
      {main.length > 0 && (
        <div className={cx('grid gap-6', main.length >= 3 ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
          {main.map((p) => <PlanCard key={p.plan_id} plan={p} />)}
        </div>
      )}
      {addOns.length > 0 && (
        <div className="mt-10">
          <h3 className="text-center text-sm font-semibold text-slate-700">Other ways to pay</h3>
          <div className="mx-auto mt-4 grid max-w-4xl gap-4 md:grid-cols-2">
            {addOns.map((p) => (
              <div key={p.plan_id} className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-card sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h4 className="font-semibold text-slate-900">{p.name}</h4>
                  <ul className="mt-2 space-y-1 text-sm text-slate-600">
                    {p.features.map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-indigo-600" aria-hidden />{f}</li>)}
                  </ul>
                </div>
                <p className="shrink-0 text-2xl font-bold tracking-tight text-slate-900 sm:text-right">
                  {`$${p.price!.amount}`}
                  {p.price!.interval && <span className="block text-sm font-normal text-slate-600">per {intervalLabel(p.price!.interval)}</span>}
                  {!p.price!.interval && <span className="block text-sm font-normal text-slate-600">one-time</span>}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="mt-10 text-center text-sm text-slate-600">
        Already subscribed? <Link to="/account" className="font-semibold text-indigo-700 underline-offset-4 hover:underline">Manage your account</Link>.
      </p>
    </Section>
  );
}

function PlanCard({ plan: p }: { plan: PublicPlan }) {
  const featured = !!p.badge;
  return (
    <div className={cx('relative flex flex-col rounded-2xl border bg-white p-6 sm:p-7', featured ? 'border-indigo-500 shadow-lift ring-1 ring-indigo-500' : 'border-slate-200 shadow-card')}>
      {p.badge && <span className="absolute -top-3 left-6 rounded-full bg-gradient-to-r from-indigo-600 to-violet-600 px-3 py-1 text-xs font-semibold text-white shadow-sm">{p.badge}</span>}
      <h3 className="text-lg font-semibold text-slate-900">{p.name}</h3>
      <p className="mt-4 flex items-baseline gap-1.5">
        <span className="text-4xl font-bold tracking-tight text-slate-900">{p.price ? `$${p.price.amount}` : 'Free'}</span>
        {p.price?.interval && <span className="text-sm text-slate-600">/ {intervalLabel(p.price.interval)}</span>}
      </p>
      <ul className="mt-6 space-y-3 text-[15px] text-slate-700">
        {p.features.map((f) => (
          <li key={f} className="flex gap-3">
            <Check className={cx('mt-0.5 size-5 shrink-0', featured ? 'text-indigo-600' : 'text-slate-500')} aria-hidden />
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The API sends "1 month", "3 month", "1 year": "month", "3 months", "year". */
function intervalLabel(i: string): string {
  const [n, unit] = i.split(' ');
  return n === '1' ? unit! : `${n} ${unit}s`;
}

// ── FAQ and closing ──

function Faq() {
  const qa: Array<[string, string]> = [
    ['Does my resume leave my device?', 'Your resume is parsed, scored and stored in the extension on your device, encrypted. When you use AI rewrites, only your experience, skills and summary are sent, with your name and contact details removed or replaced by placeholders. We don’t store your resume, job descriptions or rewritten resume on our servers unless you turn on “Help improve”, which is off by default.'],
    ['Will it make things up?', 'No. Rewrites may only use facts already in your resume. Numbers, employers, skills and dates are checked, anything unsupported is dropped and shown to you, and you accept or reject every change.'],
    ['Is the match score an ATS score?', 'No. It’s our own estimate of how well your resume covers the posting’s requirements, shown with a confidence level. No one can see how a given employer’s system ranks you.'],
    ['Can I cancel anytime?', 'Yes. Paid plans renew automatically until cancelled. Cancel from your account page and keep access until the end of the paid period. Payments are processed by Stripe; we never see your card.'],
    ['What does “Bring your own key” mean?', 'You use your own OpenAI or Anthropic API key. The text goes from your browser straight to your provider and never reaches our servers.'],
  ];
  return (
    <Section eyebrow="FAQ" title="Questions, answered" tone="muted">
      <div className="mx-auto max-w-3xl divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
        {qa.map(([q, a]) => (
          <details key={q} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-left text-[15px] font-semibold text-slate-900 hover:bg-slate-50 sm:px-6 [&::-webkit-details-marker]:hidden">
              {q}
              <ChevronDown className="size-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <p className="px-5 pb-5 text-[15px] leading-7 text-slate-600 sm:px-6">{a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

function FinalCta() {
  return (
    <section className="px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
      <div className="relative isolate mx-auto max-w-5xl overflow-hidden rounded-3xl bg-slate-900 px-6 py-14 text-center shadow-pop sm:px-12 sm:py-16">
        <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(40rem_20rem_at_20%_0%,rgb(99_102_241/0.45),transparent_60%),radial-gradient(35rem_20rem_at_90%_100%,rgb(192_38_211/0.35),transparent_60%)]" />
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Ready to tailor your next application?</h2>
        <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">Start with the free plan. Your resume never leaves your device unless you ask for AI rewrites.</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {STORE ? (
            <a href={STORE} className={buttonCls('inverse', 'lg')}>Add to Chrome — it’s free</a>
          ) : (
            <a href="#pricing" className={buttonCls('inverse', 'lg')}>Compare plans</a>
          )}
          <Link to="/account" className={buttonCls('outline-inverse', 'lg')}>Sign in to your account</Link>
        </div>
      </div>
    </section>
  );
}
