import { expect, type Page, test } from '@playwright/test';
import { ADMIN } from './global-setup';

// Admin panel smoke (runs after extension.spec.ts, so the coupon redemption and AI usage from that run exist):
// owner sign-in, every page renders without errors, a key goes into the vault encrypted in the browser, the
// data-policy rule blocks a trial-only provider in production, and the audit chain verifies.

const NAV = ['Overview', 'AI usage & cost', 'Users & support', 'Coupons', 'Plans & pricing', 'AI providers & keys', 'Model per step', 'Runtime config', 'Saved content', 'Audit log', 'Admins, privacy, system'];

async function giveReason(page: Page, text = 'E2E admin smoke test') {
  await page.getByLabel('Reason (saved in the audit log)').fill(text);
  await page.getByRole('button', { name: 'Confirm' }).click();
}

test('admin: sign in, every page, vault key, data-policy block, audit chain', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto(ADMIN);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByRole('button', { name: 'Send code' }).click();
  const hint = await page.getByText(/Development: code \d{6}/).textContent();
  await page.getByLabel('6-digit code').fill(hint!.match(/\d{6}/)![0]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  for (const label of NAV) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.bg-rose-50.border-rose-200')).toHaveCount(0);
    if (process.env.E2E_SHOTS === '1') await page.screenshot({ path: `../../.e2e/shots/admin-${label.replace(/\W+/g, '-').toLowerCase()}.png`, fullPage: true });
  }

  // AI usage: rolled-up data after a manual refresh, and the what-if simulator over the model registry
  await page.getByRole('link', { name: 'AI usage & cost', exact: true }).click();
  await expect(page.getByLabel('Model').locator('option')).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Simulate' }).click();
  await expect(page.getByText(/per month|\/ mo|monthly/i).first()).toBeVisible();

  // Coupons: the code redeemed in the extension run shows up with its redemption
  await page.getByRole('link', { name: 'Coupons', exact: true }).click();
  await expect(page.getByText('E2E launch')).toBeVisible();

  // Vault: the key is encrypted in this browser; the list only ever shows the last 4 characters
  await page.getByRole('link', { name: 'AI providers & keys', exact: true }).click();
  await page.getByRole('button', { name: 'Add key' }).click();
  await page.getByLabel('Label').fill('E2E OpenAI');
  await page.getByLabel('API key').fill('sk-e2e-not-a-real-key-7f3a');
  await page.getByRole('button', { name: 'Encrypt & save' }).click();
  await giveReason(page);
  await expect(page.getByText('••••7f3a')).toBeVisible();
  await expect(page.getByText('sk-e2e-not-a-real-key')).toHaveCount(0);

  // Register a trial-only model, then try to route a resume step to it in production: blocked by policy
  await page.getByRole('button', { name: 'Add model' }).click();
  await page.getByLabel('Provider model ID').fill('meta/llama-3.3-70b-instruct');
  await page.getByLabel('Price source URL').fill('https://build.nvidia.com/models');
  await page.getByRole('button', { name: 'Register' }).click();
  await giveReason(page);
  await expect(page.getByText('nvidia_trial:meta/llama-3.3-70b-instruct')).toBeVisible();

  await page.getByRole('link', { name: 'Model per step', exact: true }).click();
  const optimizeRow = page.locator('tr').filter({ has: page.locator('code', { hasText: /^optimize$/ }) });
  await optimizeRow.locator('select').first().selectOption('nvidia_trial:meta/llama-3.3-70b-instruct');
  await page.getByRole('button', { name: 'Save draft & validate' }).click();
  await giveReason(page, 'Try trial model for optimize');
  await expect(page.getByText('blocked')).toBeVisible();
  await expect(page.getByText(/not allowed in production by its terms/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Activate' })).toHaveCount(0);

  // Audit: every action above is in the hash chain, and the chain verifies
  await page.getByRole('link', { name: 'Audit log', exact: true }).click();
  await expect(page.getByText('hash chain intact')).toBeVisible();
  await expect(page.getByText('credential.create').first()).toBeVisible();
  await expect(page.getByText('model.create').first()).toBeVisible();

  expect(errors).toEqual([]);
});
