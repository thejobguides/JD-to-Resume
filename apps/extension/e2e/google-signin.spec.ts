import { type BrowserContext, expect, test } from '@playwright/test';
import { EXT_DIR, GOOGLE_USER } from './global-setup';
import { launchExtension } from './launch';

// "Continue with Google" through the real chrome.identity.launchWebAuthFlow, against a stand-in provider
// (Google itself can't be automated). The API verifies the signed ID token, nonce and audience.

let context: BrowserContext;
let extId: string;

test.beforeAll(async () => {
  ({ context, extId } = await launchExtension());
});

test.afterAll(async () => {
  await context?.close();
});

test('the dev build has a stable extension ID (Google redirect URL depends on it)', () => {
  expect(extId).toBe('hbbojlpbahndpodjekcjheebjlhjiobd');
});

test('Continue with Google signs in from the settings page and the side panel picks it up', async () => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html#account`);
  await options.setViewportSize({ width: 900, height: 560 });
  await expect(options.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  if (process.env.E2E_SHOTS === '1') await options.screenshot({ path: `${EXT_DIR}/../shots/google-signin.png` });
  await options.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(options.getByText('Signed in')).toBeVisible();
  await expect(options.getByText(GOOGLE_USER.email)).toBeVisible();

  // The session persists (encrypted local store) and the side panel picks it up.
  await options.reload();
  await expect(options.getByText(GOOGLE_USER.email)).toBeVisible();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Continue' }).click();
  await expect(panel.getByText('Free', { exact: true })).toBeVisible();

  // Signing out and back in with the same Google account reuses the same account.
  await options.bringToFront();
  await options.getByRole('button', { name: 'Sign out' }).click();
  await options.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(options.getByText(GOOGLE_USER.email)).toBeVisible();
});
