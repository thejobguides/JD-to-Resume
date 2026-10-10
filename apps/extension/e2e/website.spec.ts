import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { API, WEB } from './global-setup';

// The website through its UI (production build, under its Content Security Policy): home and pricing from the
// API, legal pages, every checkout state including a test payment, and the account page — code sign-in, plan and
// usage, test cancellation, the saved-content opt-in, data download, sign-out and account deletion.

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function apiLogin(email: string): Promise<string> {
  const r = (await (await fetch(`${API}/v1/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json()) as { dev_code: string };
  const t = (await (await fetch(`${API}/v1/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: r.dev_code }) })).json()) as { access_token: string };
  return t.access_token;
}
async function api<T>(token: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return (r.status === 204 ? undefined : await r.json()) as T;
}
const checkoutUrl = async (token: string, plan: string, key: string) => (await api<{ checkout_url: string; transaction_id: string }>(token, 'POST', '/v1/billing/checkout', { plan_id: plan }, { 'idempotency-key': key }));

async function signIn(page: Page, email: string) {
  await page.goto(`${WEB}/account`);
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  const hint = await page.getByText(/your code is \d{6}/).textContent();
  await page.getByPlaceholder('6-digit code').fill(hint!.match(/\d{6}/)![0]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
}

test('home, pricing, legal pages and not-found render under the Content Security Policy', async ({ page }) => {
  const errors = watch(page);
  await page.goto(WEB);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Tailor your resume');
  await expect(page.getByText('$19.00')).toBeVisible();
  await expect(page.getByText('$45.00')).toBeVisible();
  await expect(page.getByText('$12.00')).toBeVisible();
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain(`connect-src 'self' ${API}`);

  await page.getByRole('link', { name: 'Privacy' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  await expect(page.getByText(/Saved content, only if you opt in/)).toBeVisible();
  await expect(page.getByText(/Stripe, our payment processor/)).toBeVisible();
  await page.goto(`${WEB}/terms`);
  await expect(page.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeVisible();
  await page.goto(`${WEB}/no-such-page`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('checkout: nothing to pay, cancelled, real sessions are not handled here, and a test payment upgrades the plan once', async ({ page }) => {
  const errors = watch(page);
  await page.goto(`${WEB}/checkout`);
  await expect(page.getByRole('heading', { name: 'Nothing to pay for' })).toBeVisible();
  await page.goto(`${WEB}/checkout?cancelled=1`);
  await expect(page.getByRole('heading', { name: 'Checkout cancelled' })).toBeVisible();
  await expect(page.getByText('No payment was taken.')).toBeVisible();
  await page.goto(`${WEB}/checkout?session=cs_test_a1b2c3`);
  await expect(page.getByRole('heading', { name: 'Nothing to pay for' })).toBeVisible();

  const token = await apiLogin('web.buyer@example.org');
  const co = await checkoutUrl(token, 'pro_monthly', 'web-buyer-checkout-1');
  expect(co.checkout_url).toBe(`${WEB}/checkout?session=${co.transaction_id}`);
  await page.goto(co.checkout_url);
  await expect(page.getByRole('heading', { name: 'Test checkout' })).toBeVisible();
  await page.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(page.getByRole('heading', { name: /Payment received/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View your account' })).toBeVisible();
  expect((await api<{ plan: string }>(token, 'GET', '/v1/me')).plan).toBe('pro_monthly');

  // The same test checkout can't be completed twice.
  await page.goto(co.checkout_url);
  await page.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(page.getByText('Unknown test checkout.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('account: plan and usage, test cancel and resume, saved-content opt-in, data download, sign out, delete', async ({ page }) => {
  const errors = watch(page);
  const email = 'web.account@example.org';
  const token = await apiLogin(email);
  const co = await checkoutUrl(token, 'pro_quarterly', 'web-account-checkout-1');
  expect((await fetch(`${API}/v1/dev/fake-checkout/${co.transaction_id}/complete`, { method: 'POST' })).status).toBe(200);

  await signIn(page, email);
  await expect(page.getByText('Pro (quarterly)')).toBeVisible();
  await expect(page.getByText(/Status: active\. Renews on/)).toBeVisible();
  await expect(page.getByText('Optimizations this period')).toBeVisible();
  await expect(page.getByText(/Local test payments/)).toBeVisible();

  await page.getByRole('button', { name: 'Cancel at period end (test)' }).click();
  await expect(page.getByText(/Cancelled — you keep access until/)).toBeVisible();
  await page.getByRole('button', { name: 'Resume subscription (test)' }).click();
  await expect(page.getByText(/Renews on/)).toBeVisible();

  const optIn = page.getByRole('checkbox', { name: /Help improve Job Match Optimizer/ });
  await expect(optIn).not.toBeChecked();
  await optIn.click(); // the box follows the server: it turns on once the setting is saved
  await expect(optIn).toBeChecked();
  await expect.poll(async () => (await api<{ settings: { content_opt_in: boolean } }>(token, 'GET', '/v1/me')).settings.content_opt_in).toBe(true);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my account data' }).click()]);
  expect(download.suggestedFilename()).toBe('job-match-optimizer-account.json');
  const data = JSON.parse(readFileSync((await download.path())!, 'utf8')) as { user: { email: string; content_opt_in: boolean }; subscription: { plan_id: string }; saved_content: unknown[] };
  expect(data.user).toMatchObject({ email, content_opt_in: true });
  expect(data.subscription.plan_id).toBe('pro_quarterly');
  expect(data.saved_content).toEqual([]);

  await optIn.click();
  await expect(optIn).not.toBeChecked();
  await expect.poll(async () => (await api<{ settings: { content_opt_in: boolean } }>(token, 'GET', '/v1/me')).settings.content_opt_in).toBe(false);

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();

  await signIn(page, email);
  await page.getByRole('button', { name: 'Delete my account…' }).click();
  await expect(page.getByText(/Your active subscription is cancelled too/)).toBeVisible();
  const del = page.getByRole('button', { name: 'Delete account' });
  await expect(del).toBeDisabled();
  await page.getByPlaceholder('Type DELETE to confirm').fill('DELETE');
  await del.click();
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
  expect((await fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  expect(errors).toEqual([]);
});
