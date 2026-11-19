// T08 비공개 영역 화면. 비공개 내용은 이 파일과 index.html에 없고, 로그인한 뒤 서버에서만 받아 온다.
// 받아 온 글은 textContent로만 넣는다(HTML로 해석하지 않음).
const KINDS = [
  ['retro', '개인 회고'],
  ['project', '프로젝트 메모'],
  ['apply', '지원할 곳'],
];

const $ = (id) => document.getElementById(id);

function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}

async function api(path, options = {}) {
  const res = await fetch('/api/' + path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  return { status: res.status, data };
}

// ---------- WebAuthn 값 변환 (서버는 base64url 문자열, 브라우저 API는 바이트) ----------
const b64urlToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const bytesToB64url = (buf) => {
  let s = '';
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function creationOptions(o) {
  return {
    ...o,
    challenge: b64urlToBytes(o.challenge),
    user: { ...o.user, id: b64urlToBytes(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBytes(c.id) })),
  };
}

// 인증기가 돌려준 등록 응답. 개인키는 들어 있지 않다:
// clientDataJSON(챌린지·출처) + attestationObject(인증기 데이터 안의 공개키) + 자격 증명 ID뿐이다.
function registrationJSON(cred) {
  const r = cred.response;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      attestationObject: bytesToB64url(r.attestationObject),
      transports: r.getTransports ? r.getTransports() : [],
    },
  };
}

// 등록 전체 흐름: 서버 챌린지 받기 → 인증기에서 키 쌍 만들기 → 서버 검증
async function registerPasskey(extra, msgEl) {
  if (!window.PublicKeyCredential) {
    msgEl.textContent = '이 브라우저는 패스키를 지원하지 않습니다.';
    return null;
  }
  msgEl.textContent = '서버에서 챌린지를 받는 중…';
  const opt = await api('register/options', { method: 'POST', body: JSON.stringify(extra) });
  if (opt.status !== 200) {
    msgEl.textContent = opt.data.error || '등록을 시작하지 못했습니다.';
    return null;
  }
  let cred;
  try {
    msgEl.textContent = '기기의 패스키 창에서 확인해 주세요…';
    cred = await navigator.credentials.create({ publicKey: creationOptions(opt.data.options) });
  } catch (e) {
    // 사용자가 창을 닫거나 취소하면 NotAllowedError. 보관하던 챌린지를 지우고 아무것도 저장하지 않는다.
    await api('register/cancel', { method: 'POST', body: JSON.stringify({ challenge_id: opt.data.challenge_id }) });
    msgEl.textContent = e.name === 'InvalidStateError'
      ? '이 인증기에는 이미 이 계정의 패스키가 있습니다. 다른 기기(예: 휴대폰 QR)로 등록해 주세요. 저장된 것은 없습니다.'
      : '패스키 등록을 취소했습니다. 서버에는 아무것도 저장되지 않았습니다.';
    return null;
  }
  msgEl.textContent = '서버에서 검증하는 중…';
  const ver = await api('register/verify', {
    method: 'POST',
    body: JSON.stringify({ challenge_id: opt.data.challenge_id, response: registrationJSON(cred) }),
  });
  if (ver.status !== 201) {
    msgEl.textContent = ver.data.error || '등록에 실패했습니다.';
    return null;
  }
  msgEl.textContent = `패스키를 등록했습니다: ${ver.data.passkey.name}`;
  return ver.data;
}

// 인증기가 돌려준 로그인 응답: 서버 챌린지에 대한 서명과 그 서명에 쓰인 데이터. 개인키는 들어 있지 않다.
function assertionJSON(cred) {
  const r = cred.response;
  return {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: bytesToB64url(r.clientDataJSON),
      authenticatorData: bytesToB64url(r.authenticatorData),
      signature: bytesToB64url(r.signature),
      userHandle: r.userHandle ? bytesToB64url(r.userHandle) : undefined,
    },
  };
}

// 로그인 흐름: 서버가 새 챌린지 발급 → 인증기가 개인키로 서명 → 서버가 저장된 공개키로 서명 검증
async function loginWithPasskey() {
  const msg = $('loginMsg');
  if (!window.PublicKeyCredential) { msg.textContent = '이 브라우저는 패스키를 지원하지 않습니다.'; return; }
  msg.textContent = '서버에서 챌린지를 받는 중…';
  const opt = await api('login/options', { method: 'POST', body: '{}' });
  if (opt.status !== 200) { msg.textContent = opt.data.error || '로그인을 시작하지 못했습니다.'; return; }
  const o = opt.data.options;
  let cred;
  try {
    msg.textContent = '기기의 패스키 창에서 확인해 주세요…';
    cred = await navigator.credentials.get({
      publicKey: { ...o, challenge: b64urlToBytes(o.challenge), allowCredentials: [] },
    });
  } catch {
    await api('login/cancel', { method: 'POST', body: JSON.stringify({ challenge_id: opt.data.challenge_id }) });
    msg.textContent = '로그인을 취소했습니다.';
    return;
  }
  msg.textContent = '서버에서 서명을 검증하는 중…';
  const ver = await api('login/verify', {
    method: 'POST',
    body: JSON.stringify({ challenge_id: opt.data.challenge_id, response: assertionJSON(cred) }),
  });
  if (ver.status !== 200) { msg.textContent = ver.data.error || '로그인에 실패했습니다.'; return; }
  msg.textContent = '';
  loadPrivate();
}

async function loadPasskeys() {
  const { status, data } = await api('passkeys');
  const ul = $('passkeyList');
  if (status !== 200) return ul.replaceChildren(el('li', '패스키 목록을 불러오지 못했습니다.'));
  const only = data.passkeys.length === 1;
  ul.replaceChildren(...data.passkeys.map((p) => {
    const li = el('li');
    const info = el('div');
    info.append(
      el('strong', p.name),
      el('span', `등록 ${new Date(p.created_at).toLocaleString('ko-KR')}` +
        (p.last_used_at ? ` · 마지막 사용 ${new Date(p.last_used_at).toLocaleString('ko-KR')}` : '')),
    );
    li.append(info, deleteButton(p, only));
    return li;
  }));
  if (!data.passkeys.length) ul.append(el('li', '등록된 패스키가 없습니다.'));
  $('passkeyHint').textContent = only
    ? '패스키가 하나뿐입니다. 이 기기를 잃어버리면 로그인할 수 없으니 다른 기기(예: 휴대폰)에 패스키를 하나 더 추가해 두세요. 마지막 패스키는 지울 수 없습니다.'
    : `패스키 ${data.passkeys.length}개. 하나를 지워도 남은 패스키로 로그인할 수 있습니다.`;
}

// 삭제는 두 번 눌러야 한다(첫 클릭 → "정말 삭제" 확인). 브라우저 confirm 창 대신 화면 안에서 확인한다.
function deleteButton(p, only) {
  const b = el('button', '삭제');
  b.type = 'button';
  b.className = 'button secondary small passkey-delete';
  if (only) { b.disabled = true; b.title = '마지막 남은 패스키는 지울 수 없습니다'; return b; }
  let armed = false;
  b.addEventListener('click', async () => {
    if (!armed) { armed = true; b.textContent = '정말 삭제'; b.classList.add('armed'); return; }
    b.disabled = true;
    const res = await fetch(`/api/passkeys/${encodeURIComponent(p.id)}`, { method: 'DELETE', credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    $('passkeyMsg').textContent = res.ok
      ? `"${p.name}" 패스키를 지웠습니다. 다른 기기의 로그인 ${data.other_sessions_ended}개를 끊었습니다. 이 패스키로는 더 이상 로그인할 수 없습니다.`
      : (data.error || '지우지 못했습니다.');
    loadPasskeys();
  });
  return b;
}

function showLocked(message) {
  $('privateContent').hidden = true;
  $('privateLists').replaceChildren();
  $('privateLocked').hidden = false;
  $('privateStatus').textContent = message;
}

function renderNotes(user, notes) {
  $('privateLocked').hidden = true;
  $('privateContent').hidden = false;
  $('privateUser').textContent = `${user.username} 계정으로 로그인했습니다.`;
  const groups = KINDS.map(([kind, label]) => {
    const box = el('div');
    box.className = 'private-group';
    const items = notes.filter((n) => n.kind === kind);
    box.append(el('h3', `${label} (${items.length})`));
    const ul = el('ul');
    for (const n of items) {
      const li = el('li');
      const time = el('time', new Date(n.created_at).toLocaleDateString('ko-KR'));
      time.dateTime = n.created_at;
      li.append(el('strong', n.title), el('p', n.body), time);
      ul.append(li);
    }
    if (!items.length) ul.append(el('li', '아직 없습니다.'));
    box.append(ul);
    return box;
  });
  $('privateLists').replaceChildren(...groups);
  loadPasskeys();
}

async function loadPrivate() {
  try {
    const { status, data } = await api('private');
    if (status === 200) return renderNotes(data.user, data.notes);
    if (status === 401) return showLocked('🔒 잠겨 있습니다. 패스키로 로그인하면 비공개 내용이 보입니다.');
    showLocked(data.error || '비공개 내용을 불러오지 못했습니다.');
  } catch {
    showLocked('서버에 연결하지 못했습니다.');
  }
}

$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const done = await registerPasskey(
    { username: f.username.value.trim().toLowerCase(), signup_code: f.signup_code.value },
    $('signupMsg'),
  );
  if (done) { f.reset(); loadPrivate(); }
});

$('loginButton').addEventListener('click', loginWithPasskey);

$('addPasskeyButton').addEventListener('click', async () => {
  const done = await registerPasskey({}, $('passkeyMsg'));
  if (done) loadPasskeys();
});

$('logoutButton').addEventListener('click', async () => {
  await api('logout', { method: 'POST' });
  showLocked('로그아웃했습니다.');
});

$('retroForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const msg = $('retroMsg');
  msg.textContent = '저장 중…';
  const { status, data } = await api('private/notes', {
    method: 'POST',
    body: JSON.stringify({ kind: f.kind.value, title: f.title.value, body: f.body.value }),
  });
  if (status === 201) {
    f.reset();
    msg.textContent = '저장했습니다.';
    loadPrivate();
  } else if (status === 401) {
    msg.textContent = '';
    showLocked('로그인이 끝났습니다. 다시 패스키로 로그인해 주세요.');
  } else {
    msg.textContent = data.error || '저장하지 못했습니다.';
  }
});

loadPrivate();
