import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, sameBuffer, scryptHash, sha256 } from './crypto.js';
import { metaGet } from './db.js';
import { HttpError } from './http-error.js';
import { removeUserCalendar } from './calendar.js';
import { removeTree } from './nodes.js';

const USERNAME = /^[a-z0-9._-]{3,32}$/;
const WEEK = 7 * 24 * 60 * 60 * 1000;

export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  must_change_password: number;
  quota_bytes: number;
  used_bytes: number;
  disabled: number;
};

function num(value: number | bigint) {
  return typeof value === 'bigint' ? Number(value) : value;
}

export function asUser(row: Record<string, unknown> | undefined): UserRow | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    username: String(row.username),
    display_name: String(row.display_name),
    password_hash: String(row.password_hash),
    password_salt: String(row.password_salt),
    must_change_password: num(row.must_change_password as number),
    quota_bytes: num(row.quota_bytes as number),
    used_bytes: num(row.used_bytes as number),
    disabled: num(row.disabled as number),
  };
}

export function findUserByName(db: DatabaseSync, username: string) {
  return asUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined);
}

export function findUser(db: DatabaseSync, id: string) {
  return asUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined);
}

export function passwordMatches(user: UserRow, password: string) {
  return sameBuffer(scryptHash(password, Buffer.from(user.password_salt, 'hex')), Buffer.from(user.password_hash, 'hex'));
}

export function burnPasswordTime(db: DatabaseSync, password: string) {
  const salt = metaGet(db, 'dummy_password_salt') ?? randomBytes(16).toString('hex');
  scryptHash(password, Buffer.from(salt, 'hex'));
}

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return { salt: salt.toString('hex'), hash: scryptHash(password, salt).toString('hex') };
}

export function createSession(db: DatabaseSync, subject: string, role: 'admin' | 'user') {
  const id = crypto.randomUUID();
  const refresh = randomBytes(32).toString('base64url');
  const expires = Date.now() + WEEK;
  db.prepare('INSERT INTO sessions (id, subject, role, refresh_hash, expires_at, revoked, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)').run(
    id,
    subject,
    role,
    sha256(refresh).toString('hex'),
    expires,
    Date.now(),
  );
  return { id, refresh, expires };
}

export function revokeSubject(db: DatabaseSync, subject: string) {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE subject = ? AND revoked = 0').run(subject);
}

export function listUsers(db: DatabaseSync) {
  return (db.prepare('SELECT * FROM users ORDER BY username').all() as Record<string, unknown>[]).map((row) => asUser(row)!);
}

export function createUser(db: DatabaseSync, adminUsername: string, username: string, quotaBytes: number) {
  const name = username.trim().toLowerCase();
  if (!USERNAME.test(name)) throw new HttpError(400, 'Usernames are 3 to 32 characters: letters, numbers, dots, underscores, and hyphens');
  if (name === adminUsername.toLowerCase()) throw new HttpError(400, 'That username is reserved');
  if (findUserByName(db, name)) throw new HttpError(409, 'That username is already in use');
  if (!Number.isFinite(quotaBytes) || quotaBytes < 1) throw new HttpError(400, 'Quota must be at least 1 byte');
  const { salt, hash } = hashPassword('password');
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, password_salt, must_change_password, quota_bytes, used_bytes, disabled, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, 1, ?, 0, 0, ?, ?)`,
  ).run(id, name, hash, salt, Math.trunc(quotaBytes), now, now);
  return findUser(db, id)!;
}

export function updateUser(db: DatabaseSync, id: string, quotaBytes?: number, disabled?: boolean) {
  const user = findUser(db, id);
  if (!user) throw new HttpError(404, 'User not found');
  if (quotaBytes !== undefined) {
    if (!Number.isFinite(quotaBytes) || quotaBytes < 1) throw new HttpError(400, 'Quota must be at least 1 byte');
    db.prepare('UPDATE users SET quota_bytes = ?, updated_at = ? WHERE id = ?').run(Math.trunc(quotaBytes), Date.now(), id);
  }
  if (disabled !== undefined) {
    db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?').run(disabled ? 1 : 0, Date.now(), id);
    if (disabled) revokeSubject(db, id);
  }
  return findUser(db, id)!;
}

export function resetUserPassword(db: DatabaseSync, id: string) {
  const user = findUser(db, id);
  if (!user) throw new HttpError(404, 'User not found');
  const { salt, hash } = hashPassword('password');
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 1, updated_at = ? WHERE id = ?').run(
    hash,
    salt,
    Date.now(),
    id,
  );
  revokeSubject(db, id);
  db.prepare(`UPDATE admin_notifications SET read_at = ? WHERE user_id = ? AND kind = 'password_reset' AND read_at IS NULL`).run(Date.now(), id);
  return findUser(db, id)!;
}

export function deleteUser(db: DatabaseSync, storageDir: string, id: string) {
  const user = findUser(db, id);
  if (!user) throw new HttpError(404, 'User not found');
  const roots = db.prepare('SELECT id FROM nodes WHERE owner_id = ? AND parent_id IS NULL').all(id) as { id: string }[];
  for (const root of roots) removeTree(db, storageDir, root.id);
  const leftovers = db.prepare('SELECT id FROM nodes WHERE owner_id = ?').all(id) as { id: string }[];
  for (const row of leftovers) removeTree(db, storageDir, row.id);
  removeUserCalendar(db, id);
  db.prepare('DELETE FROM shares WHERE grantee_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE subject = ?').run(id);
  db.prepare('DELETE FROM admin_notifications WHERE user_id = ?').run(id);
  const uploads = db.prepare('SELECT id FROM uploads WHERE owner_id = ?').all(id) as { id: string }[];
  for (const upload of uploads) db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(upload.id);
  db.prepare('DELETE FROM uploads WHERE owner_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  fs.rmSync(path.join(storageDir, id), { recursive: true, force: true });
}

export function notifyForgotPassword(db: DatabaseSync, username: string) {
  const user = findUserByName(db, username.trim().toLowerCase());
  if (!user || user.disabled) return;
  const existing = db
    .prepare(`SELECT id FROM admin_notifications WHERE kind = 'password_reset' AND user_id = ? AND read_at IS NULL`)
    .get(user.id) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE admin_notifications SET created_at = ? WHERE id = ?').run(Date.now(), existing.id);
    return;
  }
  db.prepare('INSERT INTO admin_notifications (id, kind, user_id, username, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)').run(
    crypto.randomUUID(),
    'password_reset',
    user.id,
    user.username,
    Date.now(),
  );
}

export function completeSetup(db: DatabaseSync, userId: string, displayName: string, password: string) {
  const name = displayName.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 80) throw new HttpError(400, 'Enter a display name up to 80 characters');
  if (password.length < 10 || password === 'password') throw new HttpError(400, 'Choose a password of at least 10 characters');
  const { salt, hash } = hashPassword(password);
  db.prepare('UPDATE users SET display_name = ?, password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(
    name,
    hash,
    salt,
    Date.now(),
    userId,
  );
  revokeSubject(db, userId);
  return findUser(db, userId)!;
}

export function userJson(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    mustChangePassword: user.must_change_password === 1,
    quotaBytes: user.quota_bytes,
    usedBytes: user.used_bytes,
    disabled: user.disabled === 1,
  };
}
