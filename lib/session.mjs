// 로그인 세션. 쿠키에는 추측할 수 없는 무작위 32바이트 값을 넣고, DB에는 그 SHA-256 해시만 둔다.
// DB가 유출되어도 해시로는 쿠키 값을 되돌릴 수 없다. 로그아웃하면 DB 행을 지워 즉시 무효가 된다.
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'sid';
export const SESSION_HOURS = 8; // 로그인 후 8시간 고정(쓰는 동안 늘리지 않음)
const SESSION_SECONDS = SESSION_HOURS * 60 * 60;

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const sessionExpiry = () => new Date(Date.now() + SESSION_SECONDS * 1000);

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// HttpOnly: 화면 스크립트가 읽지 못함 / Secure: HTTPS에서만 전송(localhost는 브라우저가 예외 허용)
// SameSite=Strict: 다른 사이트에서 시작한 요청에는 쿠키가 붙지 않음
export const sessionCookie = (token) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
