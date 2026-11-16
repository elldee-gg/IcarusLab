import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { findUser, type UserRow } from './accounts.js';
import { verifyJwt } from './crypto.js';
import type { Config } from './config.js';
import { HttpError } from './http-error.js';
import { handleRequest } from './routes.js';
import { allowLan, isLoopback } from './settings.js';

export type AppState = {
  config: Config;
  db: DatabaseSync;
  jwtSecret: Buffer;
};

export type Principal = {
  role: 'admin' | 'user';
  id: string;
  username: string;
  displayName: string;
  sessionId: string;
  mustChangePassword: boolean;
  quotaBytes: number;
  usedBytes: number;
};

export type Ctx = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  principal: Principal | null;
  app: AppState;
  ip: string;
};

const attempts = new Map<string, number[]>();

export function assertAttemptLimit(ip: string) {
  const now = Date.now();
  const recent = (attempts.get(ip) ?? []).filter((time) => now - time < 15 * 60 * 1000);
  attempts.set(ip, recent);
  if (recent.length >= 10) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
}

export function noteFailedAttempt(ip: string) {
  const recent = attempts.get(ip) ?? [];
  recent.push(Date.now());
  attempts.set(ip, recent);
}

export function clearAttempts(ip: string) {
  attempts.delete(ip);
}

export function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

export async function readJson(req: http.IncomingMessage, limit = 1_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(buf);
  }
  if (size === 0) return {} as Record<string, unknown>;
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export function cookies(req: http.IncomingMessage) {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function setCookie(res: http.ServerResponse, name: string, value: string, maxAge: number, httpOnly = true, cookiePath = '/') {
  const pieces = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`, 'Secure', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (httpOnly) pieces.push('HttpOnly');
  res.appendHeader('Set-Cookie', pieces.join('; '));
}

export function clearCookie(res: http.ServerResponse, name: string, cookiePath = '/') {
  res.appendHeader('Set-Cookie', `${name}=; Path=${cookiePath}; Secure; SameSite=Strict; Max-Age=0; HttpOnly`);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  options: { mime: string; downloadName?: string; inline?: boolean; cache?: string },
) {
  const stat = fs.statSync(file);
  const size = stat.size;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', options.mime);
  res.setHeader('Cache-Control', options.cache ?? 'private, max-age=0');
  if (options.downloadName) {
    const star = encodeURIComponent(options.downloadName).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const mode = options.inline ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${mode}; filename*=UTF-8''${star}`);
  }
  const range = req.headers.range;
  if (!range) {
    res.statusCode = 200;
    res.setHeader('Content-Length', size);
    fs.createReadStream(file).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }
  end = Math.min(end, size - 1);
  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(file, { start, end }).pipe(res);
}

function principalFrom(app: AppState, token: string | undefined): Principal | null {
  if (!token) return null;
  const payload = verifyJwt(token, app.jwtSecret);
  if (!payload || payload.typ !== 'access' || typeof payload.sid !== 'string' || typeof payload.sub !== 'string') return null;
  const session = app.db.prepare('SELECT * FROM sessions WHERE id = ?').get(payload.sid) as
    | { id: string; subject: string; role: string; expires_at: number; revoked: number }
    | undefined;
  if (!session || session.revoked || session.expires_at < Date.now() || session.subject !== payload.sub) return null;
  if (session.role === 'admin') {
    return {
      role: 'admin',
      id: 'admin',
      username: app.config.adminUsername,
      displayName: 'Admin',
      sessionId: session.id,
      mustChangePassword: false,
      quotaBytes: 0,
      usedBytes: 0,
    };
  }
  const user = findUser(app.db, session.subject);
  if (!user || user.disabled) return null;
  return principalFromUser(user, session.id);
}

export function principalFromUser(user: UserRow, sessionId: string): Principal {
  return {
    role: 'user',
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    sessionId,
    mustChangePassword: user.must_change_password === 1,
    quotaBytes: user.quota_bytes,
    usedBytes: user.used_bytes,
  };
}

function serveClient(ctx: Ctx) {
  const dist = path.resolve(ctx.app.config.clientDist);
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    ctx.res.statusCode = 503;
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('The client has not been built yet. Run npm run build.');
    return;
  }
  const requested = decodeURIComponent(ctx.url.pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^[/\\]+/, '');
  let file = path.resolve(dist, relative);
  const rootWithSep = dist.endsWith(path.sep) ? dist : dist + path.sep;
  if (file !== dist && !file.startsWith(rootWithSep)) {
    ctx.res.statusCode = 400;
    ctx.res.end('Bad path');
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  const ext = path.extname(file).toLowerCase();
  sendFile(ctx.req, ctx.res, file, {
    mime: TYPES[ext] ?? 'application/octet-stream',
    cache: ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
}

export function createApp(app: AppState, tls: { cert: Buffer; key: Buffer }) {
  const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    void onRequest(app, req, res);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  return server;
}

async function onRequest(app: AppState, req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'");
  const host = req.headers.host ?? `localhost:${app.config.port}`;
  const url = new URL(req.url ?? '/', `https://${host}`);
  const jar = cookies(req);
  if (!jar.ic_csrf) setCookie(res, 'ic_csrf', randomCsrf(), 7 * 24 * 60 * 60, false);
  const ctx: Ctx = {
    req,
    res,
    url,
    params: {},
    principal: principalFrom(app, jar.ic_access),
    app,
    ip: req.socket.remoteAddress ?? 'unknown',
  };
  try {
    const method = req.method ?? 'GET';
    if (!allowLan(app.db) && !isLoopback(ctx.ip)) {
      if (url.pathname.startsWith('/api/')) throw new HttpError(403, 'This server is not accepting connections from the network');
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('This IcarusLab server is not accepting connections from the network.');
      return;
    }
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const token = req.headers['x-csrf-token'];
      if (!jar.ic_csrf || typeof token !== 'string' || token !== jar.ic_csrf) throw new HttpError(403, 'Refresh the page and try again');
    }
    const handled = await handleRequest(ctx);
    if (!handled) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(404, 'Not found');
      serveClient(ctx);
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof HttpError) {
      json(res, error.status, { error: error.message, ...error.extra });
      return;
    }
    console.error(error);
    json(res, 500, { error: 'Something went wrong on the server' });
  }
}

function randomCsrf() {
  return Buffer.from(cryptoRandom()).toString('base64url');
}

function cryptoRandom() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
