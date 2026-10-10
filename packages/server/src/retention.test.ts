import { defaultConfig } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { uuidv7 } from '@jmo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbAvailable, freshDatabase } from '../../../tests/setup/db';
import { applyRetention } from './retention';

const up = await dbAvailable();

describe.skipIf(!up)('retention', () => {
  let sql: Sql;
  beforeAll(async () => {
    ({ sql } = await freshDatabase('jmo_test_retention'));
  });
  afterAll(async () => sql?.end({ timeout: 1 }));

  it('deletes only what is past its period, and never raw AI rows the rollup has not processed', async () => {
    const now = new Date('2026-09-30T12:00:00Z');
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const ai = (at: Date) => sql`INSERT INTO ai_requests (id, created_at, task, prompt_version_id, model_id, provider_id, outcome) VALUES (${uuidv7()}, ${at}, 'optimize', 'optimize@v1', 'mock:deterministic', 'mock', 'ok')`;
    await ai(ago(120));
    await ai(ago(100));
    await ai(ago(10));
    // Rollup has only processed up to 110 days ago: the 100-day-old row must survive even though it is past 90 days.
    await sql`INSERT INTO rollup_watermarks (name, processed_until) VALUES ('ai_usage_hourly', ${ago(110)}) ON CONFLICT (name) DO UPDATE SET processed_until = EXCLUDED.processed_until`;
    const ja = (used: Date, h: string) => sql`INSERT INTO job_analyses (id, jd_hash, prompt_version, model_tier, analysis, last_used_at) VALUES (${uuidv7()}, ${h}, 'jd_extract@v1', 'cheap', '{}', ${used})`;
    await ja(ago(31), 'sha256:old');
    await ja(ago(2), 'sha256:new');
    await sql`INSERT INTO feedback (id, target, rating, created_at) VALUES (${uuidv7()}, 'general', 1, ${ago(800)}), (${uuidv7()}, 'general', 1, ${ago(5)})`;

    const cfg = defaultConfig({ useMockAi: true });
    const r1 = await applyRetention(sql, cfg.retention, now);
    expect(r1).toMatchObject({ ai_requests: 1, job_analyses: 1, feedback: 1 });

    await sql`UPDATE rollup_watermarks SET processed_until = ${now} WHERE name = 'ai_usage_hourly'`;
    const r2 = await applyRetention(sql, cfg.retention, now);
    expect(r2.ai_requests).toBe(1);
    const [left] = await sql`SELECT count(*)::int AS n FROM ai_requests`;
    expect(left!.n).toBe(1);
  });
});
