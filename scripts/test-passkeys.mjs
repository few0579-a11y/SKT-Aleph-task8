// 카드 4 자동 확인(로컬 전용): 패스키 두 개 등록 → 하나 삭제 → 남은 것으로 로그인, 지운 것은 거절, 마지막 하나는 삭제 불가.
// BASE=http://localhost:3008 SIGNUP_CODE=... DATABASE_URL=... node scripts/test-passkeys.mjs
import postgres from 'postgres';
import { SoftAuthenticator } from './soft-authenticator.mjs';

const BASE = process.env.BASE || 'http://localhost:3008';
const CODE = process.env.SIGNUP_CODE;
const db = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connection: { search_path: 't08' } });
const rpId = new URL(BASE).hostname;
const devA1 = new SoftAuthenticator({ origin: BASE, rpId }); // 계정 A의 첫 번째 인증기
const devA2 = new SoftAuthenticator({ origin: BASE, rpId }); // 계정 A의 두 번째 인증기(다른 기기)
const devB = new SoftAuthenticator({ origin: BASE, rpId });  // 계정 B

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function call(path, body, cookie, method) {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: setCookie ? setCookie.split(';')[0] : null };
}
async function signup(dev, name) {
  const o = await call('register/options', { username: name, signup_code: CODE });
  const v = await call('register/verify', { challenge_id: o.data.challenge_id, response: dev.create(o.data.options) });
  return v;
}
async function login(dev) {
  const o = await call('login/options', {});
  return call('login/verify', { challenge_id: o.data.challenge_id, response: dev.get(o.data.options) });
}
const tag = Date.now().toString(36).slice(-6);

// 준비: 계정 A(패스키 1) + 두 번째 패스키 추가, 계정 B
const a = await signup(devA1, 'softa' + tag);
const add = await call('register/options', {}, a.cookie);
const a2 = await call('register/verify', { challenge_id: add.data.challenge_id, response: devA2.create(add.data.options) }, a.cookie);
const b = await signup(devB, 'softb' + tag);
check('준비: 계정 A 패스키 2개, 계정 B 패스키 1개', a.status === 201 && a2.status === 201 && b.status === 201);

const listA = await call('passkeys', undefined, a.cookie);
check('C42 계정 A에 패스키 2개', listA.data.passkeys?.length === 2);
check('C43 목록에 이름과 등록 날짜가 보임', listA.data.passkeys?.every((p) => p.name && p.created_at),
  listA.data.passkeys?.map((p) => `${p.name} / ${p.created_at}`).join(' | '));
const [pk1, pk2] = listA.data.passkeys;

// 다른 기기(devA2)에서도 로그인해 세션을 하나 더 만든다
const otherDevice = await login(devA2);
check('준비: 다른 기기 세션', otherDevice.status === 200);

// 남의 패스키 삭제 → 404, 개수 그대로
const beforeA = (await db`select count(*)::int n from passkeys where user_id = ${a.data.user.id}`)[0].n;
const steal = await call(`passkeys/${pk1.id}`, undefined, b.cookie, 'DELETE');
const afterA = (await db`select count(*)::int n from passkeys where user_id = ${a.data.user.id}`)[0].n;
check('다른 계정(B)이 A의 패스키 삭제 → 404, A의 패스키 수 그대로', steal.status === 404 && beforeA === afterA, `${steal.status}, ${beforeA}→${afterA}`);
check('로그인 없이 패스키 삭제 → 401', (await call(`passkeys/${pk1.id}`, undefined, null, 'DELETE')).status === 401);

// 첫 번째 패스키 삭제 → 200, 다른 기기 세션 끊김, 지금 세션 유지
const del = await call(`passkeys/${pk1.id}`, undefined, a.cookie, 'DELETE');
check('패스키 하나 삭제 → 200, 남은 1개', del.status === 200 && del.data.remaining === 1, JSON.stringify(del.data));
check('삭제 후 다른 기기 세션은 끊김(401)', (await call('private', undefined, otherDevice.cookie)).status === 401);
check('삭제한 세션(지금 쓰는 것)은 유지(200)', (await call('private', undefined, a.cookie)).status === 200);

// C44·C45
const okLogin = await login(devA2);
check('C44 남은 패스키로 로그인 → 200', okLogin.status === 200 && okLogin.data.user?.id === a.data.user.id);
const goneLogin = await login(devA1);
check('C45 지운 패스키로 로그인 → 401', goneLogin.status === 401 && !goneLogin.cookie, `${goneLogin.status} ${goneLogin.data.error}`);

// C46: 마지막 하나는 삭제 불가
const last = await call(`passkeys/${pk2.id}`, undefined, okLogin.cookie, 'DELETE');
const remain = (await db`select count(*)::int n from passkeys where user_id = ${a.data.user.id}`)[0].n;
check('C46 마지막 패스키 삭제 → 409, 1개 남음', last.status === 409 && remain === 1, `${last.status} ${last.data.error}`);

check('없는 번호·이상한 번호 → 404/400',
  (await call('passkeys/999999999', undefined, okLogin.cookie, 'DELETE')).status === 404
  && (await call('passkeys/abc', undefined, okLogin.cookie, 'DELETE')).status === 400);

console.log(`\n${pass} PASS / ${fail} FAIL  (계정 softa${tag}, softb${tag})`);
await db.end();
process.exit(fail ? 1 : 0);
