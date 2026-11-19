// T08 거절·통과 증거 기록 도우미 — 배포 사이트(https://skt-aleph-task8.vercel.app) 탭의 개발자 도구 콘솔에 통째로 붙여 넣는다.
// 요청과 응답을 한 줄씩 표로 남긴다. 로그인 쿠키(sid)는 HttpOnly라서 이 코드로는 읽을 수도, 표에 찍힐 수도 없다.
// 사용: t08.noLogin() / t08.login('설명') / t08.mine() / t08.cross(남의글번호, 남의계정번호) / t08.replay() / t08.logout() / t08.show()
(() => {
  const log = (window.t08log = window.t08log || []);
  const short = (v) => { const s = JSON.stringify(v) ?? ''; return s.length > 180 ? s.slice(0, 180) + '…' : s; };
  const u2b = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const b2u = (buf) => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

  async function call(label, method, path, body) {
    const res = await fetch('/api/' + path, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    // 서명 응답 본문은 길어서 앞부분만 남긴다(개인키는 애초에 들어 있지 않다).
    const shown = body?.response ? { challenge_id: body.challenge_id, response: { id: body.response.id, '…': '서명 데이터' } } : body;
    log.push({
      시각: new Date().toLocaleTimeString('ko-KR'), 확인: label,
      요청: `${method} /api/${path}` + (shown ? ' ' + short(shown) : ''),
      상태: res.status, 응답: short(data),
    });
    console.table(log.slice(-1));
    return { status: res.status, data };
  }

  // 패스키 로그인 한 번: 옵션(챌린지) → 기기에서 서명 → 서버 검증. 검증에 보낸 본문을 돌려줘서 재사용 시험에 쓴다.
  async function login(label = '패스키 로그인') {
    const opt = await call(label + ' ① 챌린지 받기', 'POST', 'login/options', {});
    const o = opt.data.options;
    let cred;
    try {
      cred = await navigator.credentials.get({ publicKey: { ...o, challenge: u2b(o.challenge), allowCredentials: [] } });
    } catch (e) {
      await call(label + ' (기기 창 취소)', 'POST', 'login/cancel', { challenge_id: opt.data.challenge_id });
      return null;
    }
    const r = cred.response;
    const body = {
      challenge_id: opt.data.challenge_id,
      response: {
        id: cred.id, rawId: b2u(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: b2u(r.clientDataJSON), authenticatorData: b2u(r.authenticatorData),
          signature: b2u(r.signature), userHandle: r.userHandle ? b2u(r.userHandle) : undefined,
        },
      },
    };
    await call(label + ' ② 서명 검증', 'POST', 'login/verify', body);
    return body;
  }

  window.t08 = {
    call, login,
    show: () => console.table(log),

    // 로그인하지 않은 상태에서 비공개 주소를 직접 요청 → 모두 401이어야 한다.
    async noLogin() {
      await call('로그인 없이: 비공개 목록', 'GET', 'private');
      await call('로그인 없이: 항목 1건', 'GET', 'private/notes/1');
      await call('로그인 없이: 패스키 목록', 'GET', 'passkeys');
      await call('로그인 없이: 항목 추가', 'POST', 'private/notes', { kind: 'retro', title: '무단 추가 시도', body: 'x' });
    },

    // 로그인한 계정의 자료(통과 쪽 기록). 항목 번호와 건수를 확인한다.
    async mine() {
      const r = await call('내 자료 조회(통과)', 'GET', 'private');
      if (r.status === 200) {
        console.log(`${r.data.user.username}: 항목 ${r.data.notes.length}건, 번호`, r.data.notes.map((n) => n.id));
        if (r.data.notes[0]) await call('내 항목 1건 조회(통과)', 'GET', `private/notes/${r.data.notes[0].id}`);
      }
      return r;
    },

    // 남의 자료 요청: 남의 글 번호로 1건 조회(→404), 주소에 남의 계정을 적어 목록 조회(→내 자료만).
    async cross(otherNoteId, otherUserId) {
      await call('남의 글 번호로 1건 조회', 'GET', `private/notes/${otherNoteId}`);
      const r = await call('주소에 남의 계정을 적어 목록 조회', 'GET', `private?user_id=${otherUserId}&username=other`);
      if (r.status === 200) console.log(`돌아온 계정: ${r.data.user.username} (id ${r.data.user.id}) — 요청에 적은 id ${otherUserId}가 아님`);
    },

    // 챌린지 재사용: 정상 로그인 한 번(→200) 뒤, 똑같은 검증 본문을 다시 보낸다(→400).
    async replay() {
      const body = await login('재사용 시험: 정상 로그인');
      if (body) await call('재사용 시험: 같은 챌린지·서명 다시 보내기', 'POST', 'login/verify', body);
    },

    logout: () => call('로그아웃', 'POST', 'logout'),
  };
  console.log('T08 기록 도우미 준비 완료. 먼저 t08.noLogin() 부터 실행하세요.');
})();
