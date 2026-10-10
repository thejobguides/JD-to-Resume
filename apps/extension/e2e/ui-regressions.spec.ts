import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createSql } from '../../../packages/db/src/client';
import { ADMIN, API, ROOT, SITE, WEB } from './global-setup';
import { launchExtension } from './launch';

// Regression tests for the front-end review: each test pins a bug that was fixed.

const DB_URL = 'postgres://jmo:jmo@localhost:54329/jmo_e2e';

async function apiTokens(email: string) {
  const r = (await (await fetch(`${API}/v1/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json()) as { dev_code: string };
  return (await (await fetch(`${API}/v1/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: r.dev_code }) })).json()) as { access_token: string; refresh_token: string; user: { id: string } };
}

// ── Website ──

test('website: the Pricing link scrolls to pricing, each page has its own title, and the skip link reaches the content', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.goto(WEB);
  await expect(page).toHaveTitle(/tailor your resume/);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Pricing' }).click();
  await expect(page.locator('#pricing')).toBeInViewport();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveTitle('Privacy · Job Match Optimizer');
  await page.goto(`${WEB}/no-such-page`);
  await expect(page).toHaveTitle(/Page not found/);
  await page.goto(`${WEB}/terms`);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('website: an expired access token with parallel requests refreshes once and keeps you signed in', async ({ page }) => {
  // The account page loads three things at once; with an expired token all three get a 401. Before the fix each
  // refreshed with the same refresh token, which the API treats as token theft and signs the user out everywhere.
  const email = 'web.refresh@example.org';
  const t = await apiTokens(email);
  await page.goto(WEB);
  await page.evaluate(({ rt, email }) => sessionStorage.setItem('jmo_web_session', JSON.stringify({ access_token: 'expired.access.token', refresh_token: rt, email })), { rt: t.refresh_token, email });
  await page.goto(`${WEB}/account`);
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText('Optimizations this period')).toBeVisible();
  await page.reload();
  await expect(page.getByText(email)).toBeVisible(); // the rotated session is still valid
});

// ── Admin ──

test('admin: sign-in validates the email and shows errors instead of failing silently', async ({ page }) => {
  await page.goto(ADMIN);
  const email = page.getByLabel('Email');
  const send = page.getByRole('button', { name: 'Send code' });
  await email.fill('not-an-email');
  await expect(send).toBeDisabled();
  await email.fill('owner@example.com');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  // A page outside the first screen loads on demand (code splitting) and still works.
  await page.getByLabel('6-digit code').fill((await page.getByText(/Development: code \d{6}/).textContent())!.match(/\d{6}/)![0]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'AI usage & cost', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh data' })).toBeVisible();
  await expect(page).toHaveTitle('AI usage & cost · JMO Admin');
});

// ── Extension ──

// Each extension test launches its own browser, so a failure in one can't leave the next without its setup.
async function launch() {
  const { context, sw, extId } = await launchExtension();
  const tabIdFor = async (part: string) => (await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })))).find((x) => x.url?.includes(part))!.id!;
  const panelFor = async (jobPath: string) => {
    const job = await context.newPage();
    await job.goto(`${SITE}${jobPath}`);
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 400, height: 860 });
    await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${await tabIdFor(jobPath)}`);
    await panel.getByRole('checkbox').check();
    await panel.getByRole('button', { name: 'Continue' }).click();
    return panel;
  };
  return { context, extId, panelFor };
}

test.describe('extension', () => {
  test('upload is keyboard-reachable, files over 10 MB are refused, and resume edits survive switching steps', async () => {
    const { context, panelFor } = await launch();
    try {
      const panel = await panelFor('/jobs/lever');
      const input = panel.getByLabel(/Choose your resume file/);
      expect(await input.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
      await input.focus();
      await expect(input).toBeFocused();

      const big = resolve(ROOT, '.e2e/huge.pdf');
      writeFileSync(big, Buffer.alloc(11 * 1024 * 1024, 0x20));
      await input.setInputFiles(big);
      await expect(panel.getByRole('alert')).toContainText('Use a resume under 10 MB.');

      await input.setInputFiles(resolve(ROOT, '.e2e/resume.pdf'));
      await expect(panel.getByText('Check what we read')).toBeVisible();
      await panel.getByRole('button', { name: 'Save and continue' }).click();
      await panel.getByRole('button', { name: /^1\. Resume$/ }).click();
      // Single-line fields: Enter saves (it used to add a line break to the name).
      await panel.getByRole('button', { name: /^Edit Name:/ }).click();
      await panel.getByLabel('Name', { exact: true }).fill('Edited Name For Test');
      await panel.keyboard.press('Enter');
      await expect(panel.getByRole('button', { name: 'Edit Name: Edited Name For Test' })).toBeVisible();
      await expect(panel.getByText('You have unsaved changes to your resume.')).toBeVisible();
      // Switch away and back: the edit is still there (it used to be lost).
      await panel.getByRole('button', { name: /^2\. Job$/ }).click();
      await panel.getByRole('button', { name: /^1\. Resume$/ }).click();
      await expect(panel.getByText('You have unsaved changes to your resume.')).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Edit Name: Edited Name For Test' })).toBeVisible();
      // Escape cancels an edit.
      await panel.getByRole('button', { name: /^Edit Location:/ }).click();
      await panel.getByLabel('Location', { exact: true }).fill('Somewhere else');
      await panel.keyboard.press('Escape');
      await expect(panel.getByRole('button', { name: /^Edit Location:/ })).not.toContainText('Somewhere else');
      await panel.getByRole('button', { name: 'Save and continue' }).click();
      await panel.getByRole('button', { name: /^1\. Resume$/ }).click();
      await expect(panel.getByText('You have unsaved changes to your resume.')).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Edit Name: Edited Name For Test' })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('daily limit is explained before tailoring, and buying credits completes in the settings page', async () => {
    const EMAIL = 'regress.user@example.org';
    const { context, extId, panelFor } = await launch();
    try {
      const options = await context.newPage();
      await options.goto(`chrome-extension://${extId}/options.html#account`);
      await options.locator('input[type=email]').fill(EMAIL);
      await options.getByRole('button', { name: 'Email me a code' }).click();
      await options.getByPlaceholder('6-digit code').fill((await options.getByText(/your code is \d{6}/).textContent())!.match(/\d{6}/)![0]);
      await options.getByRole('button', { name: 'Sign in' }).click();
      await expect(options.getByText('Signed in')).toBeVisible();

      // Today's free runs are used up (3 of 3) though the month still has some left.
      const sql = createSql(DB_URL, { max: 1 });
      const [u] = await sql<Array<{ id: string }>>`SELECT id FROM users WHERE email = ${EMAIL}`;
      const now = new Date().toISOString();
      await sql`INSERT INTO usage_counters (user_id, period, optimizations) VALUES (${u!.id}, ${`m:${now.slice(0, 7)}`}, 1), (${u!.id}, ${`d:${now.slice(0, 10)}`}, 3)
                ON CONFLICT (user_id, period) DO UPDATE SET optimizations = EXCLUDED.optimizations`;
      await sql.end();

      const panel = await panelFor('/jobs/lever');
      await panel.getByLabel(/Choose your resume file/).setInputFiles(resolve(ROOT, '.e2e/resume.pdf'));
      await panel.getByRole('button', { name: 'Save and continue' }).click();
      await panel.getByRole('button', { name: 'Analyze this page' }).click();
      await panel.getByRole('button', { name: 'Analyze requirements' }).click();
      await expect(panel.getByText(/You’ve reached today’s limit of 3 runs/)).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Tailor my resume' })).toBeDisabled();

      // Credits lift the daily cap; buying them used to leave "Complete payment…" up for 15 minutes.
      await options.bringToFront();
      await options.getByRole('button', { name: 'Plans', exact: true }).click();
      const [checkout] = await Promise.all([context.waitForEvent('page'), options.getByRole('button', { name: 'Buy credits' }).click()]);
      await expect(options.getByText('Complete payment in the new tab. Your plan updates here automatically.')).toBeVisible();
      await checkout.getByRole('button', { name: 'Complete test payment' }).click();
      await expect(checkout.getByRole('heading', { name: /Payment received/ })).toBeVisible();
      await options.bringToFront();
      await expect(options.getByText('Complete payment in the new tab. Your plan updates here automatically.')).toHaveCount(0, { timeout: 20_000 });
      await options.getByRole('button', { name: 'Account', exact: true }).click();
      await expect(options.locator('div', { has: options.getByText('Credits', { exact: true }) }).getByText('25', { exact: true }).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
