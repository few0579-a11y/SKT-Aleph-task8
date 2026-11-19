// 비공개 항목 추가 자동 확인(로컬 전용): 세 종류 추가, 다른 계정을 적어 보내도 내 계정에만 저장, 상대 건수 그대로.
// BASE=http://localhost:3008 SIGNUP_CODE=... DATABASE_URL=... node scripts/test-notes.mjs
import postgres from 'postgres';
import { SoftAuthenticator } from './soft-authenticator.mjs';

const BASE = process.env.BASE || 'http://localhost:3008';
const CODE = process.env.SIGNUP_CODE;
const db = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connection: { search_path: 't08' } });
const rpId = new URL(BASE).hostname;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
async function call(path, body, cookie) {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: setCookie ? setCookie.split(';')[0] : null };
}
async function signup(name) {
  const dev = new SoftAuthenticator({ origin: BASE, rpId });
  const o = await call('register/options', { username: name, signup_code: CODE });
  return call('register/verify', { challenge_id: o.data.challenge_id, response: dev.create(o.data.options) });
}
const tag = Date.now().toString(36).slice(-6);
const a = await signup('softna' + tag);
const b = await signup('softnb' + tag);
const countB = async () => (await db`select count(*)::int n from notes where user_id = ${b.data.user.id}`)[0].n;

for (const kind of ['retro', 'project', 'apply']) {
  const r = await call('private/notes', { kind, title: `${kind} 제목`, body: '가상의 내용' }, a.cookie);
  check(`${kind} 추가 201`, r.status === 201 && r.data.note.kind === kind);
}
check('이상한 종류 → 400', (await call('private/notes', { kind: 'secret', title: 't', body: 'b' }, a.cookie)).status === 400);
check('로그인 없이 추가 → 401', (await call('private/notes', { kind: 'retro', title: 't', body: 'b' })).status === 401);

const before = await countB();
const spoof = await call('private/notes', { kind: 'retro', title: 'B에 넣기 시도', body: 'x', user_id: b.data.user.id, username: 'softnb' + tag }, a.cookie);
const after = await countB();
const [owner] = await db`select user_id from notes where id = ${spoof.data.note.id}`;
check('본문에 B를 적어 보내도 A 계정에 저장, B 건수 그대로', owner.user_id === a.data.user.id && before === after, `B ${before}→${after}`);
const list = await call(`private?user_id=${b.data.user.id}`, undefined, a.cookie);
check('주소에 B를 적어 조회해도 A 자료만', list.data.user.id === a.data.user.id && list.data.notes.length === 4, `${list.data.notes.length}건`);

console.log(`\n${pass} PASS / ${fail} FAIL`);
await db.end();
process.exit(fail ? 1 : 0);
