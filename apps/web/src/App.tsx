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

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={to}
      className={className}
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

export function App() {
  const path = usePath();
  const page = ROUTES[path];
  // Each page has its own title (browser tabs, history, screen readers announce it on navigation).
  useEffect(() => {
    document.title = TITLES[path] ?? 'Page not found · Job Match Optimizer';
  }, [path]);
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow">Skip to content</a>
      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="font-semibold">Job Match Optimizer</Link>
          <nav aria-label="Main" className="flex gap-4 text-sm text-slate-600">
            <Link to="/#pricing">Pricing</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/account">Account</Link>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">{page ? page() : <NotFound />}</main>
      <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-500">
        <Link to="/privacy">Privacy</Link> · <Link to="/terms">Terms</Link> · Payments are processed securely by Stripe.
      </footer>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600"><Link to="/" className="text-indigo-700 underline">Go home</Link></p>
    </div>
  );
}

export function Button({ children, onClick, disabled, kind = 'primary', type = 'button' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'danger'; type?: 'button' | 'submit' }) {
  const cls = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700',
    secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
    danger: 'bg-rose-600 text-white hover:bg-rose-700',
  }[kind];
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={`rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${cls}`}>
      {children}
    </button>
  );
}

export const inputCls = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200';

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="rounded-md bg-rose-50 p-2 text-sm text-rose-700">{error instanceof Error ? error.message : String(error)}</p>;
}
