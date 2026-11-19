# T08 접근 차단 확인 기록

- 대상: https://skt-aleph-task8.vercel.app (배포 사이트, 커밋 eff5475)
- 일시: 2026-11-19 오후 2:37–2:41 (KST)
- 방법: Edge 개발자 도구 콘솔에서 [scripts/console-evidence.js](../scripts/console-evidence.js)를 실행해 요청·응답을 그대로 남겼습니다. 실제 계정 testa(번호 1)와 testb(번호 2), 실제 패스키를 썼습니다.
- 쿠키: 로그인 쿠키 `sid`는 HttpOnly라서 페이지 코드로 읽을 수 없습니다. 그래서 이 기록에는 쿠키 값이 들어 있지 않습니다.
  - 서버 DB에는 쿠키 값 자체가 아니라 SHA-256 해시만 저장합니다.
- 응답 본문은 길이를 줄였습니다(`…`). 메모 내용은 모두 만들어 넣은 가상의 내용입니다.
- 서명 응답은 패스키 ID만 남겼습니다. 개인키는 애초에 브라우저 밖으로 나오지 않습니다.

## 1. 로그인 없이 열기

| | 요청 | 상태 | 응답 |
|---|---|---|---|
| 거절 | `GET /api/private` | **401** | 패스키로 로그인해야 볼 수 있습니다 |
| 거절 | `GET /api/private/notes/1` | **401** | 〃 |
| 거절 | `GET /api/passkeys` | **401** | 〃 |
| 거절 | `POST /api/private/notes` `{"kind":"retro","title":"무단 추가 시도",…}` | **401** | 〃 |
| 통과 | (testa 패스키 로그인 뒤) `GET /api/private` | **200** | `{"user":{"id":"1","username":"testa"},"notes":[…3건]}` |

## 2. 남의 패스키(계정)로 열기 — 양방향

**testa로 로그인해서 testb 자료 요청**

| | 요청 | 상태 | 응답 |
|---|---|---|---|
| 통과 | `GET /api/private/notes/3` (testa 자기 글) | **200** | `{"user":{"id":"1","username":"testa"},"note":{"id":"3",…}}` |
| 거절 | `GET /api/private/notes/4` (testb 글) | **404** | 내 비공개 항목 중에 그 번호가 없습니다 |
| 무시 | `GET /api/private?user_id=2&username=other` | 200 | `{"user":{"id":"1","username":"testa"},…}` — 주소에 적은 2번이 아니라 testa 자료만 |

**testb로 로그인해서 testa 자료 요청(반대 방향)**

| | 요청 | 상태 | 응답 |
|---|---|---|---|
| 통과 | `GET /api/private/notes/6` (testb 자기 글) | **200** | `{"user":{"id":"2","username":"testb"},"note":{"id":"6",…}}` |
| 거절 | `GET /api/private/notes/1` (testa 글) | **404** | 내 비공개 항목 중에 그 번호가 없습니다 |
| 무시 | `GET /api/private?user_id=1&username=other` | 200 | `{"user":{"id":"2","username":"testb"},…}` — testb 자료만 |

**거절 앞뒤 건수** (서버 DB `t08.notes`, Supabase SQL 편집기에서 조회)

| 계정 | 기록 전 (2:37 이전) | 기록 후 (2:41 이후) | 패스키 앞 → 뒤 |
|---|---|---|---|
| testa | 3건 (번호 1, 2, 3) | 3건 (번호 1, 2, 3) | 1 → 1 |
| testb | 3건 (번호 4, 5, 6) | 3건 (번호 4, 5, 6) | 1 → 1 |

남의 글 번호와 없는 번호는 똑같은 404를 돌려줍니다. 그래서 그 번호의 글이 존재하는지도 알 수 없습니다.

## 3. 사용한 챌린지 재사용

| | 요청 | 상태 | 응답 |
|---|---|---|---|
| 통과 | `POST /api/login/options` | 200 | `challenge_id 15`, 새 챌린지 |
| 통과 | `POST /api/login/verify` `{"challenge_id":"15",…서명}` | **200** | `{"user":{"id":"1","username":"testa"},…}` |
| 거절 | 위와 **똑같은 본문**을 다시 `POST /api/login/verify` | **400** | 챌린지가 없거나, 이미 사용했거나, 만료되었습니다 |

## 4. 패스키 삭제 뒤 로그인

testa에는 패스키가 2개 있었습니다. 2:11에 Windows Hello 패스키를 추가했습니다.
- Microsoft 비밀번호 관리자 · 동기화됨
- Windows Hello · 이 기기에만 저장

그중 Windows Hello를 화면에서 삭제했습니다. 화면 기록은 캡처로 남겼습니다.

| | 요청 | 상태 | 응답 |
|---|---|---|---|
| 거절 | Windows Hello 선택 → `POST /api/login/verify` (패스키 ID `m5cxf7bf…`) | **401** | 등록되지 않은 패스키입니다 |
| 통과 | Microsoft 비밀번호 관리자 선택 → `POST /api/login/verify` (패스키 ID `3f8QQ_4h…`) | **200** | `{"user":{"id":"1","username":"testa"},"passkey":{"id":"1",…}}` |

서버에서 지워도 Windows Hello 안의 키는 남아 있어서, 로그인 창의 선택지에는 계속 나옵니다. 하지만 서버에 공개키가 없으므로 서명 검증까지 가지 못하고 거절됩니다.

마지막 남은 패스키는 지울 수 없습니다.
- 화면: 패스키가 1개뿐이면 삭제 버튼이 비활성화되고 안내 문구가 나옵니다.
- 서버: 직접 요청해도 409 "마지막 남은 패스키는 지울 수 없습니다"로 거절합니다.

## 거절을 만드는 소스 위치

| 확인 | 위치 |
|---|---|
| 로그인 없이 → 401 | [lib/handler.mjs:50](../lib/handler.mjs) `requireUser` — 쿠키의 토큰 해시로 만료 전 세션을 찾지 못하면 401 |
| 남의 글 번호 → 404 | [lib/handler.mjs:64](../lib/handler.mjs) `getNote` — `where id = … and user_id = <세션의 계정>` |
| 주소·본문의 계정 무시 | [lib/handler.mjs:58](../lib/handler.mjs) `listNotes` — 계정은 세션에서만 정함, 요청 값은 쓰지 않음 |
| 챌린지 재사용 → 400 | [lib/handler.mjs:133](../lib/handler.mjs) `useChallenge` — `update … set used_at = now() where … used_at is null and expires_at > now() returning` (한 번만 성공) |
| 지운 패스키 → 401 | [lib/handler.mjs:230](../lib/handler.mjs) `loginVerify` — `credential_id`가 DB에 없으면 401 |
| 마지막 패스키 → 409, 남의 패스키 → 404 | [lib/handler.mjs:264](../lib/handler.mjs) `deletePasskey` |

같은 확인을 자동으로 반복하는 로컬 테스트도 있습니다. `scripts/test-*.mjs` 4개, 모두 58개 항목이 통과합니다.
