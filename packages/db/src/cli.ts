import { createSql } from './client';
import { migrate, resetDatabase } from './migrate';
import { seed } from './seed';

const cmd = process.argv[2];
const url = process.env.DATABASE_URL ?? 'postgres://jmo:jmo@localhost:54329/jmo';
const sql = createSql(url, { max: 1 });
try {
  if (cmd === 'reset') {
    await resetDatabase(sql);
    await migrate(sql);
    await seed(sql, { ownerEmail: process.env.ADMIN_OWNER_EMAIL ?? 'owner@example.com', useMockAi: !process.env.OPENAI_API_KEY });
  } else if (cmd === 'migrate') {
    await migrate(sql);
  } else if (cmd === 'seed') {
    await seed(sql, { ownerEmail: process.env.ADMIN_OWNER_EMAIL ?? 'owner@example.com', useMockAi: !process.env.OPENAI_API_KEY });
  } else {
    console.error('usage: tsx src/cli.ts migrate|seed|reset');
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
