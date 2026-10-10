import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractJobFromText } from '@jmo/job-extraction';
import { type BrowserContext, expect, type Page, test, type Worker } from '@playwright/test';
import { API, ROOT, SITE } from './global-setup';
import { launchExtension } from './launch';

// The extension's settings page and side panel beyond the main happy path (extension.spec.ts): signed-out states,
// account and usage, the BYOK plan gate, the coupon error path, the saved-content opt-in with "delete saved data",
// local data download and wipe; in the panel, unsupported files, a plain-text resume and job pages without
// structured data (Greenhouse) or with stale structured data.

const EMAIL = 'settings.user@example.org';
let context: BrowserContext;
let sw: Worker;
let extId: string;

test.beforeAll(async () => {
  ({ context, sw, extId } = await launchExtension({ acceptDownloads: true }));
});
test.afterAll(async () => {
  await context?.close();
});

async function apiToken(email: string) {
  const r = (await (await fetch(`${API}/v1/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json()) as { dev_code: string };
  return ((await (await fetch(`${API}/v1/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: r.dev_code }) })).json()) as { access_token: string }).access_token;
}
const me = async (t: string) => (await (await fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${t}` } })).json()) as { settings: { content_opt_in: boolean } };
async function tabIdFor(urlPart: string): Promise<number> {
  const tabs = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url })));
  return tabs.find((x) => x.url?.includes(urlPart))!.id!;
}
const tab = (p: Page, name: string) => p.getByRole('button', { name, exact: true }).click();

test('settings: signed-out states, sign-in, usage, BYOK gate, coupon errors, saved-content opt-in, local data, sign-out, wipe', async () => {
  const options = await context.newPage();
  const errors: string[] = [];
  options.on('pageerror', (e) => errors.push(String(e)));
  await options.goto(`chrome-extension://${extId}/options.html#plans`);
  await expect(options.getByText('Sign in on the Account tab to upgrade.')).toBeVisible();
  await tab(options, 'History');
  await expect(options.getByText('Tailored resumes you export are kept here, on this device only.')).toBeVisible();
  await tab(options, 'Privacy & data');
  await expect(options.getByText('Where your data lives')).toBeVisible();
  await expect(options.getByText('Help improve Job Match Optimizer')).toHaveCount(0); // needs an account

  await tab(options, 'Account');
  await options.locator('input[type=email]').fill(EMAIL);
  await options.getByRole('button', { name: 'Email me a code' }).click();
  const code = (await options.getByText(/your code is \d{6}/).textContent())!.match(/\d{6}/)![0];
  await options.getByPlaceholder('6-digit code').fill(code === '000000' ? '111111' : '000000');
  await options.getByRole('button', { name: 'Sign in' }).click();
  await expect(options.getByText('That code is not correct.')).toBeVisible();
  await options.getByPlaceholder('6-digit code').fill(code);
  await options.getByRole('button', { name: 'Sign in' }).click();
  await expect(options.getByText('Signed in')).toBeVisible();
  await expect(options.getByText('Tailoring runs')).toBeVisible();
  await expect(options.locator('div', { has: options.getByText('Tailoring runs', { exact: true }) }).getByText('0 / 3').first()).toBeVisible();

  await tab(options, 'Your own AI key');
  await expect(options.getByText('This needs the Own-key plan (see Plans).')).toBeVisible();

  await tab(options, 'Plans');
  await options.getByText('Have a code?').click();
  await options.getByLabel('Discount code').fill('NOPE1234');
  await options.getByRole('button', { name: 'Apply to Pro monthly' }).click();
  await expect(options.getByText('This code isn’t valid.').or(options.getByText("This code isn't valid."))).toBeVisible();

  // Saved content: opt in, have something saved (through the API, as the same user), delete it, opt out.
  const token = await apiToken(EMAIL);
  await tab(options, 'Privacy & data');
  const optIn = options.getByRole('checkbox', { name: /Save the job posts I analyze/ });
  await expect(optIn).not.toBeChecked();
  await optIn.click(); // the box follows the server: it turns on once the setting is saved
  await expect(optIn).toBeChecked();
  await expect.poll(async () => (await me(token)).settings.content_opt_in).toBe(true);
  const page = readFileSync(resolve(ROOT, 'tests/fixtures/jd/lever-jsonld.html'), 'utf8').replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ');
  const extracted = await extractJobFromText(page.slice(page.indexOf('Acme Analytics is hiring'), page.indexOf('© Acme')).replace(/\n{2,}/g, '\n').trim());
  const analyzed = await fetch(`${API}/v1/jobs/analyze`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jd_text: extracted.description_text, jd_hash: extracted.jd_hash }) });
  expect(analyzed.status).toBe(200);
  const saved = 1; // the job post, now encrypted on the server
  await options.getByRole('button', { name: 'Delete saved data' }).click();
  await expect(options.getByText(new RegExp(`Deleted ${saved} saved item`))).toBeVisible();
  await optIn.click();
  await expect(optIn).not.toBeChecked();
  await expect.poll(async () => (await me(token)).settings.content_opt_in).toBe(false);
  await expect(options.getByRole('button', { name: 'Delete saved data' })).toHaveCount(0);

  // Local data download leaves out the sign-in.
  const [dl] = await Promise.all([options.waitForEvent('download'), options.getByRole('button', { name: 'Download', exact: true }).click()]);
  const local = JSON.parse(readFileSync((await dl.path())!, 'utf8')) as Record<string, unknown>;
  expect(local).not.toHaveProperty('session');

  await tab(options, 'Account');
  await options.getByRole('button', { name: 'Sign out' }).click();
  await expect(options.getByRole('button', { name: 'Email me a code' })).toBeVisible();

  await tab(options, 'Privacy & data');
  const wipe = options.getByRole('button', { name: 'Delete', exact: true });
  await expect(wipe).toBeDisabled();
  await options.getByPlaceholder('Type DELETE').fill('DELETE');
  await wipe.click();
  await expect(options.getByText('Deleted. The extension is back to a fresh install.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('panel: unsupported files are refused, a TXT resume works, job pages without or with stale structured data', async () => {
  const job = await context.newPage();
  await job.goto(`${SITE}/jobs/greenhouse`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 860 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${await tabIdFor('/jobs/greenhouse')}`);
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Continue' }).click();

  const dir = resolve(ROOT, '.e2e');
  writeFileSync(resolve(dir, 'old.doc'), 'not really a doc');
  writeFileSync(resolve(dir, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await panel.locator('input[type=file]').setInputFiles(resolve(dir, 'old.doc'));
  await expect(panel.getByText(/Old \.doc files aren’t supported/)).toBeVisible();
  await panel.locator('input[type=file]').setInputFiles(resolve(dir, 'photo.png'));
  await expect(panel.getByText('Use a PDF, DOCX or TXT file.')).toBeVisible();

  writeFileSync(
    resolve(dir, 'resume.txt'),
    ['Jordan Rivera', 'Data Engineer', 'EXPERIENCE', 'Globex — Data Engineer', '2021 – Present', '• Built Kafka pipelines processing 2M events per day', '• Deployed services to Kubernetes with Helm', 'SKILLS', 'Python, SQL, Kafka, Kubernetes'].join('\n'),
  );
  await panel.locator('input[type=file]').setInputFiles(resolve(dir, 'resume.txt'));
  await expect(panel.getByText('Check what we read')).toBeVisible();
  await expect(panel.getByText('Globex').first()).toBeVisible();
  await panel.getByRole('button', { name: 'Save and continue' }).click();

  // Greenhouse page without JSON-LD: the job is read from the page itself.
  await panel.getByRole('button', { name: 'Analyze this page' }).click();
  await expect(panel.getByRole('heading', { name: /Product Manager, Growth/ })).toBeVisible();

  // A page whose JSON-LD is stale (an old internship): the visible text is used and both problems are flagged.
  const stale = await context.newPage();
  await stale.goto(`${SITE}/jobs/stale`);
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${await tabIdFor('/jobs/stale')}`);
  await panel.getByRole('button', { name: /^2\. Job$/ }).click();
  await panel.getByRole('button', { name: 'Analyze this page' }).click();
  await expect(panel.getByText('The page’s structured data didn’t match what’s shown, so we read the visible text. Check it below.')).toBeVisible();
  await expect(panel.getByText('This posting says it’s closed or expired.')).toBeVisible();
  await panel.getByRole('button', { name: /Show text/ }).click();
  await expect(panel.locator('pre')).toContainText('PyTorch');
  await expect(panel.locator('pre')).not.toContainText('Summer internship');
});
