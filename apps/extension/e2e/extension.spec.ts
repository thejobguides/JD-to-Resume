import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type BrowserContext, expect, type Page, test, type Worker } from '@playwright/test';
import { API, ROOT, SITE } from './global-setup';
import { launchExtension } from './launch';

// The whole user path through the real extension: consent → upload resume → read a job page → local score →
// sign in → hosted tailoring with SSE → review → PDF/DOCX export → coupon → fake checkout → plan upgrade.

const EMAIL = 'e2e.user@example.org';

let context: BrowserContext;
let sw: Worker;
let extId: string;

test.beforeAll(async () => {
  ({ context, sw, extId } = await launchExtension({ acceptDownloads: true }));
});

test.afterAll(async () => {
  await context?.close();
});

async function tabIdFor(urlPart: string): Promise<number> {
  const tabs = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })));
  const t = tabs.find((x) => x.url?.includes(urlPart));
  if (!t?.id) throw new Error(`no tab for ${urlPart}: ${JSON.stringify(tabs)}`);
  return t.id;
}

// E2E_SHOTS=1 saves screenshots of key screens to .e2e/shots for visual review.
async function shot(page: Page, name: string) {
  if (process.env.E2E_SHOTS === '1') await page.screenshot({ path: resolve(ROOT, `.e2e/shots/${name}.png`), fullPage: true });
}

async function apiLogin(email: string): Promise<string> {
  const r = (await (await fetch(`${API}/v1/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json()) as { dev_code: string };
  const t = (await (await fetch(`${API}/v1/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: r.dev_code }) })).json()) as { access_token: string };
  return t.access_token;
}

test('resume → job → score → sign in → tailor → export → coupon checkout', async () => {
  const job = await context.newPage();
  await job.goto(`${SITE}/jobs/lever`);
  const panel: Page = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 860 });
  const errors: string[] = [];
  panel.on('pageerror', (e) => errors.push(String(e)));
  panel.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|EvalError/i.test(m.text())) errors.push(m.text());
  });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${await tabIdFor('/jobs/lever')}`);

  // Consent
  await expect(panel.getByText('Before you start')).toBeVisible();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Continue' }).click();

  // Resume: parsed locally with pdf.js
  await panel.locator('input[type=file]').setInputFiles(resolve(ROOT, '.e2e/resume.pdf'));
  await expect(panel.getByText('Check what we read')).toBeVisible();
  await expect(panel.getByText('Globex').first()).toBeVisible();
  await shot(panel, '1-resume-review');
  await panel.getByRole('button', { name: 'Save and continue' }).click();

  // Job: read from the tab, analyzed on-device while signed out
  await panel.getByRole('button', { name: 'Analyze this page' }).click();
  await expect(panel.getByRole('heading', { name: 'Senior Data Engineer' })).toBeVisible();
  await panel.getByRole('button', { name: 'Analyze requirements' }).click();
  await expect(panel.getByText('Match estimate').first()).toBeVisible();
  await expect(panel.getByText(/isn’t an ATS score/)).toBeVisible();
  await expect(panel.getByText('Sign in to tailor your resume')).toBeVisible();
  await shot(panel, '2-match');

  // Sign in from the options page (email code; the dev build shows it)
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html#account`);
  await options.locator('input[type=email]').fill(EMAIL);
  await options.getByRole('button', { name: 'Email me a code' }).click();
  const codeText = await options.getByText(/your code is \d{6}/).textContent();
  await options.getByPlaceholder('6-digit code').fill(codeText!.match(/\d{6}/)![0]);
  await options.getByRole('button', { name: 'Sign in' }).click();
  await expect(options.getByText('Signed in')).toBeVisible();

  // Back in the panel: the account change propagates; tailor with the hosted API (mock AI) over SSE
  await panel.bringToFront();
  // One click starts exactly one run. The resume effect used to start the same run again; on a slow network the second
  // request was refused with "An optimization is already running" (seen against the live API).
  const starts: string[] = [];
  panel.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/v1/optimizations') starts.push(r.url());
  });
  await panel.getByRole('button', { name: 'Tailor my resume' }).click();
  await panel.getByRole('button', { name: 'Start tailoring' }).click();
  await expect(panel.getByRole('button', { name: 'Continue to export' })).toBeVisible({ timeout: 90_000 });
  expect(starts, 'optimization start requests for one click').toHaveLength(1);
  await expect(panel.getByText('Verified against your resume').first()).toBeVisible();
  await shot(panel, '3-review');
  const scoreLine = await panel.getByText(/→/).first().textContent();
  expect(scoreLine).toBeTruthy();

  // Reject one change and accept it again: the after-score is recomputed locally
  await panel.getByRole('button', { name: 'Reject all' }).click();
  await expect(panel.getByRole('button', { name: 'Continue to export' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Accept all verified' }).click();
  await panel.getByRole('button', { name: 'Continue to export' }).click();

  // Export: generated on the device
  const [pdf] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: 'PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  await pdf.saveAs(resolve(ROOT, '.e2e/shots/tailored.pdf'));
  await shot(panel, '4-export');
  expect(readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe('%PDF-');
  const [docx] = await Promise.all([panel.waitForEvent('download'), panel.getByRole('button', { name: 'Word (DOCX)' }).click()]);
  expect(docx.suggestedFilename()).toMatch(/\.docx$/);
  expect(readFileSync((await docx.path())!).subarray(0, 2).toString()).toBe('PK');

  // The server saw the optimization, but holds no resume content for it once acknowledged
  const token = await apiLogin(EMAIL);
  const list = (await (await fetch(`${API}/v1/optimizations`, { headers: { authorization: `Bearer ${token}` } })).json()) as { data: Array<{ id: string; status: string }> };
  expect(list.data.length).toBe(1);
  expect(['succeeded', 'partial']).toContain(list.data[0]!.status);
  const after = (await (await fetch(`${API}/v1/optimizations/${list.data[0]!.id}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { result: unknown };
  expect(after.result).toBeNull();

  // Coupon: "Have a code?" → per-plan price → fake checkout → plan upgrades
  await options.bringToFront();
  await options.getByRole('button', { name: 'Plans' }).click();
  await options.getByText('Have a code?').click();
  await options.getByLabel('Discount code').fill('e2e25');
  await options.getByRole('button', { name: 'Apply to Pro monthly' }).click();
  await expect(options.getByText(/doesn.t apply to this plan/)).toBeVisible();
  await options.getByRole('button', { name: 'Apply to Pro quarterly' }).click();
  await expect(options.getByText(/E2E25: .*25%/)).toBeVisible();
  const quarterly = options.locator('div.rounded-lg', { hasText: 'Pro quarterly' }).filter({ hasText: 'Best value' });
  await expect(quarterly.getByText('$33.75')).toBeVisible();
  await shot(options, '5-plans-coupon');
  const [checkout] = await Promise.all([context.waitForEvent('page'), quarterly.getByRole('button', { name: 'Choose' }).click()]);
  await checkout.waitForURL(/\/checkout\?session=cs_fake_/);
  await expect(checkout.getByRole('heading', { name: 'Test checkout' })).toBeVisible();
  await checkout.getByRole('button', { name: 'Complete test payment' }).click();
  await expect(checkout.getByRole('heading', { name: /Payment received/ })).toBeVisible();
  await options.bringToFront();
  await expect(quarterly.getByText('Your plan')).toBeVisible({ timeout: 30_000 });

  expect(errors).toEqual([]);
});

test('the panel ignores hidden prompt-injection text on a job page', async () => {
  const page = await context.newPage();
  await page.goto(`${SITE}/jobs/noisy`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${await tabIdFor('/jobs/noisy')}`);
  await panel.getByRole('button', { name: /^2\. Job$/ }).click();
  await panel.getByRole('button', { name: 'Analyze this page' }).click();
  await expect(panel.getByText('Hidden text on the page was ignored.')).toBeVisible();
  await panel.getByRole('button', { name: /Show text/ }).click();
  await expect(panel.locator('pre')).not.toContainText(/ignore (all )?previous instructions/i);
});
