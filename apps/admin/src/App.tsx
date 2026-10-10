import { type ComponentType, lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { get, getSession, onSession, setSession } from './api';
import { StepUpHost } from './components/StepUp';
import { ReasonHost } from './components/ui';
import { LoginPage } from './pages/Login';

// Route-level code splitting: each page (and heavy dependencies such as the charts on AI usage) loads on first visit,
// so signing in doesn't download the whole panel.
const page = <P,>(load: () => Promise<Record<string, ComponentType<P>>>, name: string) => lazy(async () => ({ default: (await load())[name]! }));
const OverviewPage = page(() => import('./pages/Overview'), 'OverviewPage');
const UsagePage = page<{ me: Me }>(() => import('./pages/Usage'), 'UsagePage');
const UsersPage = page<{ me: Me }>(() => import('./pages/Users'), 'UsersPage');
const CouponsPage = page<{ me: Me }>(() => import('./pages/Coupons'), 'CouponsPage');
const PlansPage = page<{ me: Me }>(() => import('./pages/Plans'), 'PlansPage');
const AiPage = page<{ me: Me }>(() => import('./pages/Ai'), 'AiPage');
const RoutingPage = page<{ me: Me }>(() => import('./pages/Routing'), 'RoutingPage');
const ConfigPage = page<{ me: Me }>(() => import('./pages/Config'), 'ConfigPage');
const ContentPage = page<{ me: Me }>(() => import('./pages/Content'), 'ContentPage');
const AuditPage = page(() => import('./pages/Audit'), 'AuditPage');
const MorePage = page<{ me: Me }>(() => import('./pages/More'), 'MorePage');

export interface Me {
  id: string;
  email: string;
  role: string;
  permissions: string[];
  step_up_valid_until: string | null;
}

const NAV: Array<{ path: string; label: string; perm: string; el: (me: Me) => ReactNode }> = [
  { path: 'overview', label: 'Overview', perm: 'dashboards.view', el: () => <OverviewPage /> },
  { path: 'usage', label: 'AI usage & cost', perm: 'dashboards.view', el: (me) => <UsagePage me={me} /> },
  { path: 'users', label: 'Users & support', perm: 'users.view', el: (me) => <UsersPage me={me} /> },
  { path: 'coupons', label: 'Coupons', perm: 'coupons.view', el: (me) => <CouponsPage me={me} /> },
  { path: 'plans', label: 'Plans & pricing', perm: 'dashboards.view', el: (me) => <PlansPage me={me} /> },
  { path: 'ai', label: 'AI providers & keys', perm: 'dashboards.view', el: (me) => <AiPage me={me} /> },
  { path: 'routing', label: 'Model per step', perm: 'dashboards.view', el: (me) => <RoutingPage me={me} /> },
  { path: 'config', label: 'Runtime config', perm: 'dashboards.view', el: (me) => <ConfigPage me={me} /> },
  { path: 'content', label: 'Saved content', perm: 'content.stats', el: (me) => <ContentPage me={me} /> },
  { path: 'audit', label: 'Audit log', perm: 'audit.view', el: () => <AuditPage /> },
  { path: 'more', label: 'Admins, privacy, system', perm: 'dashboards.view', el: (me) => <MorePage me={me} /> },
];

function useHash(): string {
  const [h, setH] = useState(() => location.hash.slice(2) || 'overview');
  useEffect(() => {
    const f = () => setH(location.hash.slice(2) || 'overview');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
}

export function App() {
  const [session, setS] = useState(getSession());
  const [me, setMe] = useState<Me | null>(null);
  const hash = useHash();
  useEffect(() => onSession(() => setS(getSession())), []);
  useEffect(() => {
    if (!session) {
      setMe(null);
      return;
    }
    get<Me>('/me').then(setMe).catch(() => setSession(null));
  }, [session]);

  if (!session) return <LoginPage />;
  if (!me) return <p className="p-8 text-sm text-slate-500">Loading…</p>;
  const [section] = hash.split('/');
  const current = NAV.find((n) => n.path === section) ?? NAV[0]!;
  document.title = `${current.label} · JMO Admin`;
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r border-slate-200 bg-white p-3">
        <div className="mb-4 px-2">
          <div className="text-sm font-bold">Job Match Optimizer</div>
          <div className="text-xs text-slate-500">Admin · {me.role}</div>
        </div>
        <nav aria-label="Admin sections" className="space-y-0.5">
          {NAV.filter((n) => me.permissions.includes(n.perm)).map((n) => (
            <a key={n.path} href={`#/${n.path}`} aria-current={n.path === current.path ? 'page' : undefined} className={`block rounded px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 ${n.path === current.path ? 'bg-indigo-50 font-medium text-indigo-700' : 'text-slate-700 hover:bg-slate-100'}`}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="mt-6 border-t border-slate-200 px-2 pt-3 text-xs text-slate-500">
          <div className="truncate">{me.email}</div>
          <button className="mt-1 text-indigo-700" onClick={() => setSession(null)}>Sign out</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        <h1 className="mb-4 text-lg font-semibold">{current.label}</h1>
        <Suspense fallback={<p role="status" className="text-sm text-slate-600">Loading…</p>}>{current.el(me)}</Suspense>
      </main>
      <StepUpHost />
      <ReasonHost />
    </div>
  );
}
