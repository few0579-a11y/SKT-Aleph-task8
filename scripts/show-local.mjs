// 로컬 테스트 DB의 계정·패스키·챌린지·세션을 보여 준다(시험용 soft 계정 제외): DATABASE_URL=... node scripts/show-local.mjs
import postgres from 'postgres';

const s = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connection: { search_path: 't08' } });
console.table(await s`select u.username, p.id, p.name, p.sign_count::int, p.last_used_at, length(p.public_key) as pk_bytes, p.created_at
                      from passkeys p join users u on u.id = p.user_id where u.username not like 'soft%' order by p.id`);
console.table(await s`select u.username from users u where u.username not like 'soft%' order by id`);
console.table(await s`select id, purpose, username, used_at is not null as used, created_at from challenges
                      where coalesce(username, '') not like 'soft%' and created_at > now() - interval '30 minutes' order by id`);
console.table(await s`select u.username, count(*)::int as sessions from sessions x join users u on u.id = x.user_id
                      where u.username not like 'soft%' group by u.username`);
await s.end();
