import { LogoMark } from '@jmo/ui';
import { ArrowLeft, Menu, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { AccountPage } from './pages/Account';
import { CheckoutPage, CheckoutSuccessPage } from './pages/Checkout';
import { HomePage } from './pages/Home';
import { PrivacyPage, TermsPage } from './pages/Legal';

// Tiny path router: the site has five pages and no nested routes.

export function navigate(to: string) {
  history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** After a route change: scroll to the #fragment if there is one (e.g. /#pricing), else to the top. */
function scrollForLocation() {
  const id = decodeURIComponent(location.hash.slice(1));
  requestAnimationFrame(() => {
    const el = id ? document.getElementById(id) : null;
    if (el) el.scrollIntoView();
    else window.scrollTo(0, 0);
  });
}

export function Link({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; 'aria-current'?: 'page' }) {
  return (
    <a
      href={to}
      className={className}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function usePath() {
  const [p, setP] = useState(location.pathname);
  useEffect(() => {
    const f = () => {
      setP(location.pathname);
      scrollForLocation();
    };
    window.addEventListener('popstate', f);
    if (location.hash) scrollForLocation(); // deep link straight to a section
    return () => window.removeEventListener('popstate', f);
  }, []);
  return p.replace(/\/+$/, '') || '/';
}

const TITLES: Record<string, string> = {
  '/': 'Job Match Optimizer — tailor your resume without inventing anything',
  '/checkout': 'Checkout · Job Match Optimizer',
  '/checkout/success': 'Payment received · Job Match Optimizer',
  '/account': 'Your account · Job Match Optimizer',
  '/account/billing': 'Your account · Job Match Optimizer',
  '/privacy': 'Privacy · Job Match Optimizer',
  '/terms': 'Terms of use · Job Match Optimizer',
};

const ROUTES: Record<string, () => ReactNode> = {
  '/': () => <HomePage />,
  '/checkout': () => <CheckoutPage />,
  '/checkout/success': () => <CheckoutSuccessPage />,
  '/account': () => <AccountPage />,
  '/account/billing': () => <AccountPage />,
  '/privacy': () => <PrivacyPage />,
  '/terms': () => <TermsPage />,
};

const NAV = [
  { to: '/#pricing', label: 'Pricing', match: () => false },
  { to: '/privacy', label: 'Privacy', match: (p: string) => p === '/privacy' },
  { to: '/account', label: 'Account', match: (p: string) => p.startsWith('/account') },
];

export function App() {
  const path = usePath();
  const page = ROUTES[path];
  const [menuOpen, setMenuOpen] = useState(false);
  // Each page has its own title (browser tabs, history, screen readers announce it on navigation).
  useEffect(() => {
    document.title = TITLES[path] ?? 'Page not found · Job Match Optimizer';
    setMenuOpen(false);
  }, [path]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-pop">Skip to content</a>
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur-lg supports-[backdrop-filter]:bg-white/70">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-2.5 rounded-lg font-semibold tracking-tight">
            <LogoMark className="size-8" />
            <span className="text-[15px]">Job Match Optimizer</span>
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} aria-current={n.match(path) ? 'page' : undefined} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 aria-[current=page]:text-indigo-700">
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <span className="hidden sm:block"><ButtonLink to="/#pricing" size="sm">See plans</ButtonLink></span>
            <button
              type="button"
              className="inline-flex size-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav id="mobile-menu" aria-label="Mobile" className="animate-fade-in border-t border-slate-200 bg-white px-4 pb-4 pt-2 md:hidden">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} aria-current={n.match(path) ? 'page' : undefined} className="block rounded-lg px-3 py-3 text-base font-medium text-slate-700 hover:bg-slate-50 aria-[current=page]:text-indigo-700">
                {n.label}
              </Link>
            ))}
            <ButtonLink to="/#pricing" className="mt-2 w-full">See plans</ButtonLink>
          </nav>
        )}
      </header>
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">{page ? page() : <NotFound />}</main>
      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[2fr_1fr_1fr] lg:px-8">
        <div className="max-w-sm">
          <div className="flex items-center gap-2.5 font-semibold tracking-tight">
            <LogoMark className="size-7" />
            Job Match Optimizer
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">Tailor your resume to each job posting with suggestions grounded in what you’ve actually done. Your resume stays on your device.</p>
        </div>
        <FooterColumn title="Product" links={[['/#pricing', 'Pricing'], ['/account', 'Your account']]} />
        <FooterColumn title="Legal" links={[['/privacy', 'Privacy'], ['/terms', 'Terms']]} />
      </div>
      <div className="border-t border-slate-200">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-slate-600 sm:px-6 lg:px-8">© {new Date().getFullYear()} Job Match Optimizer · Payments are processed securely by Stripe.</p>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: Array<[string, string]> }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <ul className="mt-3 space-y-2">
        {links.map(([to, label]) => (
          <li key={to}>
            <Link to={to} className="text-sm text-slate-600 hover:text-indigo-700">{label}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center">
      <p className="text-sm font-semibold text-indigo-700">404</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Page not found</h1>
      <p className="mt-3 text-slate-600">The page you’re looking for doesn’t exist or has moved.</p>
      <ButtonLink to="/" kind="secondary" className="mt-8">
        <ArrowLeft className="size-4" aria-hidden />
        Go home
      </ButtonLink>
    </div>
  );
}

// ── Shared controls ──

type Kind = 'primary' | 'secondary' | 'danger' | 'ghost' | 'inverse' | 'outline-inverse';
type Size = 'sm' | 'md' | 'lg';

const KIND: Record<Kind, string> = {
  primary: 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 active:bg-indigo-800 focus-visible:outline-indigo-600',
  secondary: 'border border-slate-300 bg-white text-slate-800 shadow-sm hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-indigo-600',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-700 focus-visible:outline-rose-600',
  ghost: 'text-indigo-700 hover:bg-indigo-50 focus-visible:outline-indigo-600',
  // On dark backgrounds.
  inverse: 'bg-white text-slate-900 shadow-sm hover:bg-slate-100 focus-visible:outline-white',
  'outline-inverse': 'text-white ring-1 ring-inset ring-white/30 hover:bg-white/10 focus-visible:outline-white',
};
const SIZE: Record<Size, string> = { sm: 'h-9 px-3.5 text-sm', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-base' };

export const buttonCls = (kind: Kind = 'primary', size: Size = 'md', extra = '') =>
  `inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 ${SIZE[size]} ${KIND[kind]} ${extra}`;

export function Button({ children, onClick, disabled, kind = 'primary', size = 'md', type = 'button', className = '' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: Kind; size?: Size; type?: 'button' | 'submit'; className?: string }) {
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={buttonCls(kind, size, className)}>
      {children}
    </button>
  );
}

export function ButtonLink({ to, children, kind = 'primary', size = 'md', className = '' }: { to: string; children: ReactNode; kind?: Kind; size?: Size; className?: string }) {
  return (
    <Link to={to} className={buttonCls(kind, size, className)}>
      {children}
    </Link>
  );
}

export const inputCls = 'block h-11 w-full rounded-lg border border-slate-300 bg-white px-3.5 text-[15px] text-slate-900 shadow-sm placeholder:text-slate-500 transition focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-600';

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">{error instanceof Error ? error.message : String(error)}</p>;
}
