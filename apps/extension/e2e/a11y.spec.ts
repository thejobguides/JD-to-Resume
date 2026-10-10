import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { ADMIN, API, ROOT, SITE, WEB } from './global-setup';
import { launchExtension } from './launch';

// Automated accessibility (axe-core, WCAG 2.1 A/AA) on every screen of the three UIs: the website, the admin panel
// and the extension (settings tabs and each side-panel step). Any violation fails with the rule, impact and nodes.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const found = r.violations.map((v) => `${name} · ${v.id} (${v.impact}) ×${v.nodes.length}: ${v.help} — e.g. ${v.nodes[0]?.target.join(' ')}`);
  return found;
}

async function apiLogin(email: string) {
  const r = (await (await fetch(`${API}/v1/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json()) as { dev_code: string };
  return ((await (await fetch(`${API}/v1/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: r.dev_code }) })).json()) as { access_token: string }).access_token;
}

test('website: every page meets WCAG 2.1 AA', async ({ page }) => {
  const all: string[] = [];
  for (const [path, name] of [['/', 'home'], ['/privacy', 'privacy'], ['/terms', 'terms'], ['/checkout', 'checkout'], ['/checkout?cancelled=1', 'checkout-cancelled'], ['/checkout/success', 'checkout-success'], ['/nope', 'not-found'], ['/account', 'account-sign-in']] as const) {
    await page.goto(`${WEB}${path}`);
    all.push(...(await scan(page, name)));
  }
  // Signed in, with a subscription (fake mode controls visible).
  const email = 'a11y.web@example.org';
  const token = await apiLogin(email);
  const co = (await (await fetch(`${API}/v1/billing/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': 'a11y-web-checkout' }, body: JSON.stringify({ plan_id: 'pro_monthly' }) })).json()) as { checkout_url: string; transaction_id: string };
  await page.goto(co.checkout_url);
  all.push(...(await scan(page, 'checkout-test')));
  await fetch(`${API}/v1/dev/fake-checkout/${co.transaction_id}/complete`, { method: 'POST' });
  await page.goto(`${WEB}/account`);
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByPlaceholder('6-digit code').fill((await page.getByText(/your code is \d{6}/).textContent())!.match(/\d{6}/)![0]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Pro (monthly)')).toBeVisible();
  all.push(...(await scan(page, 'account')));
  await page.getByRole('button', { name: 'Delete my account…' }).click();
  all.push(...(await scan(page, 'account-delete-confirm')));
  expect(all, all.join('\n')).toEqual([]);
});

test('admin panel: sign-in and every page meet WCAG 2.1 AA', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const all: string[] = [];
  await page.goto(ADMIN);
  await page.getByLabel('Email').fill('owner@example.com');
  all.push(...(await scan(page, 'admin-login')));
  await page.getByRole('button', { name: 'Send code' }).click();
  all.push(...(await scan(page, 'admin-login-code')));
  await page.getByLabel('6-digit code').fill((await page.getByText(/Development: code \d{6}/).textContent())!.match(/\d{6}/)![0]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  const nav = await page.locator('aside nav a').allTextContents();
  for (const label of nav) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    all.push(...(await scan(page, `admin-${label}`)));
  }
  // A dialog and the reason prompt.
  await page.getByRole('link', { name: 'Coupons', exact: true }).click();
  await page.getByRole('button', { name: 'New coupon' }).click();
  all.push(...(await scan(page, 'admin-new-coupon-dialog')));
  expect(all, all.join('\n')).toEqual([]);
});

test.describe('extension', () => {
  let context: BrowserContext;
  let extId: string;
  test.beforeAll(async () => {
    ({ context, extId } = await launchExtension());
  });
  test.afterAll(async () => {
    await context?.close();
  });

  test('settings tabs and every side-panel step meet WCAG 2.1 AA', async () => {
    const all: string[] = [];
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extId}/options.html`);
    for (const tab of ['Account', 'Plans', 'Your own AI key', 'History', 'Privacy & data']) {
      await options.getByRole('button', { name: tab, exact: true }).click();
      all.push(...(await scan(options, `options-${tab}`)));
    }
    await options.getByRole('button', { name: 'Account', exact: true }).click();
    await options.locator('input[type=email]').fill('a11y.ext@example.org');
    await options.getByRole('button', { name: 'Email me a code' }).click();
    await options.getByPlaceholder('6-digit code').fill((await options.getByText(/your code is \d{6}/).textContent())!.match(/\d{6}/)![0]);
    await options.getByRole('button', { name: 'Sign in' }).click();
    await expect(options.getByText('Signed in')).toBeVisible();
    for (const tab of ['Account', 'Plans', 'Privacy & data']) {
      await options.getByRole('button', { name: tab, exact: true }).click();
      all.push(...(await scan(options, `options-signed-in-${tab}`)));
    }

    const job = await context.newPage();
    await job.goto(`${SITE}/jobs/lever`);
    const sw = context.serviceWorkers()[0]!;
    const tabs = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })));
    const tabId = tabs.find((t) => t.url?.includes('/jobs/lever'))!.id!;
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 860 });
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
    all.push(...(await scan(panel, 'panel-consent')));
    await panel.getByRole('checkbox').check();
    await panel.getByRole('button', { name: 'Continue' }).click();
    all.push(...(await scan(panel, 'panel-upload')));
    await panel.locator('input[type=file]').setInputFiles(resolve(ROOT, '.e2e/resume.pdf'));
    await expect(panel.getByText('Check what we read')).toBeVisible();
    all.push(...(await scan(panel, 'panel-resume-review')));
    await panel.getByRole('button', { name: /Save and continue|Continue/ }).first().click();
    all.push(...(await scan(panel, 'panel-job')));
    await panel.getByRole('button', { name: 'Analyze this page' }).click();
    await expect(panel.getByRole('heading', { name: 'Senior Data Engineer' })).toBeVisible();
    all.push(...(await scan(panel, 'panel-job-read')));
    await panel.getByRole('button', { name: 'Analyze requirements' }).click();
    await expect(panel.getByText('Match estimate').first()).toBeVisible();
    all.push(...(await scan(panel, 'panel-match')));
    await panel.getByRole('button', { name: 'Tailor my resume' }).click();
    await panel.getByRole('button', { name: 'Start tailoring' }).click();
    await expect(panel.getByRole('button', { name: 'Continue to export' })).toBeVisible({ timeout: 90_000 });
    all.push(...(await scan(panel, 'panel-review')));
    await panel.getByRole('button', { name: 'Continue to export' }).click();
    all.push(...(await scan(panel, 'panel-export')));
    expect(all, all.join('\n')).toEqual([]);
  });
});
