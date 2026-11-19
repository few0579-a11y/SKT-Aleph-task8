# ALEPH 과제 8 · 자기소개 페이지 + 패스키(WebAuthn) 비공개 영역

1번 과제 소개 페이지(커밋 `2a1ee4a`, https://few0579-a11y.github.io/SKT-Aleph/)에 이어 붙였습니다.
첫 화면의 공개 소개 내용은 그대로이고, 맨 아래 **비공개 영역**만 패스키로 로그인한 본인에게 보입니다.
비밀번호 인증은 쓰지 않습니다. 비공개 영역의 내용은 모두 직접 만들어 넣은 가상의 내용입니다.

## 구성
| 위치 | 하는 일 |
|---|---|
| `public/index.html` | 1번 소개 페이지 + 비공개 영역 틀(비공개 내용 없음) |
| `public/private.js` | 가입·로그인·로그아웃·비공개 자료 화면 (WebAuthn 브라우저 API) |
| `lib/handler.mjs` | API: 챌린지 발급·보관·1회 사용, 등록·로그인 검증, 세션, 비공개 자료 |
| `lib/webauthn.mjs` | RP ID·출처 설정, 가입 코드 확인, 패스키 이름(저장 위치) |
| `lib/session.mjs` | 세션 쿠키(무작위 값, DB에는 해시만) |
| `db/t08-role.sql`, `db/t08-schema.sql` | Supabase `t08` 스키마와 전용 역할 `t08_app` |
| `scripts/test-register.mjs`, `test-login.mjs`, `test-passkeys.mjs`, `test-notes.mjs` | 시험용 소프트웨어 인증기로 등록·로그인·패스키 삭제·자료 차단 자동 확인(로컬, 58개) |
| `scripts/console-evidence.js` | 배포 사이트에서 거절·통과 요청을 기록하는 콘솔 도우미 |
| `vercel.json` | 배포 설정 + 보안 헤더(CSP 해시 포함) |
| `docs/AUTH.md`, `docs/EVIDENCE.md` | 인증 구현 설명서(①–⑥), 배포 사이트 확인 기록 |
| `api/router.js`, `server.mjs` | Vercel 함수 진입점 / 로컬 실행용 서버 |

서명 검증(CBOR 해석·공개키 추출·서명 확인)은 `@simplewebauthn/server` 14.0.3에 맡기고,
챌린지 생성·DB 보관·1회 사용·만료, 계정·세션·권한 확인은 직접 작성했습니다.

## 환경변수 (Vercel)
- `DATABASE_URL` — Supabase transaction pooler, `t08_app` 역할 (Sensitive)
- `SIGNUP_CODE` — 가입 코드 (Sensitive)
- `RP_ID` — 배포 도메인 (예: `skt-aleph-task8.vercel.app`)
- `ORIGIN` — `https://` + 배포 도메인

## 로컬 실행
```bash
npm install
DATABASE_URL=postgres://... SIGNUP_CODE=... PORT=3008 node server.mjs   # http://localhost:3008
```
로컬 테스트 DB(PGlite)를 쓸 때는 `PG_POOL_MAX=1 PG_SEARCH_PATH=t08`을 함께 줍니다.
