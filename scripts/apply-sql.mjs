// 로컬 테스트 DB에 SQL 파일을 적용한다: DATABASE_URL=... node scripts/apply-sql.mjs db/a.sql db/b.sql
// 배포 DB(Supabase)에는 쓰지 않는다 — 그쪽은 SQL Editor에서 사람이 확인하며 실행한다.
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const s = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
for (const f of process.argv.slice(2)) {
  await s.unsafe(readFileSync(f, 'utf8'));
  console.log('applied', f);
}
await s.end();
