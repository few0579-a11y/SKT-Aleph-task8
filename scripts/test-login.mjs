// 카드 3 자동 확인(로컬 전용): 시험용 소프트웨어 인증기로 로그인·로그아웃 흐름을 확인한다.
// BASE=http://localhost:3008 SIGNUP_CODE=... DATABASE_URL=... node scripts/test-login.mjs
import postgres from 'postgres';
import { SoftAuthenticator } from './soft-authenticator.mjs';

const BASE = process.env.BASE || 'http://localhost:3008';
const CODE = process.env.SIGNUP_CODE;
const db = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connection: { search_path: 't08' } });
const auth = new SoftAuthenticator({ origin: BASE, rpId: new URL(BASE).hostname });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const mask = (c) => (c ? c.replace(/=(.{6}).*/, '=$1…(가림)') : c);

async function call(path, body, cookie) {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data: await res.json().catch(() => ({})), cookie: setCookie ? setCookie.split(';')[0] : null };
}

// 준비: 시험 계정 + 패스키 1개 등록
const uname = 'soft' + Date.now().toString(36).slice(-8);
const ro = await call('register/options', { username: uname, signup_code: CODE });
const rv = await call('register/verify', { challenge_id: ro.data.challenge_id, response: auth.create(ro.data.options) });
check('준비: 시험 계정 등록', rv.status === 201);
await call('logout', {}, rv.cookie);

// C27·C28: 로그인마다 새 챌린지
const l1 = await call('login/options', {});
const l2 = await call('login/options', {});
const [c1] = await db`select challenge, purpose, used_at from challenges where id = ${l1.data.challenge_id}`;
check('C27 로그인 챌린지를 서버가 만들어 DB에 보관', l1.status === 200 && c1?.challenge === l1.data.options.challenge && c1.purpose === 'login');
check('C28 로그인 요청마다 챌린지가 다름', l1.data.options.challenge !== l2.data.options.challenge,
  `${l1.data.options.challenge.slice(0, 10)}… / ${l2.data.options.challenge.slice(0, 10)}…`);
check('로그인 옵션에 아이디·패스키 목록이 없음(allowCredentials 비어 있음)', (l1.data.options.allowCredentials || []).length === 0);

// C30: 서명이 틀린 요청 → 401 (먼저 실패 요청)
const bad = await call('login/verify', { challenge_id: l2.data.challenge_id, response: auth.get(l2.data.options, { tamper: true }) });
check('C30 틀린 서명 → 401, 세션 없음', bad.status === 401 && !bad.cookie, bad.data.error);

// C29·C30: 올바른 서명 → 200 + 세션
const goodResp = auth.get(l1.data.options);
const good = await call('login/verify', { challenge_id: l1.data.challenge_id, response: goodResp });
check('C29 공개키로 서명 확인 후 통과 → 200 + 세션 쿠키', good.status === 200 && !!good.cookie, `Set-Cookie ${mask(good.cookie)}`);
const priv = await call('private', undefined, good.cookie);
check('로그인 후 비공개 자료 200', priv.status === 200 && priv.data.user?.username === uname);

// C31: 이미 쓴 챌린지 재사용 → 거절
const replay = await call('login/verify', { challenge_id: l1.data.challenge_id, response: goodResp });
check('C31 이미 사용한 챌린지로 다시 로그인 → 거절', replay.status === 400 && !replay.cookie, `${replay.status} ${replay.data.error}`);

// 다른 출처에서 만든 서명 → 거절
const l3 = await call('login/options', {});
const evil = await call('login/verify', { challenge_id: l3.data.challenge_id, response: auth.get(l3.data.options, { originOverride: 'https://evil.example' }) });
check('다른 출처(origin)의 로그인 응답 → 401', evil.status === 401, evil.data.error);

// 챌린지 A로 받은 서명을 챌린지 B에 붙여 보냄 → 거절
const l4 = await call('login/options', {});
const l5 = await call('login/options', {});
const swapped = await call('login/verify', { challenge_id: l5.data.challenge_id, response: auth.get(l4.data.options) });
check('다른 챌린지에 서명한 응답 → 401', swapped.status === 401, swapped.data.error);

// 등록되지 않은 패스키 → 401
const stranger = new SoftAuthenticator({ origin: BASE, rpId: new URL(BASE).hostname });
stranger.create({ challenge: 'x', user: { id: 'eA' } });
const l6 = await call('login/options', {});
const unk = await call('login/verify', { challenge_id: l6.data.challenge_id, response: stranger.get(l6.data.options) });
check('등록되지 않은 패스키 → 401', unk.status === 401, unk.data.error);

// C33: 로그아웃 뒤 같은 쿠키 값으로 다시 요청 → 401
const out = await call('logout', {}, good.cookie);
const after = await call('private', undefined, good.cookie);
const [sess] = await db`select count(*)::int as n from sessions s join users u on u.id = s.user_id where u.username = ${uname}`;
check('C33 로그아웃 뒤 같은 세션 값으로 요청 → 401', out.status === 200 && after.status === 401 && sess.n === 0, `${after.status} ${after.data.error}`);

// 서명 횟수·마지막 사용 시각 갱신
const [pk] = await db`select sign_count, last_used_at from passkeys p join users u on u.id = p.user_id where u.username = ${uname}`;
check('로그인 성공 시 sign_count·last_used_at 갱신', Number(pk.sign_count) >= 1 && pk.last_used_at !== null, `sign_count ${pk.sign_count}`);

console.log(`\n${pass} PASS / ${fail} FAIL  (계정 ${uname})`);
await db.end();
process.exit(fail ? 1 : 0);
