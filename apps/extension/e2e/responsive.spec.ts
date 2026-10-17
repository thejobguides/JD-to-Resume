import { expect, type Page, test } from '@playwright/test';
import { ADMIN, WEB } from './global-setup';
import { launchExtension } from './launch';

// Responsive layout on phone, tablet and laptop widths: no page scrolls sideways (wide tables scroll inside their
// card instead), the website's phone menu and the admin drawer open, navigate and close, and laptops get the full
// navigation without a menu button.

const SIZES = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, laptop: { width: 1440, height: 900 } } as const;

async function noSidewaysScroll(page: Page, what: string) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, `${what} is ${scroll}px wide in a ${width}px window`).toBeLessThanOrEqual(width);
}

test('website: every page fits phone, tablet and laptop widths; the phone menu opens, navigates and closes', async ({ page }) => {
  for (const [name, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size);
    for (const path of ['/', '/account', '/privacy', '/terms', '/checkout?cancelled=1', '/checkout/success', '/nope']) {
      await page.goto(`${WEB}${path}`);
      await noSidewaysScroll(page, `${path} on ${name}`);
    }
  }

  await page.setViewportSize(SIZES.phone);
  await page.goto(WEB);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden();
  const menu = page.getByRole('button', { name: 'Open menu' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  const mobile = page.getByRole('navigation', { name: 'Mobile' });
  await expect(mobile.getByRole('link', { name: 'Pricing' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(mobile).toBeHidden();
  await menu.click();
  await mobile.getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  await expect(mobile).toBeHidden(); // closes on navigation

  await page.setViewportSize(SIZES.laptop);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
});

test('admin: the sidebar becomes a drawer on phones and tablets, and no page scrolls sideways', async ({ page }) => {
  await page.setViewportSize(SIZES.laptop);
  await page.goto(ADMIN);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill((await page.getByText(/Development: code \d{6}/).textContent())!.match(/\d{6}/)![0]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Admin sections' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();

  for (const name of ['phone', 'tablet'] as const) {
    await page.setViewportSize(SIZES[name]);
    await page.goto(`${ADMIN}/#/overview`);
    const nav = page.getByRole('navigation', { name: 'Admin sections' });
    await expect(nav).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(nav).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await nav.getByRole('link', { name: 'Users & support', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Users & support' })).toBeVisible();
    await expect(nav).toBeHidden(); // closes on navigation
    for (const hash of ['overview', 'users', 'coupons', 'plans', 'usage', 'ai', 'routing', 'config', 'content', 'audit', 'more']) {
      await page.goto(`${ADMIN}/#/${hash}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await noSidewaysScroll(page, `admin #/${hash} on ${name}`);
    }
  }
});

test('extension settings fit phone, tablet and laptop widths', async () => {
  const { context, extId } = await launchExtension();
  try {
    const page = await context.newPage();
    for (const [name, size] of Object.entries(SIZES)) {
      await page.setViewportSize(size);
      for (const tab of ['account', 'plans', 'byok', 'history', 'privacy']) {
        await page.goto(`chrome-extension://${extId}/options.html#${tab}`);
        await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
        await noSidewaysScroll(page, `settings #${tab} on ${name}`);
      }
    }
  } finally {
    await context.close();
  }
});
