import { useState } from 'react';
import { API } from '../api';
import { Button, ErrorText, Link, navigate } from '../App';

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
      <Shell title="Checkout cancelled">
        <p className="text-sm text-slate-600">No payment was taken. You can start again from the extension’s “Upgrade” screen whenever you like.</p>
      </Shell>
    );
  }
  if (!session || !fake) {
    return (
      <Shell title="Nothing to pay for">
        <p className="text-sm text-slate-600">Start an upgrade from the extension; it takes you to the secure payment page.</p>
      </Shell>
    );
  }
  return (
    <Shell title="Test checkout">
      <p className="text-sm text-slate-600">
        This is the local fake payment provider. No card is charged. Completing it sends the same signed webhooks Stripe would, so your plan and any coupon update exactly as in production.
      </p>
      <p className="mt-2 font-mono text-xs text-slate-500">{session}</p>
      <ErrorText error={error} />
      <div className="mt-4">
        <Button
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
          Complete test payment
        </Button>
      </div>
    </Shell>
  );
}

export function CheckoutSuccessPage() {
  return (
    <Shell title="Payment received — thank you">
      <p className="text-sm text-slate-600">Your plan updates within a few seconds. Go back to the extension; it refreshes your plan automatically. You can close this tab.</p>
      <p className="mt-4 text-sm"><Link to="/account" className="text-indigo-700 underline">View your account</Link></p>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <h1 className="mb-3 text-2xl font-semibold">{title}</h1>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
