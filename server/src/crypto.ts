import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export function randomBytes(size: number) {
  return crypto.randomBytes(size);
}

export function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest();
}

export function scryptHash(password: string, salt: Buffer) {
  return crypto.scryptSync(password, salt, 32, SCRYPT);
}

export function sameBuffer(a: Buffer, b: Buffer) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifySecret(password: string, saltHex: string, hashHex: string) {
  const got = scryptHash(password, Buffer.from(saltHex, 'hex'));
  return sameBuffer(got, Buffer.from(hashHex, 'hex'));
}

function b64url(value: Buffer) {
  return value.toString('base64url');
}

export type JwtPayload = Record<string, unknown> & { exp: number; typ: string };

export function signJwt(payload: Record<string, unknown>, secret: Buffer, ttlSec: number) {
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec };
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const data = b64url(Buffer.from(JSON.stringify(body)));
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${data}`).digest();
  return `${head}.${data}.${b64url(sig)}`;
}

export function verifyJwt(token: string, secret: Buffer): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let sig: Buffer;
  try {
    sig = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  if (!sameBuffer(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JwtPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newId() {
  return crypto.randomUUID();
}
