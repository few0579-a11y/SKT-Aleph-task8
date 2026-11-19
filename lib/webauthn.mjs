// 패스키(WebAuthn) 설정과 도우미.
// 챌린지 발급·보관·1회 사용 처리는 handler.mjs에서 직접 한다.
// CBOR 해석·공개키 추출·서명 검증만 @simplewebauthn/server 라이브러리에 맡긴다.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// RP ID = 패스키가 묶이는 도메인. ORIGIN = 브라우저 주소의 출처. 둘이 맞지 않으면 브라우저와 서버가 모두 거절한다.
export const RP_ID = process.env.RP_ID || 'localhost';
export const ORIGIN = process.env.ORIGIN || 'http://localhost:3008';
export const RP_NAME = '유지민 소개 페이지';
export const CHALLENGE_MINUTES = 5;

export const randomB64url = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const challengeExpiry = () => new Date(Date.now() + CHALLENGE_MINUTES * 60 * 1000);

// 가입 코드: Vercel 환경변수 SIGNUP_CODE에만 둔다. 없으면 가입을 막는다.
// 길이가 달라도 비교 시간이 같도록 해시끼리 비교한다.
export function signupCodeOk(input) {
  const code = process.env.SIGNUP_CODE;
  if (!code || typeof input !== 'string') return false;
  const h = (v) => createHash('sha256').update(v).digest();
  return timingSafeEqual(h(input), h(code));
}

// 인증기 종류(AAGUID) → 저장 위치 이름. 목록에 없으면 transports로 짐작한다.
const AAGUID_NAMES = {
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 키체인',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud 키체인',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 비밀번호 관리자',
  'd3452668-01fd-4c12-926c-83a4204853aa': 'Microsoft 비밀번호 관리자', // Edge (11/19 실제 등록에서 확인)
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
};

export function storageLabel({ aaguid, transports = [], backed_up }) {
  let where = AAGUID_NAMES[aaguid];
  if (!where) {
    // 동기화되는 비밀번호 관리자는 internal과 hybrid를 함께 알리므로 internal을 먼저 본다
    if (transports.includes('usb') || transports.includes('nfc')) where = '보안 키';
    else if (transports.includes('internal')) where = backed_up ? '비밀번호 관리자' : '이 기기의 인증기';
    else if (transports.includes('hybrid')) where = '휴대폰(QR 연결)';
    else where = '알 수 없는 인증기';
  }
  return `${where} · ${backed_up ? '동기화됨' : '이 기기에만 저장'}`;
}

// 패스키 이름은 자동으로 붙인다: 저장 위치 + 같은 이름이 있으면 번호
export function autoName(info, existingNames) {
  const base = storageLabel(info);
  if (!existingNames.includes(base)) return base;
  let n = 2;
  while (existingNames.includes(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}
