# 인증 구현 설명서 (T08)

- 결과물: https://skt-aleph-task8.vercel.app (맨 아래 「🔒 Private」)
- 소스: https://github.com/few0579-a11y/SKT-Aleph-task8
- 확인 기록: [docs/EVIDENCE.md](EVIDENCE.md)

비공개 영역의 내용(회고·프로젝트 메모·지원할 곳)은 모두 직접 만들어 넣은 가상의 내용입니다.
위쪽 공개 소개 페이지는 1번 과제(커밋 `2a1ee4a`) 그대로입니다.

---

## ① 무엇으로 붙였나

**라이브러리 + 직접 구현**입니다. 인증 서비스(Auth0, Supabase Auth, Clerk 등)는 쓰지 않았습니다.

| 부분 | 무엇으로 |
|---|---|
| 등록·로그인 응답 검증 (CBOR 해석, 공개키 추출, 서명 확인, 출처·RP ID 확인) | **`@simplewebauthn/server` 14.0.3** (버전 고정) |
| 브라우저 쪽 | 브라우저 기본 WebAuthn API(`navigator.credentials.create/get`)를 직접 호출. 클라이언트 라이브러리 없음 |
| 챌린지 생성·DB 보관·1회 사용·만료(5분) | 직접 작성 (`lib/handler.mjs`, `lib/webauthn.mjs`) |
| 계정·패스키·세션·권한 확인 | 직접 작성 (`lib/handler.mjs`, `lib/session.mjs`) |
| 서버·DB | Vercel 서버 함수(icn1) + Supabase Postgres의 `t08` 스키마, 전용 역할 `t08_app` |

설정
- `residentKey: required`: 아이디 입력 없이 패스키만으로 로그인합니다.
- `userVerification: required`: 기기에서 PIN·얼굴·지문 확인이 필요합니다.
- `attestation: none`.
- 비밀번호 칸은 어디에도 없습니다.

## ② 왜 그걸 골랐나

- **서명 검증은 라이브러리에 맡겼습니다.** CBOR·COSE 키 형식과 서명 알고리즘(ES256, RS256 등)을 직접 해석하면 실수가 보안 구멍이 됩니다. `@simplewebauthn/server`는 WebAuthn 명세를 따르는 널리 쓰이는 서버 라이브러리입니다. 버전을 고정해서 업데이트로 동작이 바뀌지 않게 했습니다.
- **챌린지·세션·권한은 직접 짰습니다.** 이번 과제에서 가장 중요한 부분이 "챌린지를 서버가 보관하고 한 번만 쓰게 하기"와 "남의 자료는 열리지 않기"입니다. 이 부분은 눈으로 확인하고 설명할 수 있어야 해서 라이브러리에 숨기지 않았습니다.
  - 7번 과제(로그인 일기)에서 쓴 세션 방식을 이어서 썼습니다. 무작위 토큰을 HttpOnly 쿠키에 넣고, DB에는 SHA-256 해시만 저장합니다.
- **인증 서비스는 쓰지 않았습니다.** 외부 서비스를 붙이면 화면은 금방 되지만, 챌린지가 어디에 저장되고 언제 지워지는지가 서비스 안에 가려져 ④ 기록을 내 코드로 설명할 수 없습니다.
- **7번 과제와 분리했습니다.** 7번이 심사 중이라 그 저장소·배포·DB를 건드리지 않으려고 새 저장소, 새 Vercel 프로젝트, 같은 Supabase 안의 새 스키마·역할로 나눴습니다.
## ③ 어디를 어떻게 고쳤나

**바꾼 파일**
- 1번 페이지(`index.html`)를 `public/`으로 옮겼습니다. 공개 부분 내용·스타일·스크립트는 그대로 두고, 아래 세 가지만 추가했습니다.
  - 메뉴 「🔒 Private」
  - "여기까지 공개 · 여기부터 비공개" 경계
  - 잠긴 비공개 영역 틀 (비공개 내용은 HTML에 없음)
- 새 파일: `public/private.js`·`private.css`(화면), `lib/`(서버), `api/router.js`(Vercel 진입점), `db/*.sql`(스키마·권한), `scripts/`(자동 테스트).

**네 흐름이 지나는 곳**

### 등록 (가입 / 패스키 추가)
1. 화면: [public/private.js:67](../public/private.js) `registerPasskey` → `POST /api/register/options`
2. 서버: [lib/handler.mjs:96](../lib/handler.mjs) `registerOptions`
   - 새 가입: 가입 코드 확인([lib/webauthn.mjs:17](../lib/webauthn.mjs)), 아이디 형식과 중복 확인
   - 추가: 로그인 세션 확인, 이미 있는 패스키를 `excludeCredentials`로 전달
   - 32바이트 무작위 챌린지를 `challenges` 테이블에 5분 기한으로 저장
3. 브라우저: `navigator.credentials.create` — 기기가 키 쌍을 만들고 공개키만 돌려줍니다.
4. 화면 → `POST /api/register/verify` → [lib/handler.mjs:143](../lib/handler.mjs) `registerVerify`
   - [lib/handler.mjs:133](../lib/handler.mjs) `useChallenge`로 챌린지를 한 번만 꺼냅니다.
   - `verifyRegistrationResponse`로 챌린지·출처·RP ID·사용자 확인 여부를 검사합니다.
   - 공개키를 `passkeys.public_key`에 저장합니다. 새 가입이면 **이때 처음으로** 계정을 만듭니다.
5. 취소하면 `POST /api/register/cancel` → [lib/handler.mjs:198](../lib/handler.mjs) — 챌린지를 지우고 아무것도 남기지 않습니다.

### 로그인
1. 화면: [public/private.js:122](../public/private.js) `loginWithPasskey` → `POST /api/login/options`
2. 서버: [lib/handler.mjs:207](../lib/handler.mjs) `loginOptions` — 새 챌린지를 저장합니다. `allowCredentials: []`라서 아이디를 묻지 않습니다.
3. 브라우저: `navigator.credentials.get` — 기기가 챌린지에 개인키로 서명합니다.
4. 화면 → `POST /api/login/verify` → [lib/handler.mjs:223](../lib/handler.mjs) `loginVerify`
   - 챌린지를 1회 사용 처리합니다.
   - 패스키 ID로 저장된 공개키를 찾습니다. 없으면 401입니다.
   - `userHandle`이 계정과 맞는지 확인합니다.
   - `verifyAuthenticationResponse`로 서명을 검증하고 사용 기록을 갱신합니다.
   - 세션을 만듭니다([lib/handler.mjs:86](../lib/handler.mjs) `startSession`, [lib/session.mjs](../lib/session.mjs)).
     - 쿠키 `sid`: HttpOnly, Secure, SameSite=Strict, 8시간
     - DB에는 토큰의 SHA-256 해시만 저장합니다.

### 로그아웃
- 화면: [public/private.js:252](../public/private.js) → `POST /api/logout`
- 서버: [lib/handler.mjs:323](../lib/handler.mjs) — 세션 행을 지우고 쿠키도 지웁니다.
  - 같은 쿠키 값을 다시 보내도 401입니다(자동 테스트 `test-login.mjs`).

### 비공개 자료 조회
- 화면: [public/private.js:224](../public/private.js) `loadPrivate` → `GET /api/private`
  - 받은 글은 `textContent`로만 넣습니다. HTML로 해석하지 않습니다.
- 서버: [lib/handler.mjs:299](../lib/handler.mjs) → [lib/handler.mjs:50](../lib/handler.mjs) `requireUser` → [lib/handler.mjs:58](../lib/handler.mjs) `listNotes`
  - 계정은 세션에서만 정합니다. 주소·본문에 적은 계정은 쓰지 않습니다.
- 1건 조회: `GET /api/private/notes/:id` → [lib/handler.mjs:64](../lib/handler.mjs) `getNote`
  - `id`와 세션 계정을 함께 조건으로 겁니다. 남의 글과 없는 글은 같은 404입니다.
- 추가: `POST /api/private/notes` → `addNote` (추가만 가능, 수정·삭제 없음)

**패스키 관리**
- 목록: `GET /api/passkeys`. 이름(저장 위치 자동 표시)과 등록·마지막 사용 날짜가 나옵니다.
- 삭제: `DELETE /api/passkeys/:id` → [lib/handler.mjs:264](../lib/handler.mjs)
  - 남의 패스키는 404입니다.
  - 마지막 하나는 409로 거절합니다.
  - 지우면 그 계정의 다른 로그인(세션)을 모두 끊습니다.

**보안 헤더** ([vercel.json](../vercel.json), 로컬 서버 `server.mjs`도 같은 값을 읽음)
- `Content-Security-Policy`
  - 스크립트: 이 사이트 파일 + 1번 인라인 스크립트(sha256 해시)만
  - 스타일: 이 사이트 + 1번 인라인 스타일(해시) + Google Fonts
  - 연결(`fetch`): 이 사이트만. `frame-ancestors 'none'`으로 다른 사이트에 끼워 넣기도 막음
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`

**DB 권한** ([db/t08-schema.sql](../db/t08-schema.sql))
- `t08_app` 역할은 `t08` 스키마만 쓸 수 있습니다. 7번 과제·`public` 스키마에는 권한이 없습니다.
- 비공개 글(`notes`)에는 조회·추가 권한만 줬습니다. 수정·삭제 권한은 없습니다.

## ④ 안 열리는 것을 확인한 기록

배포 사이트에서 실제 계정 testa·testb와 실제 패스키로 확인했습니다(2026-11-19 오후 2:37–2:41). 전체 요청·응답은 [EVIDENCE.md](EVIDENCE.md)에 있습니다.

| 확인 | 통과한 요청 | 거절된 요청 |
|---|---|---|
| 로그인 없이 열기 | 로그인 뒤 `GET /api/private` → **200** testa 3건 | 로그인 없이 `GET /api/private`, `GET /api/private/notes/1`, `GET /api/passkeys`, `POST /api/private/notes` → 모두 **401** |
| 남의 패스키로 열기 (testa→testb) | `GET /api/private/notes/3` (자기 글) → **200** | `GET /api/private/notes/4` (testb 글) → **404**. `GET /api/private?user_id=2` → testa 자료만 |
| 반대 방향 (testb→testa) | `GET /api/private/notes/6` (자기 글) → **200** | `GET /api/private/notes/1` (testa 글) → **404**. `GET /api/private?user_id=1` → testb 자료만 |
| 사용한 챌린지 재사용 | 챌린지 15번으로 `POST /api/login/verify` → **200** | 똑같은 본문을 다시 보냄 → **400** "이미 사용했거나 만료" |
| 패스키 삭제 뒤 로그인 | 남은 Microsoft 비밀번호 관리자 패스키 → **200** | 지운 Windows Hello 패스키 → **401** "등록되지 않은 패스키입니다" |

- 거절 앞뒤 건수: testa 3건 → 3건, testb 3건 → 3건(DB 조회).
- 패스키가 하나만 남으면 화면의 삭제 버튼이 꺼집니다. "마지막 패스키는 지울 수 없습니다"라는 안내가 나오고, 서버에 직접 요청해도 409로 거절합니다.
- 같은 확인을 반복하는 로컬 자동 테스트도 있습니다. `scripts/test-register|login|passkeys|notes.mjs`, 58개 항목이 모두 통과합니다.

## ⑤ AI와 나

**AI(Claude Code)에게 맡긴 일**
- 서버·화면·DB 코드 작성
- 자동 테스트 58개와 콘솔 기록 도우미 작성
- 확인 기록 정리, 설명서·제출문 초안 작성

**내가 직접 판단한 일**
- 비공개 영역 위치와 세 종류, 가입 코드 방식, 마지막 패스키 삭제 불가와 다른 로그인 끊기, 아이폰 대신 Windows Hello, 실제 기기 등록·로그인·삭제 확인, 비밀값은 직접 입력

**AI 제안을 따르지 않은 일**
- DB 역할 비밀번호를 16자 이상으로 하라는 제안을 따르지 않고 11자로 둠 (위험은 ⑥-4에 적음)

## ⑥ 아직 못 막은 것

1. **로그인 시작 요청에 횟수 제한이 없습니다.**
   - `POST /api/login/options`는 로그인 없이 누구나 부를 수 있고, 부를 때마다 `challenges` 테이블에 행이 하나씩 생깁니다.
   - 만료되거나 사용한 챌린지를 지우는 작업도 아직 없습니다.
   - 누가 자동으로 수없이 호출하면 DB가 계속 커지고(무료 용량 500MB), 서버 함수 실행량도 늘어납니다.
   - 가입 코드 입력(`register/options`)도 틀린 횟수 제한이 없어서, 이론상 계속 대입해 볼 수 있습니다.
   - 막으려면: IP별 요청 제한, 오래된 챌린지 주기적 삭제.
2. **동기화 패스키는 복제 탐지가 안 됩니다.**
   - Microsoft 비밀번호 관리자 패스키는 서명 횟수(sign_count)를 항상 0으로 보냅니다.
   - 그래서 키가 복제되어 다른 곳에서 쓰여도 서버가 횟수 차이로 알아챌 수 없습니다.
3. **서버에서 지운 패스키가 기기에는 남습니다.**
   - Windows Hello 패스키를 화면에서 지워도 기기 안의 키는 그대로라서, 로그인 창 선택지에 계속 나옵니다. 고르면 401로 거절되지만, 사용자는 혼란스러울 수 있습니다.
   - 사용자가 Windows 설정에서 직접 지워야 합니다. 브라우저에 삭제를 알려 주는 기능(WebAuthn Signal API)은 쓰지 않았습니다.
4. **DB 역할 비밀번호가 11자입니다.**
   - `t08_app` 비밀번호는 영문 소문자·숫자 11자로, 권장(16자 이상)보다 짧습니다.
   - 작업 중 한 번은 이전 비밀번호를 터미널에 잘못 입력해 화면에 노출됐습니다. 즉시 새 비밀번호로 바꿔서 그 값은 더는 쓸 수 없습니다.
5. **CSP는 걸었지만 Google Fonts 서버를 믿고 있습니다.**
   - `vercel.json`의 CSP는 스크립트를 이 사이트 파일과 1번 페이지 인라인 스크립트 1개(해시)로만 허용합니다. 그래서 주입된 스크립트는 실행되지 않습니다.
   - 다만 글꼴 때문에 `fonts.googleapis.com`(스타일)과 `fonts.gstatic.com`(글꼴)은 허용했습니다. 그 서버가 다른 CSS를 보내면 화면 모양은 바뀔 수 있습니다. 스크립트 실행이나 데이터 전송은 CSP가 막습니다.
   - 인라인 스크립트·스타일 해시가 고정이라, 1번 페이지 인라인 코드를 고치면 해시도 함께 바꿔야 합니다. 바꾸지 않으면 그 코드가 막힙니다.
6. **7번 과제와 같은 Supabase 프로젝트를 씁니다.** 스키마·역할은 분리했지만, 프로젝트 자체가 멈추거나 관리자 계정이 털리면 두 과제가 함께 영향을 받습니다.
7. **두 번째 패스키가 같은 PC에 있습니다.**
   - testa의 두 패스키(Microsoft 비밀번호 관리자, Windows Hello)가 같은 PC에서 만들어졌습니다.
   - 그나마 Microsoft 쪽은 클라우드에 동기화되어 PC를 잃어도 다른 기기에서 쓸 수 있습니다.
