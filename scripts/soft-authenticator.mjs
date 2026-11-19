// 시험용 소프트웨어 인증기. 실제 기기(Windows Hello·아이폰) 대신 서버 동작을 자동으로 확인할 때만 쓴다.
// 실제 인증기와 같은 형식(CBOR attestationObject, ECDSA P-256 서명)으로 응답을 만든다.
// 개인키는 이 프로세스 메모리에만 있고, 서버로 보내는 요청 본문에는 들어가지 않는다.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

// ---- 최소 CBOR 인코더 (정수·바이트·문자열·맵만) ----
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  throw new Error('unsupported cbor value');
}

export class SoftAuthenticator {
  constructor({ origin, rpId, aaguid = Buffer.alloc(16) } = {}) {
    this.origin = origin;
    this.rpId = rpId;
    this.aaguid = aaguid;
    this.creds = []; // { id, privateKey, userHandle, count }
  }

  // navigator.credentials.create()와 같은 일: 키 쌍을 만들고 공개키만 담은 등록 응답을 돌려준다.
  create(options, { originOverride } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const credId = randomBytes(32);
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(credId.length);
    const flags = 0x01 | 0x04 | 0x40; // UP(사용자 있음) + UV(사용자 확인) + AT(자격 증명 데이터 포함)
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([flags]), Buffer.alloc(4), this.aaguid, lenBuf, credId, cose]);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.create', challenge: options.challenge, origin: originOverride || this.origin, crossOrigin: false,
    }));
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    this.creds.push({ id: b64u(credId), privateKey, userHandle: options.user.id, count: 0 });
    return {
      id: b64u(credId), rawId: b64u(credId), type: 'public-key', authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }

  // navigator.credentials.get()와 같은 일: 서버 챌린지에 개인키로 서명한다.
  get(options, { credId, originOverride, tamper = false } = {}) {
    const c = credId ? this.creds.find((x) => x.id === credId) : this.creds[0];
    c.count += 1;
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(c.count);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x01 | 0x04]), cnt]);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge: options.challenge, origin: originOverride || this.origin, crossOrigin: false,
    }));
    let signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), c.privateKey);
    if (tamper) { signature = Buffer.from(signature); signature[signature.length - 1] ^= 0xff; }
    return {
      id: c.id, rawId: c.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData),
        signature: b64u(signature), userHandle: c.userHandle,
      },
    };
  }
}
