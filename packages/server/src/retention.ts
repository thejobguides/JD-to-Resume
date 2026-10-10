import type { ActiveConfig } from '@jmo/config';
import type { Sql } from '@jmo/db';
import { purgeExpiredContent } from './content-store';

// Data retention (security-threat-model.md §3.1). The privacy page quotes these periods, so they must actually run.
// Raw AI request rows are only deleted once the hourly rollup has passed them, so dashboards keep their totals.

const SECURITY_LOG_DAYS = 90;
const IDEMPOTENCY_HOURS = 48;

export interface RetentionResult {
  ai_requests: number;
  job_analyses: number;
  feedback: number;
  auth_sessions: number;
  auth_verifications: number;
  idempotency_keys: number;
  mailboxes: number;
  stored_content: number;
}

export async function applyRetention(sql: Sql, retention: ActiveConfig['retention'], now = new Date()): Promise<RetentionResult> {
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const [w] = await sql<Array<{ processed_until: Date }>>`SELECT processed_until FROM rollup_watermarks WHERE name = 'ai_usage_hourly'`;
  const aiCutoff = new Date(Math.min(days(retention.ai_requests_days).getTime(), w?.processed_until.getTime() ?? 0));
  const count = async (q: PromiseLike<readonly unknown[]>) => (await q).length;
  return {
    ai_requests: await count(sql`DELETE FROM ai_requests WHERE created_at < ${aiCutoff} RETURNING 1`),
    job_analyses: await count(sql`DELETE FROM job_analyses WHERE last_used_at < ${days(retention.job_analyses_days)} RETURNING 1`),
    feedback: await count(sql`DELETE FROM feedback WHERE created_at < ${days(retention.feedback_days)} RETURNING 1`),
    auth_sessions: await count(sql`DELETE FROM auth_sessions WHERE COALESCE(revoked_at, expires_at) < ${days(SECURITY_LOG_DAYS)} RETURNING 1`),
    auth_verifications: await count(sql`DELETE FROM auth_verifications WHERE created_at < ${days(1)} RETURNING 1`),
    idempotency_keys: await count(sql`DELETE FROM idempotency_keys WHERE created_at < ${new Date(now.getTime() - IDEMPOTENCY_HOURS * 3_600_000)} RETURNING 1`),
    mailboxes: await count(sql`DELETE FROM optimization_mailbox WHERE expires_at < ${now} RETURNING 1`),
    // Opted-in users' saved content: 12 months (content-store.ts), as the privacy notice says.
    stored_content: await purgeExpiredContent(sql, now),
  };
}
