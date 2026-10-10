import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractJobFromText } from '@jmo/job-extraction';
import { expect, type Page, test } from '@playwright/test';
import { createSql } from '../../../packages/db/src/client';
import { ADMIN, API, ROOT } from './global-setup';

// Admin panel flows through the UI (the smoke test in system-admin.spec.ts visits every page): user support actions
// with audit reasons, coupon creation and pausing, bulk-code export behind step-up, a new price, the Saved content
// page (aggregates, opening an item behind step-up, JSONL export) and the audit CSV export.

const DB_URL = 'postgres://jmo:jmo@localhost:54329/jmo_e2e';
const USER = 'admin.flows.user@example.org';

async function apiLogin(email: string) {
  const r = (await (await fetch(`${API}/v1/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).json()) as { dev_code: string };
  return ((await (await fetch(`${API}/v1/auth/otp/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: r.dev_code }) })).json()) as { access_token: string }).access_token;
}
async function giveReason(page: Page, text = 'E2E admin flow test') {
  await page.getByLabel('Reason (saved in the audit log)').fill(text);
  await page.getByRole('button', { name: 'Confirm' }).click();
}
/** Ages the admin's last re-authentication past the 10-minute window, so the next sensitive action asks for a code. */
async function expireStepUp() {
  const sql = createSql(DB_URL, { max: 1 });
  await sql`UPDATE auth_sessions SET last_step_up_at = now() - interval '11 minutes' WHERE kind = 'admin'`;
  await sql`DELETE FROM auth_verifications WHERE identifier = 'owner@example.com'`;
  await sql.end();
}
async function confirmStepUp(page: Page) {
  await expect(page.getByRole('heading', { name: "Confirm it's you" })).toBeVisible();
  const hint = await page.getByText(/Development: code \d{6}/).textContent();
  await page.getByLabel('Code').fill(hint!.match(/\d{6}/)![0]);
  await page.getByRole('button', { name: 'Confirm' }).click();
}

test('admin flows: support actions, coupons, step-up exports, prices, saved content, audit export', async ({ page }) => {
  // A user who opted in to saved content and analyzed a job.
  const token = await apiLogin(USER);
  await fetch(`${API}/v1/account/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ content_opt_in: true }) });
  const html = readFileSync(resolve(ROOT, 'tests/fixtures/jd/lever-jsonld.html'), 'utf8').replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ');
  const job = await extractJobFromText(html.slice(html.indexOf('Acme Analytics is hiring'), html.indexOf('© Acme')).replace(/\n{2,}/g, '\n').trim());
  expect((await fetch(`${API}/v1/jobs/analyze`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jd_text: job.description_text, jd_hash: job.jd_hash, structured_hint: { title: 'Senior Data Engineer', company: 'Acme Analytics' } }) })).status).toBe(200);

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(ADMIN);
  await page.getByLabel('Email').fill('owner@example.com');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill((await page.getByText(/Development: code \d{6}/).textContent())!.match(/\d{6}/)![0]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  // ── Users & support: find the user, give credits and complimentary access (each needs a reason) ──
  await page.getByRole('link', { name: 'Users & support', exact: true }).click();
  await page.getByPlaceholder(/Search by email/).fill('admin.flows.user');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('cell', { name: /^a.*@example\.org$/ }).first().click();
  await expect(page.getByText(/Saved content: opted in since/)).toBeVisible();
  await expect(page.getByText(/1 item\(s\)/)).toBeVisible();
  await page.getByRole('button', { name: '+5 credits' }).click();
  await giveReason(page, 'Goodwill credits after a support ticket');
  await expect(page.getByText(/credits 5/)).toBeVisible();
  await page.getByRole('button', { name: 'Complimentary access' }).click();
  await page.getByRole('button', { name: 'Grant', exact: true }).click();
  await giveReason(page, 'Press review account for two weeks');
  await expect(page.getByText(/pro_monthly \(grant\)/)).toBeVisible();
  await page.getByRole('button', { name: 'reveal (audited)' }).click();
  await expect(page.getByText(USER)).toBeVisible();
  await page.keyboard.press('Escape');

  // ── Coupons: create through the form, then pause ──
  await page.getByRole('link', { name: 'Coupons', exact: true }).click();
  await page.getByRole('button', { name: 'New coupon' }).click();
  await page.getByPlaceholder('LAUNCH30').fill('ADMINUI20');
  await page.getByPlaceholder('Launch week — Reddit post').fill('Admin UI campaign');
  const monthly = page.locator('label', { hasText: 'Pro monthly' }).locator('input[type=checkbox]');
  if (!(await monthly.isChecked())) await monthly.check();
  await page.getByRole('button', { name: 'Create coupon' }).click();
  await giveReason(page, 'Campaign created from the admin UI test');
  await expect(page.getByText('Admin UI campaign')).toBeVisible();
  await page.getByText('Admin UI campaign').click();
  await page.getByRole('button', { name: 'Pause' }).click();
  await giveReason(page, 'Pausing the admin UI test campaign');
  await expect(page.getByText(/Status\s*paused/)).toBeVisible();
  await page.keyboard.press('Escape');

  // Bulk codes: exporting them is sensitive (step-up), and the download now asks for the code instead of failing.
  await page.getByRole('button', { name: 'New coupon' }).click();
  await page.getByText('Bulk single-use codes').click();
  await page.getByLabel('How many codes').fill('3');
  await page.getByPlaceholder('Launch week — Reddit post').fill('Admin UI bulk');
  const monthly2 = page.locator('label', { hasText: 'Pro monthly' }).locator('input[type=checkbox]');
  if (!(await monthly2.isChecked())) await monthly2.check();
  await page.getByRole('button', { name: 'Create coupon' }).click();
  await giveReason(page, 'Bulk codes for the admin UI test');
  await page.getByText('Admin UI bulk').click();
  await expireStepUp();
  const codesDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export codes (audited)' }).click();
  await confirmStepUp(page);
  const codes = readFileSync((await (await codesDownload).path())!, 'utf8').split('\n');
  expect(codes[0]).toBe('code,status,max_uses,batch_id');
  expect(codes).toHaveLength(4);
  await page.keyboard.press('Escape');

  // ── Plans & pricing: a new price (Owner; step-up still fresh). BYOK, so other specs' prices stay as seeded. ──
  await page.getByRole('link', { name: 'Plans & pricing', exact: true }).click();
  await page.locator('tr', { hasText: 'byok_annual' }).getByRole('button', { name: 'New price' }).click();
  await page.getByPlaceholder('19.00').fill('42.00');
  await page.getByRole('button', { name: 'Create price' }).click();
  await giveReason(page, 'New price for new subscribers');
  await expect(page.getByText('USD 42.00').first()).toBeVisible();

  // ── Saved content: aggregates, open an item behind step-up, export JSONL ──
  await page.getByRole('link', { name: 'Saved content', exact: true }).click();
  await expect(page.getByText('Users opted in')).toBeVisible();
  await expect(page.getByText(/Opening an item or exporting decrypts content/)).toBeVisible();
  await expireStepUp();
  await page.getByRole('cell', { name: /Senior Data Engineer/ }).first().click();
  await confirmStepUp(page);
  await expect(page.locator('pre')).toContainText('Acme Analytics is hiring');
  await page.keyboard.press('Escape');
  await page.getByLabel('Kind').selectOption('job_post');
  const jsonl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSONL' }).click();
  const lines = readFileSync((await (await jsonl).path())!, 'utf8').split('\n').map((l) => JSON.parse(l) as { kind: string; payload: { jd_text: string } });
  expect(lines.every((l) => l.kind === 'job_post')).toBe(true);
  expect(lines.some((l) => l.payload.jd_text.includes('Acme Analytics'))).toBe(true);

  // ── Audit log: every action above is there; the CSV export downloads ──
  await page.getByRole('link', { name: 'Audit log', exact: true }).click();
  await expect(page.getByText('hash chain intact')).toBeVisible();
  for (const action of ['credits.grant', 'grant.create', 'coupon.create', 'coupon.pause', 'price.create', 'content.view', 'content.export', 'coupon.codes_export']) {
    await expect(page.getByText(action, { exact: true }).first(), action).toBeVisible();
  }
  const auditCsv = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export|CSV/ }).first().click();
  expect(readFileSync((await (await auditCsv).path())!, 'utf8').split('\n')[0]).toBe('id,occurred_at,actor_type,actor_role,action,target_type,target_id,reason,request_id');

  expect(errors).toEqual([]);
});
