import { useEffect, useState } from 'react';
import { plans as fetchPlans, type PublicPlan } from '../api';
import { Link } from '../App';

const STORE = import.meta.env.VITE_CHROME_STORE_URL;

export function HomePage() {
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  useEffect(() => {
    fetchPlans().then((r) => setPlans(r.plans)).catch(() => setPlans([]));
    if (location.hash === '#pricing') setTimeout(() => document.getElementById('pricing')?.scrollIntoView(), 50);
  }, []);
  return (
    <>
      <section className="mx-auto max-w-5xl px-4 py-16">
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight">Tailor your resume to the job in front of you — without inventing anything.</h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600">
          A Chrome extension that reads the job posting, compares it with your resume, and suggests rewrites you can accept or reject. Every suggestion is checked against what your resume already says.
        </p>
        <div className="mt-6 flex gap-3">
          {STORE ? (
            <a href={STORE} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Add to Chrome</a>
          ) : (
            <span className="rounded-md bg-slate-100 px-4 py-2 text-sm text-slate-600">Chrome Web Store listing coming soon</span>
          )}
          <a href="#pricing" className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium">See pricing</a>
        </div>
      </section>

      <section className="bg-slate-50 py-12">
        <div className="mx-auto grid max-w-5xl gap-6 px-4 md:grid-cols-3">
          {[
            ['Your resume stays on your device', 'Parsing, scoring and exports run in your browser. When you ask for AI rewrites, we send a minimized copy with your name and contact details replaced by placeholders, and we do not store it.'],
            ['No made-up experience', 'Rewrites may only use facts already in your resume. Numbers, employers, skills and dates are checked; anything unsupported is dropped and shown to you.'],
            ['An honest match estimate', 'The match score is our own estimate of how well your resume covers the posting, with a confidence level. It is not an ATS score — no one can see how a given employer’s system ranks you.'],
          ].map(([t, d]) => (
            <div key={t} className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="font-semibold">{t}</h2>
              <p className="mt-2 text-sm text-slate-600">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-5xl px-4 py-14">
        <h2 className="text-2xl font-bold">Pricing</h2>
        <p className="mt-1 text-sm text-slate-600">Upgrade from inside the extension. Prices in USD.</p>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {(plans ?? []).map((p) => (
            <div key={p.plan_id} className={`rounded-lg border p-5 ${p.badge ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-slate-200'}`}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{p.name}</h3>
                {p.badge && <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">{p.badge}</span>}
              </div>
              <p className="mt-2 text-2xl font-bold">
                {p.price ? `$${p.price.amount}` : 'Free'}
                {p.price?.interval && <span className="text-sm font-normal text-slate-500"> / {intervalLabel(p.price.interval)}</span>}
              </p>
              <ul className="mt-3 space-y-1 text-sm text-slate-600">
                {p.features.map((f) => <li key={f}>• {f}</li>)}
              </ul>
            </div>
          ))}
          {plans?.length === 0 && <p className="text-sm text-slate-500">Pricing is unavailable right now.</p>}
        </div>
        <p className="mt-6 text-sm text-slate-600">Already subscribed? <Link to="/account" className="text-indigo-700 underline">Manage your account</Link>.</p>
      </section>
    </>
  );
}

/** "1 month" → "month", "3 month" → "3 months". */
function intervalLabel(i: string): string {
  const [n, unit] = i.split(' ');
  return n === '1' ? unit! : `${n} ${unit}s`;
}
