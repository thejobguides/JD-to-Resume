import { cx, LogoMark } from '@jmo/ui';
import { Activity, CreditCard, Database, KeyRound, LayoutDashboard, LogOut, Menu, ScrollText, Settings, SlidersHorizontal, TicketPercent, Users, Workflow, X } from 'lucide-react';
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

interface Section {
  path: string;
  label: string;
  description: string;
  group: 'Business' | 'AI' | 'System' | null;
  icon: ComponentType<{ className?: string }>;
  perm: string;
  el: (me: Me) => ReactNode;
}

const NAV: Section[] = [
  { path: 'overview', label: 'Overview', description: 'Users, revenue and AI health at a glance.', group: null, icon: LayoutDashboard, perm: 'dashboards.view', el: () => <OverviewPage /> },
  { path: 'users', label: 'Users & support', description: 'Find a user, check their plan and grant credits.', group: 'Business', icon: Users, perm: 'users.view', el: (me) => <UsersPage me={me} /> },
  { path: 'coupons', label: 'Coupons', description: 'Campaigns, codes and their redemptions.', group: 'Business', icon: TicketPercent, perm: 'coupons.view', el: (me) => <CouponsPage me={me} /> },
  { path: 'plans', label: 'Plans & pricing', description: 'Plan prices and their Stripe IDs.', group: 'Business', icon: CreditCard, perm: 'dashboards.view', el: (me) => <PlansPage me={me} /> },
  { path: 'usage', label: 'AI usage & cost', description: 'Spend, latency and what to optimize.', group: 'AI', icon: Activity, perm: 'dashboards.view', el: (me) => <UsagePage me={me} /> },
  { path: 'ai', label: 'AI providers & keys', description: 'Providers, models and encrypted credentials.', group: 'AI', icon: KeyRound, perm: 'dashboards.view', el: (me) => <AiPage me={me} /> },
  { path: 'routing', label: 'Model per step', description: 'Which model runs each pipeline step.', group: 'AI', icon: Workflow, perm: 'dashboards.view', el: (me) => <RoutingPage me={me} /> },
  { path: 'config', label: 'Runtime config', description: 'Limits, kill switches and announcements.', group: 'System', icon: SlidersHorizontal, perm: 'dashboards.view', el: (me) => <ConfigPage me={me} /> },
  { path: 'content', label: 'Saved content', description: 'Opted-in users’ saved items, behind a fresh sign-in.', group: 'System', icon: Database, perm: 'content.stats', el: (me) => <ContentPage me={me} /> },
  { path: 'audit', label: 'Audit log', description: 'Every admin action, hash-chained.', group: 'System', icon: ScrollText, perm: 'audit.view', el: () => <AuditPage /> },
  { path: 'more', label: 'Admins, privacy, system', description: 'Admin members, data policy and system status.', group: 'System', icon: Settings, perm: 'dashboards.view', el: (me) => <MorePage me={me} /> },
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
  const [menuOpen, setMenuOpen] = useState(false);
  const hash = useHash();
  useEffect(() => onSession(() => setS(getSession())), []);
  useEffect(() => {
    if (!session) {
      setMe(null);
      return;
    }
    get<Me>('/me').then(setMe).catch(() => setSession(null));
  }, [session]);
  useEffect(() => setMenuOpen(false), [hash]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  if (!session) return <LoginPage />;
  if (!me)
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50">
        <p role="status" className="flex items-center gap-3 text-sm text-slate-600"><LogoMark className="size-8 animate-pulse" />Loading…</p>
      </div>
    );
  const [section] = hash.split('/');
  const allowed = NAV.filter((n) => me.permissions.includes(n.perm));
  const current = NAV.find((n) => n.path === section) ?? NAV[0]!;
  document.title = `${current.label} · JMO Admin`;
  const groups = [null, 'Business', 'AI', 'System'] as const;

  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      {/* Phones and tablets: a top bar; the sidebar slides in over the page. */}
      <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:hidden">
        <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100" aria-expanded={menuOpen} aria-controls="admin-sidebar" aria-label={menuOpen ? 'Close menu' : 'Open menu'} onClick={() => setMenuOpen((o) => !o)}>
          <Menu className="size-5" aria-hidden />
        </button>
        <LogoMark className="size-7" />
        <span className="truncate text-sm font-semibold text-slate-900">{current.label}</span>
      </div>
      {menuOpen && <div aria-hidden className="fixed inset-0 z-40 animate-fade-in bg-slate-900/40 backdrop-blur-sm lg:hidden" onClick={() => setMenuOpen(false)} />}

      <aside
        id="admin-sidebar"
        className={cx(
          'fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:w-64 lg:translate-x-0',
          menuOpen ? 'translate-x-0 shadow-pop' : 'max-lg:invisible -translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between gap-2 border-b border-slate-100 px-4">
          <a href="#/overview" className="flex min-w-0 items-center gap-2.5 rounded-lg">
            <LogoMark className="size-8 shrink-0" />
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold text-slate-900">Job Match Optimizer</span>
              <span className="block text-xs text-slate-500">Admin console</span>
            </span>
          </a>
          <button type="button" className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 lg:hidden" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <X className="size-5" aria-hidden />
          </button>
        </div>
        <nav aria-label="Admin sections" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {groups.map((g) => {
            const items = allowed.filter((n) => n.group === g);
            if (!items.length) return null;
            return (
              <div key={g ?? 'main'}>
                {g && <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{g}</p>}
                <div className="space-y-0.5">
                  {items.map((n) => {
                    const active = n.path === current.path;
                    return (
                      <a key={n.path} href={`#/${n.path}`} aria-current={active ? 'page' : undefined} className={cx('group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-indigo-600', active ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900')}>
                        <n.icon className={cx('size-[18px] shrink-0', active ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600')} aria-hidden />
                        {n.label}
                      </a>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <div className="flex items-center gap-3 rounded-xl bg-slate-50 p-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-indigo-600 to-violet-600 text-sm font-semibold uppercase text-white">{me.email.slice(0, 1)}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-900">{me.email}</p>
              <p className="text-xs capitalize text-slate-500">{me.role}</p>
            </div>
            <button type="button" className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 hover:bg-white hover:text-slate-900" title="Sign out" aria-label="Sign out" onClick={() => setSession(null)}>
              <LogOut className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <header className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{current.label}</h1>
            <p className="mt-1 text-sm text-slate-600">{current.description}</p>
          </header>
          <Suspense fallback={<PageSkeleton />}>{current.el(me)}</Suspense>
        </div>
      </main>
      <StepUpHost />
      <ReasonHost />
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <p role="status" className="sr-only">Loading…</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl border border-slate-200 bg-white" />)}
      </div>
      <div className="h-64 animate-pulse rounded-xl border border-slate-200 bg-white" />
    </div>
  );
}
