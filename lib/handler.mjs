// API 로직. Vercel 함수(api/router.js)와 로컬 서버(server.mjs)가 함께 쓴다.
import postgres from 'postgres';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { SESSION_COOKIE, tokenHash, readCookie, newToken, sessionExpiry, sessionCookie, clearCookie } from './session.mjs';
import {
  RP_ID, ORIGIN, RP_NAME, randomB64url, challengeExpiry, signupCodeOk, autoName, storageLabel,
} from './webauthn.mjs';

// DB 연결은 요청마다 새로 만들고 응답 전에 닫는다.
// (T06·T07에서 요청 사이에 연결을 재사용하면 Supabase 트랜잭션 풀러에서 쿼리가 멈추는 문제가 있었다.)
function openDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new HttpError(500, 'DATABASE_URL이 설정되지 않았습니다');
  return postgres(url, {
    prepare: false,     // Supabase transaction pooler 호환
    max_pipeline: 1,
    max: Number(process.env.PG_POOL_MAX) || 3, // 로컬 테스트 DB(PGlite)는 1
    connect_timeout: 10,
    // 로컬 테스트용: 역할 설정 없이 t08 스키마를 쓰려면 PG_SEARCH_PATH=t08 (배포본은 t08_app 역할 설정으로 정해짐)
    ...(process.env.PG_SEARCH_PATH ? { connection: { search_path: process.env.PG_SEARCH_PATH } } : {}),
    types: { bigint: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => x } },
  });
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function text(v, name, max) {
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, `${name}은(는) 필수입니다`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${name}은(는) ${max}자 이하입니다`);
  return s;
}

// ---------- 인증 확인 ----------
// 쿠키의 세션 값 → 해시 → 만료되지 않은 세션 행 → 계정. 없으면 null.
async function currentUser(s, headers) {
  const token = readCookie(headers?.cookie, SESSION_COOKIE);
  if (!token) return null;
  const [u] = await s`select u.id, u.username from sessions x join users u on u.id = x.user_id
                      where x.token_hash = ${tokenHash(token)} and x.expires_at > now()`;
  return u || null;
}

// 비공개 자료가 필요한 모든 요청은 여기를 지난다. 로그인하지 않았으면 401로 거절한다.
async function requireUser(s, headers) {
  const u = await currentUser(s, headers);
  if (!u) throw new HttpError(401, '패스키로 로그인해야 볼 수 있습니다');
  return u;
}

// ---------- 비공개 자료 ----------
// 누구의 자료인지는 항상 세션에서 정한다. 주소·요청 본문에 다른 계정을 적어도 쓰지 않는다.
async function listNotes(s, uid) {
  return s`select id, kind, title, body, created_at from notes where user_id = ${uid} order by kind, created_at, id`;
}

// 항목 1건 조회. 번호와 로그인한 계정(uid)을 함께 조건으로 걸어서, 남의 글 번호를 넣으면 행이 없다.
// 남의 글과 없는 글을 똑같이 404로 돌려줘서 그 번호의 글이 있는지조차 알려 주지 않는다.
async function getNote(s, uid, rawId) {
  const id = /^[1-9][0-9]{0,9}$/.test(rawId) ? Number(rawId) : null;
  if (!id) throw new HttpError(400, '항목 번호가 올바르지 않습니다');
  const [row] = await s`select id, kind, title, body, created_at from notes where id = ${id} and user_id = ${uid}`;
  if (!row) throw new HttpError(404, '내 비공개 항목 중에 그 번호가 없습니다');
  return row;
}

// 새 비공개 항목 추가(회고·프로젝트 메모·지원할 곳). 추가만 하고 수정·삭제는 없다.
// 본문에 user_id·username을 적어 보내도 쓰지 않고, 로그인한 계정(uid)에 저장한다.
const KINDS = ['retro', 'project', 'apply'];
async function addNote(s, uid, b, fixedKind) {
  const kind = fixedKind || b.kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, '종류는 retro/project/apply 중 하나입니다');
  const title = text(b.title, '제목', 100);
  const body = text(b.body, '내용', 2000);
  const [row] = await s`insert into notes (user_id, kind, title, body) values (${uid}, ${kind}, ${title}, ${body})
                        returning id, kind, title, body, created_at`;
  return row;
}

// ---------- 세션 ----------
async function startSession(s, uid) {
  const token = newToken();
  await s`insert into sessions (token_hash, user_id, expires_at) values (${tokenHash(token)}, ${uid}, ${sessionExpiry()})`;
  return sessionCookie(token);
}

// ---------- 패스키 등록 ----------
// 1단계: 서버가 일회용 챌린지를 만들어 DB에 보관하고 등록 옵션을 보낸다.
//  - 새 계정: 가입 코드 + 아이디. 계정은 아직 만들지 않는다(검증이 끝나야 만든다 → 중간에 취소하면 계정·패스키가 남지 않음).
//  - 로그인한 계정: 패스키 추가. 이미 등록한 패스키는 excludeCredentials로 알려 같은 인증기에 중복 등록하지 않게 한다.
async function registerOptions(s, headers, b) {
  const me = await currentUser(s, headers);
  let username, userHandle, userId = null, exclude = [];
  if (me) {
    username = me.username;
    [{ user_handle: userHandle }] = await s`select user_handle from users where id = ${me.id}`;
    userId = me.id;
    exclude = (await s`select credential_id, transports from passkeys where user_id = ${me.id}`)
      .map((p) => ({ id: p.credential_id, transports: p.transports }));
  } else {
    if (!signupCodeOk(b.signup_code)) throw new HttpError(403, '가입 코드가 맞지 않습니다');
    username = String(b.username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9]{3,20}$/.test(username)) throw new HttpError(400, '아이디는 영문 소문자·숫자 3~20자입니다');
    const [taken] = await s`select 1 from users where username = ${username}`;
    if (taken) throw new HttpError(409, '이미 쓰는 아이디입니다');
    userHandle = randomB64url(32);
  }
  const challenge = randomB64url(32);
  const [row] = await s`insert into challenges (challenge, purpose, user_id, username, user_handle, expires_at)
                        values (${challenge}, 'register', ${userId}, ${me ? null : username}, ${me ? null : userHandle}, ${challengeExpiry()})
                        returning id`;
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: username,
    userID: Buffer.from(userHandle, 'base64url'),
    challenge: Buffer.from(challenge, 'base64url'),
    timeout: 5 * 60 * 1000,
    attestationType: 'none', // 인증기 제조사 증명은 요청하지 않는다(개인 사이트라 필요 없음)
    excludeCredentials: exclude,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  return { challenge_id: row.id, options };
}

// 챌린지를 한 번만 쓰게 한다: 아직 안 썼고 만료 전인 행만 used_at을 채우고 돌려준다.
// 같은 챌린지로 두 번째 요청이 오면 update되는 행이 없어 거절된다.
async function useChallenge(s, id, purpose) {
  if (!/^\d{1,18}$/.test(String(id ?? ''))) throw new HttpError(400, '챌린지 번호가 올바르지 않습니다');
  const [c] = await s`update challenges set used_at = now()
                      where id = ${String(id)} and purpose = ${purpose} and used_at is null and expires_at > now()
                      returning *`;
  if (!c) throw new HttpError(400, '챌린지가 없거나, 이미 사용했거나, 만료되었습니다. 처음부터 다시 시도해 주세요');
  return c;
}

// 2단계: 인증기가 만든 등록 응답을 검증하고, 공개키와 공개 메타데이터만 저장한다.
async function registerVerify(s, headers, b) {
  const c = await useChallenge(s, b.challenge_id, 'register');
  const me = await currentUser(s, headers);
  if (c.user_id && (!me || me.id !== c.user_id)) throw new HttpError(403, '패스키를 추가하려던 계정으로 로그인되어 있지 않습니다');

  let v;
  try {
    v = await verifyRegistrationResponse({
      response: b.response,
      expectedChallenge: c.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
  } catch (e) {
    console.warn("register verify failed", e.message); // 자세한 사유는 서버 기록에만 남긴다
    throw new HttpError(400, "등록 응답 검증 실패");
  }
  if (!v.verified) throw new HttpError(400, '등록 응답 검증 실패');
  const info = v.registrationInfo;
  const cred = info.credential;

  return s.begin(async (t) => {
    let uid = c.user_id, setCookie = null, username;
    if (!uid) {
      const [u] = await t`insert into users (username, user_handle) values (${c.username}, ${c.user_handle}) returning id, username`;
      uid = u.id; username = u.username;
      setCookie = await startSession(t, uid); // 가입 직후 바로 로그인 상태로 둔다
    } else {
      username = me.username;
    }
    const names = (await t`select name from passkeys where user_id = ${uid}`).map((r) => r.name);
    const meta = { aaguid: info.aaguid, transports: cred.transports || [], backed_up: info.credentialBackedUp };
    const [p] = await t`insert into passkeys (user_id, credential_id, public_key, sign_count, transports, aaguid, device_type, backed_up, name)
                        values (${uid}, ${cred.id}, ${Buffer.from(cred.publicKey)}, ${cred.counter}, ${meta.transports},
                                ${info.aaguid}, ${info.credentialDeviceType}, ${info.credentialBackedUp}, ${autoName(meta, names)})
                        returning id, name, created_at`;
    return {
      status: 201,
      headers: setCookie ? { 'Set-Cookie': setCookie } : {},
      body: {
        user: { id: uid, username },
        passkey: {
          ...p,
          storage: storageLabel(meta),
          credential_id: cred.id,
          // 서버에 저장한 공개키(COSE)를 그대로 보여 준다. 공개키라 노출되어도 로그인에 쓸 수 없다.
          public_key_b64url: Buffer.from(cred.publicKey).toString('base64url'),
        },
      },
    };
  });
}

// 등록·로그인을 중간에 취소하면 보관하던 챌린지를 지운다(등록이면 계정·패스키는 애초에 만들어지지 않았다).
async function cancelChallenge(s, b, purpose) {
  if (!/^\d{1,18}$/.test(String(b.challenge_id ?? ''))) throw new HttpError(400, '챌린지 번호가 올바르지 않습니다');
  await s`delete from challenges where id = ${String(b.challenge_id)} and purpose = ${purpose} and used_at is null`;
  return { status: 200, body: { cancelled: true } };
}

// ---------- 패스키 로그인 ----------
// 1단계: 로그인할 때마다 새 챌린지를 만들어 DB에 보관한다. 아이디를 받지 않는다(allowCredentials 비움 →
// 기기가 이 사이트에 저장된 패스키를 보여 준다). 그래서 응답으로 아이디 존재 여부가 드러나지 않는다.
async function loginOptions(s) {
  const challenge = randomB64url(32);
  const [row] = await s`insert into challenges (challenge, purpose, expires_at)
                        values (${challenge}, 'login', ${challengeExpiry()}) returning id`;
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    challenge: Buffer.from(challenge, 'base64url'),
    timeout: 5 * 60 * 1000,
    userVerification: 'required',
    allowCredentials: [],
  });
  return { challenge_id: row.id, options };
}

// 2단계: 인증기가 챌린지에 개인키로 서명한 값을, 등록 때 저장한 공개키로 검증한다.
// 검증에 성공해야만 세션을 만든다. 실패 사유가 무엇이든 세션은 만들지 않는다.
async function loginVerify(s, b) {
  const c = await useChallenge(s, b.challenge_id, 'login'); // 이미 쓴 챌린지·만료된 챌린지는 여기서 거절
  const r = b.response;
  if (!r || typeof r.id !== 'string') throw new HttpError(400, '로그인 응답 형식이 올바르지 않습니다');
  const [pk] = await s`select p.*, u.username, u.user_handle from passkeys p join users u on u.id = p.user_id
                       where p.credential_id = ${r.id}`;
  // 삭제된 패스키·다른 사이트의 패스키는 DB에 없으므로 여기서 거절된다
  if (!pk) throw new HttpError(401, '등록되지 않은 패스키입니다');
  if (r.response?.userHandle && r.response.userHandle !== pk.user_handle) {
    throw new HttpError(401, '패스키와 계정 정보가 맞지 않습니다');
  }
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: r,
      expectedChallenge: c.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: { id: pk.credential_id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.sign_count), transports: pk.transports },
    });
  } catch (e) {
    console.warn("login verify failed", e.message); // 자세한 사유는 서버 기록에만 남긴다
    throw new HttpError(401, "서명 검증 실패");
  }
  if (!v.verified) throw new HttpError(401, '서명 검증 실패');
  const a = v.authenticationInfo;
  await s`update passkeys set sign_count = ${a.newCounter}, last_used_at = now(), backed_up = ${a.credentialBackedUp}
          where id = ${pk.id}`;
  const cookie = await startSession(s, pk.user_id);
  return {
    status: 200,
    headers: { 'Set-Cookie': cookie },
    body: { user: { id: pk.user_id, username: pk.username }, passkey: { id: pk.id, name: pk.name } },
  };
}

// ---------- 패스키 삭제 ----------
// 내 패스키만 지울 수 있다(남의 패스키 번호를 보내면 내 목록에 없으므로 404).
// 마지막 하나는 지우지 않는다(409) → 본인이 실수로 계정에서 잠기는 일을 막는다.
// 지운 뒤에는 지금 쓰는 세션만 남기고 이 계정의 다른 세션을 모두 끊는다(잃어버린 기기에 남은 로그인 차단).
async function deletePasskey(s, headers, me, idText) {
  if (!/^\d{1,18}$/.test(idText)) throw new HttpError(400, '패스키 번호가 올바르지 않습니다');
  const current = tokenHash(readCookie(headers?.cookie, SESSION_COOKIE) || '');
  return s.begin(async (t) => {
    // 같은 계정의 패스키 행을 잠가, 두 요청이 동시에 와서 마지막 두 개를 함께 지우는 일을 막는다
    const mine = await t`select id, name from passkeys where user_id = ${me.id} order by id for update`;
    const target = mine.find((p) => p.id === idText);
    if (!target) throw new HttpError(404, '내 패스키 목록에 없는 패스키입니다');
    if (mine.length <= 1) throw new HttpError(409, '마지막 남은 패스키는 지울 수 없습니다. 다른 패스키를 먼저 추가해 주세요');
    await t`delete from passkeys where id = ${target.id} and user_id = ${me.id}`;
    const ended = await t`delete from sessions where user_id = ${me.id} and token_hash <> ${current} returning token_hash`;
    return { status: 200, body: { deleted: target, remaining: mine.length - 1, other_sessions_ended: ended.length } };
  });
}

async function listPasskeys(s, uid) {
  const rows = await s`select id, name, aaguid, transports, device_type, backed_up, created_at, last_used_at
                       from passkeys where user_id = ${uid} order by created_at, id`;
  return rows.map((r) => ({ ...r, storage: storageLabel(r) }));
}

async function handle(req, s) {
  const { method, path, body, headers } = req;
  const p = path.replace(/\/+$/, '');

  if (method === 'GET' && p === 'health') {
    const [r] = await s`select current_user as db_role, current_schema() as db_schema`;
    return { status: 200, body: { ok: true, ...r } };
  }

  if (method === 'GET' && p === 'me') {
    const u = await currentUser(s, headers);
    return u ? { status: 200, body: { user: u } } : { status: 401, body: { error: '로그인하지 않았습니다' } };
  }

  if (method === 'GET' && p === 'private') {
    const u = await requireUser(s, headers);
    return { status: 200, body: { user: u, notes: await listNotes(s, u.id) } };
  }

  const one = p.match(/^private\/notes\/([^/]+)$/);
  if (method === 'GET' && one) {
    const u = await requireUser(s, headers);
    return { status: 200, body: { user: u, note: await getNote(s, u.id, one[1]) } };
  }

  if (method === 'POST' && (p === 'private/notes' || p === 'private/retros')) {
    const u = await requireUser(s, headers);
    return { status: 201, body: { note: await addNote(s, u.id, body || {}, p === 'private/retros' ? 'retro' : null) } };
  }

  if (method === 'POST' && p === 'register/options') return { status: 200, body: await registerOptions(s, headers, body || {}) };
  if (method === 'POST' && p === 'register/verify') return registerVerify(s, headers, body || {});
  if (method === 'POST' && p === 'register/cancel') return cancelChallenge(s, body || {}, 'register');
  if (method === 'POST' && p === 'login/options') return { status: 200, body: await loginOptions(s) };
  if (method === 'POST' && p === 'login/verify') return loginVerify(s, body || {});
  if (method === 'POST' && p === 'login/cancel') return cancelChallenge(s, body || {}, 'login');

  // 로그아웃: 세션 행을 지워 같은 쿠키 값을 다시 보내도 통하지 않게 하고, 쿠키도 지운다.
  if (method === 'POST' && p === 'logout') {
    const token = readCookie(headers?.cookie, SESSION_COOKIE);
    if (token) await s`delete from sessions where token_hash = ${tokenHash(token)}`;
    return { status: 200, headers: { 'Set-Cookie': clearCookie() }, body: { logged_out: true } };
  }

  const del = p.match(/^passkeys\/([^/]+)$/);
  if (method === 'DELETE' && del) {
    const u = await requireUser(s, headers);
    return deletePasskey(s, headers, u, del[1]);
  }

  if (method === 'GET' && p === 'passkeys') {
    const u = await requireUser(s, headers);
    return { status: 200, body: { passkeys: await listPasskeys(s, u.id) } };
  }

  throw new HttpError(404, '없는 주소입니다');
}

export async function respond(req) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  let s = null;
  try {
    s = openDb();
    const r = await handle(req, s);
    return { status: r.status, headers: { ...headers, ...(r.headers || {}) }, body: JSON.stringify(r.body) };
  } catch (e) {
    const status = e instanceof HttpError ? e.status
      : ['22P02', '23514'].includes(e.code) ? 400 : e.code === '23505' ? 409 : 500;
    const message = e instanceof HttpError ? e.message
      : status === 400 ? '입력값이 올바르지 않습니다' : status === 409 ? '이미 있는 값입니다' : '서버 오류가 발생했습니다';
    if (status === 500) console.error('server error', e.code || '', e.message);
    return { status, headers, body: JSON.stringify({ error: message }) };
  } finally {
    if (s) await s.end({ timeout: 5 }).catch(() => {});
  }
}
