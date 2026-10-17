import { CircleCheck, CircleX, CreditCard, Info, Lock } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { API } from '../api';
import { Button, ButtonLink, ErrorText, navigate } from '../App';

// The extension creates a Stripe Checkout Session (with the coupon already applied by id) and opens Stripe's hosted
// payment page directly, so card data never touches our code. Stripe sends the customer back to /checkout/success,
// or to /checkout?cancelled=1 if they leave. With the fake gateway (local development) the extension opens this page
// with ?session=cs_fake_… and we simulate the payment instead.

export function CheckoutPage() {
  const params = new URLSearchParams(location.search);
  const session = params.get('session');
  const fake = session?.startsWith('cs_fake_') ?? false;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (params.get('cancelled')) {
    return (
      <Shell title="Checkout cancelled" icon={<CircleX className="size-7" aria-hidden />} tone="muted">
        <p>No payment was taken. You can start again from the extension’s “Upgrade” screen whenever you like.</p>
      </Shell>
    );
  }
  if (!session || !fake) {
    return (
      <Shell title="Nothing to pay for" icon={<Info className="size-7" aria-hidden />} tone="muted">
        <p>Start an upgrade from the extension; it takes you to the secure payment page.</p>
      </Shell>
    );
  }
  return (
    <Shell title="Test checkout" icon={<CreditCard className="size-7" aria-hidden />}>
      <p>
        This is the local fake payment provider. No card is charged. Completing it sends the same signed webhooks Stripe would, so your plan and any coupon update exactly as in production.
      </p>
      <p className="break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">{session}</p>
      <ErrorText error={error} />
      <div className="pt-2">
        <Button
          size="lg"
          className="w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await fetch(`${API}/v1/dev/fake-checkout/${encodeURIComponent(session)}/complete`, { method: 'POST' });
              if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? `Failed (${r.status})`);
              navigate('/checkout/success');
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Lock className="size-4" aria-hidden />
          Complete test payment
        </Button>
      </div>
    </Shell>
  );
}

export function CheckoutSuccessPage() {
  return (
    <Shell title="Payment received — thank you" icon={<CircleCheck className="size-7" aria-hidden />} tone="success">
      <p>Your plan updates within a few seconds. Go back to the extension; it refreshes your plan automatically. You can close this tab.</p>
      <div className="pt-3"><ButtonLink to="/account" kind="secondary">View your account</ButtonLink></div>
    </Shell>
  );
}

const TONES = { brand: 'bg-indigo-50 text-indigo-700 ring-indigo-100', success: 'bg-emerald-50 text-emerald-700 ring-emerald-100', muted: 'bg-slate-100 text-slate-600 ring-slate-200' };

function Shell({ title, icon, tone = 'brand', children }: { title: string; icon: ReactNode; tone?: keyof typeof TONES; children: ReactNode }) {
  return (
    <div className="bg-gradient-to-b from-slate-50 to-white px-4 py-14 sm:py-20">
      <div className="mx-auto max-w-lg animate-fade-up rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-card sm:p-10">
        <span className={`mx-auto grid size-14 place-items-center rounded-2xl ring-1 ${TONES[tone]}`}>{icon}</span>
        <h1 className="mt-5 text-2xl font-bold tracking-tight">{title}</h1>
        <div className="mt-3 space-y-3 text-[15px] leading-7 [&_p]:text-slate-600">{children}</div>
      </div>
    </div>
  );
}
