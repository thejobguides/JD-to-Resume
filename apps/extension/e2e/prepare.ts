// Run with tsx before the E2E suite: fresh database, a test coupon, dev signing keys and a resume PDF fixture.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { activateVersion, createCoupon, createDraft, fakeStripe, getActive } from '@jmo/server';
import { loadOrCreateDevKeys } from '@jmo/server/dev-keys';
import { sampleResume } from '@jmo/resume/fixtures';
import { buildPdfDefinition } from '@jmo/resume/generate';
import { freshDatabase } from '../../../tests/setup/db';

const root = resolve(import.meta.dirname, '../../..');
const out = resolve(root, '.e2e');
mkdirSync(out, { recursive: true });

await loadOrCreateDevKeys(resolve(root, '.dev/keys.json'));

const { sql } = await freshDatabase('jmo_e2e');
const [owner] = await sql<Array<{ id: string }>>`SELECT user_id AS id FROM admin_members WHERE role = 'owner'`;
const now = Date.now();
await createCoupon(
  sql,
  fakeStripe('http://127.0.0.1:8799'),
  {
    name: 'E2E launch',
    codes: { mode: 'single', code: 'E2E25' },
    rules: [{ plan_id: 'pro_quarterly', percent_off: 25, duration: 'first_period' }],
    max_redemptions: 10,
    max_per_user: 1,
    valid_from: new Date(now - 60_000).toISOString(),
    valid_until: new Date(now + 86_400_000).toISOString(),
  },
  { id: owner!.id, role: 'owner', reason: 'e2e fixture' },
);
// Every spec signs in from the same local address, so the per-address burst limits (20 sign-in calls a minute)
// would throttle a fast run. Raised for the e2e database only; production limits are untouched.
const limits = structuredClone((await getActive(sql, 'limits', 'production'))!.data) as { burst_per_minute: Record<string, number>; otp_per_hour: number };
limits.burst_per_minute = { ...limits.burst_per_minute, auth: 600, reads: 600, coupons: 200, ai: 200, optimizations: 60 };
limits.otp_per_hour = 10; // the admin owner signs in from several specs (the configured maximum)
const draft = await createDraft(sql, 'limits', 'production', limits, 'e2e: higher burst limits for one shared test address', { id: owner!.id, role: 'owner' });
await activateVersion(sql, draft.id, { id: owner!.id, role: 'owner' }, { reason: 'e2e test environment setup' });
await sql.end({ timeout: 1 });

const require = createRequire(import.meta.url);
const pdfmake = require('pdfmake') as { addFonts(f: unknown): void; setUrlAccessPolicy(f: unknown): void; setLocalAccessPolicy(f: unknown): void; createPdf(dd: unknown): { getBuffer(): Promise<Buffer> } };
pdfmake.addFonts(require('pdfmake/fonts/Roboto'));
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p: string) => p.includes('pdfmake'));
writeFileSync(resolve(out, 'resume.pdf'), await pdfmake.createPdf(buildPdfDefinition(sampleResume(), 'classic')).getBuffer());
console.log('e2e prepared');
