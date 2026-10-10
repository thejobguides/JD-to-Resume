import { contentStats, exportContent, listContent, readContent } from '@jmo/server';
import { ApiError } from '@jmo/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AdminEnv } from '../context';
import { auditRead, need, stepUp } from '../guard';

// Saved content of opted-in users (content-store.ts): aggregates for every role; the list shows metadata only;
// opening an item or exporting decrypted rows needs Owner/Admin, a fresh step-up, and is written to the audit log.

export const content = new Hono<AdminEnv>();

const Filter = z.object({
  kind: z.enum(['job_post', 'resume', 'result']).optional(),
  user_id: z.string().uuid().optional(),
  optimization_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(20_000).optional(),
});

const filterOf = (q: z.infer<typeof Filter>) => ({ kind: q.kind, userId: q.user_id, optimizationId: q.optimization_id, from: q.from, to: q.to, limit: q.limit });

content.get('/content/stats', need('content.stats'), async (c) => c.json(await contentStats(c.get('deps').sql)));

content.get('/content', need('content.view'), async (c) => {
  const q = Filter.parse(c.req.query());
  return c.json({ data: await listContent(c.get('deps').sql, filterOf(q)) });
});

// Before /content/:id so "export.jsonl" is not taken for an id.
content.get('/content/export.jsonl', need('content.view'), stepUp, async (c) => {
  const q = Filter.parse(c.req.query());
  await auditRead(c, 'content.export', 'stored_content', q.kind ?? 'all');
  const rows = await exportContent(c.get('deps').sql, c.get('deps').env.CONTENT_ENCRYPTION_KEY, filterOf(q));
  return c.body(rows.map((r) => JSON.stringify(r)).join('\n'), 200, { 'content-type': 'application/x-ndjson', 'content-disposition': 'attachment; filename="saved-content.jsonl"' });
});

content.get('/content/:id', need('content.view'), stepUp, async (c) => {
  const id = z.string().uuid().parse(c.req.param('id'));
  const row = await readContent(c.get('deps').sql, c.get('deps').env.CONTENT_ENCRYPTION_KEY, id);
  if (!row) throw new ApiError('not_found', 'Saved item not found (it may have expired or been deleted).');
  await auditRead(c, 'content.view', 'stored_content', id);
  return c.json(row);
});
