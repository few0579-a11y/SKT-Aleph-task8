// 카드 2 자동 확인(로컬 전용): 시험용 소프트웨어 인증기로 등록 흐름을 확인한다.
// BASE=http://localhost:3008 SIGNUP_CODE=... DATABASE_URL=... PG_SEARCH_PATH=t08 node scripts/test-register.mjs
import postgres from 'postgres';
import { SoftAuthenticator } from './soft-authenticator.mjs';

const BASE = process.env.BASE || 'http://localhost:3008';
const CODE = process.env.SIGNUP_CODE;
const db = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connection: { search_path: 't08' } });
const auth = new SoftAuthenticator({ origin: BASE, rpId: new URL(BASE).hostname });

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
const count = async (t) => (await db.unsafe(`select count(*)::int as n from ${t}`))[0].n;
const uname = 'soft' + Date.now().toString(36).slice(-8);

// 가입 코드
check('가입 코드 없이 등록 시작 → 403', (await call('register/options', { username: uname })).status === 403);
check('틀린 가입 코드 → 403', (await call('register/options', { username: uname, signup_code: 'wrong' })).status === 403);

// C19·C20: 챌린지를 서버가 만들고 보관, 요청마다 다름
const o1 = await call('register/options', { username: uname, signup_code: CODE });
const o2 = await call('register/options', { username: uname, signup_code: CODE });
check('등록 옵션 200', o1.status === 200 && o2.status === 200);
const [row1] = await db`select challenge, purpose, used_at, expires_at from challenges where id = ${o1.data.challenge_id}`;
check('C19 챌린지가 서버 DB에 보관됨', row1?.challenge === o1.data.options.challenge && row1.used_at === null);
check('C20 등록 요청마다 챌린지가 다름', o1.data.options.challenge !== o2.data.options.challenge,
  `${o1.data.options.challenge.slice(0, 10)}… / ${o2.data.options.challenge.slice(0, 10)}…`);

// C25: 취소하면 아무것도 저장되지 않음
const usersBefore = await count('users'), keysBefore = await count('passkeys');
const cancel = await call('register/cancel', { challenge_id: o2.data.challenge_id });
const [gone] = await db`select 1 from challenges where id = ${o2.data.challenge_id}`;
check('C25 취소 → 챌린지 삭제, 계정·패스키 그대로', cancel.status === 200 && !gone
  && (await count('users')) === usersBefore && (await count('passkeys')) === keysBefore);

// 다른 출처에서 만든 응답은 거절
const o3 = await call('register/options', { username: uname, signup_code: CODE });
const bad = await call('register/verify', { challenge_id: o3.data.challenge_id, response: auth.create(o3.data.options, { originOverride: 'https://evil.example' }) });
check('다른 출처(origin)의 등록 응답 → 400', bad.status === 400, bad.data.error);
auth.creds.pop();

// C21·C23: 등록 → 공개키 저장, 요청 본문에 개인키 없음
const response = auth.create(o1.data.options);
const bodyText = JSON.stringify({ challenge_id: o1.data.challenge_id, response });
check('C23 등록 요청 본문에 개인키 관련 필드 없음', !/private|"d"\s*:|secret/i.test(bodyText),
  `보낸 필드: ${Object.keys(response.response).join(', ')}`);
const v = await call('register/verify', JSON.parse(bodyText));
check('C21 등록 검증 201', v.status === 201, v.data.error || v.data.passkey?.name);
const [pk] = await db`select p.*, length(public_key) as pk_len from passkeys p where credential_id = ${response.id}`;
check('C21 서버에 공개키(COSE)가 저장됨', pk && pk.pk_len > 60 && pk.public_key[0] === 0xa5, `public_key ${pk?.pk_len}바이트, 첫 바이트 0x${pk?.public_key[0].toString(16)}(CBOR 5칸 맵)`);
const cols = (await db`select column_name from information_schema.columns where table_schema = 't08' and table_name = 'passkeys'`).map((r) => r.column_name);
check('C22 passkeys 테이블에 개인키·비밀번호 열이 없음', !cols.some((c) => /private|password|secret/.test(c)), cols.join(', '));
check('C24 패스키에 이름이 자동으로 붙음', !!pk?.name, pk?.name);
check('가입 후 세션 쿠키 발급', !!v.cookie);

// 1회용: 같은 챌린지로 다시 검증 → 거절
const again = await call('register/verify', JSON.parse(bodyText));
check('사용한 챌린지로 다시 등록 → 400', again.status === 400, again.data.error);

// 로그인한 계정에 패스키 추가: excludeCredentials에 기존 패스키가 들어감
const a1 = await call('register/options', {}, v.cookie);
check('패스키 추가 옵션에 기존 패스키가 excludeCredentials로 들어감',
  a1.status === 200 && a1.data.options.excludeCredentials.some((c) => c.id === response.id));
const a2 = await call('register/verify', { challenge_id: a1.data.challenge_id, response: auth.create(a1.data.options) }, v.cookie);
check('두 번째 패스키 등록 201 + 이름 번호', a2.status === 201, a2.data.passkey?.name);
const list = await call('passkeys', undefined, v.cookie);
check('패스키 목록 2개', list.data.passkeys?.length === 2);

// 패스키 추가 챌린지를 로그인 안 한 상태로 쓰면 거절
const a3 = await call('register/options', {}, v.cookie);
const steal = await call('register/verify', { challenge_id: a3.data.challenge_id, response: auth.create(a3.data.options) });
check('남의 패스키 추가 챌린지를 로그인 없이 사용 → 403', steal.status === 403);

// 이미 있는 아이디
check('이미 쓰는 아이디 → 409', (await call('register/options', { username: uname, signup_code: CODE })).status === 409);

console.log(`\n${pass} PASS / ${fail} FAIL  (계정 ${uname})`);
await db.end();
process.exit(fail ? 1 : 0);
