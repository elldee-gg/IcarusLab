import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  completeSetup,
  createSession,
  createUser,
  deleteUser,
  findUser,
  findUserByName,
  listUsers,
  notifyForgotPassword,
  passwordMatches,
  burnPasswordTime,
  resetUserPassword,
  updateUser,
  userJson,
} from './accounts.js';
import { isBackupRunning, listRuns, queueBackup, readSettings, saveSettings } from './backups.js';
import { consumePhraseFile, verifyAdminPassword, verifyPhrase } from './bootstrap.js';
import { sha256, signJwt, verifyJwt } from './crypto.js';
import { transaction } from './db.js';
import { diskInfo, freeBytes } from './paths.js';
import { readTelemetry } from './telemetry.js';
import { appearanceFor, readSettings as readAppSettings, saveAppearance, updateSettings } from './settings.js';
import { createEvent, createTask, deleteEvent, deleteTask, listCalendar, respondToEvent, updateEvent, updateTask } from './calendar.js';
import { HttpError } from './http-error.js';
import {
  accessLevel,
  breadcrumb,
  canTrash,
  cleanName,
  createFolder,
  emptyTrash,
  getNode,
  inTrash,
  isDescendant,
  isImageMime,
  listChildren,
  listTrash,
  moveNode,
  nodeDto,
  publicRoot,
  readText,
  removeTree,
  renameNode,
  requireAccess,
  restoreNode,
  searchNames,
  setAccess,
  shareList,
  sharedWith,
  trashNode,
  writeText,
  type Access,
} from './nodes.js';
import { userFile, userThumb } from './paths.js';
import {
  abortUpload,
  assembleUpload,
  chunkCount,
  commitUpload,
  createUpload,
  expectedChunkSize,
  getUpload,
  receivedIndexes,
  recordChunk,
  writeChunk,
} from './uploads.js';
import { chunkFile } from './paths.js';
import { scheduleThumb } from './thumbs.js';
import {
  assertAttemptLimit,
  clearAttempts,
  clearCookie,
  cookies,
  json,
  noteFailedAttempt,
  principalFromUser,
  readJson,
  sendFile,
  setCookie,
  type Ctx,
} from './server.js';

const ACCESS_TTL = 15 * 60;
const REFRESH_TTL = 7 * 24 * 60 * 60;

type Kind = 'public' | 'user' | 'admin' | 'session';

type Route = {
  method: string;
  re: RegExp;
  names: string[];
  kind: Kind;
  setup?: boolean;
  run: (ctx: Ctx) => Promise<void> | void;
};

function issue(ctx: Ctx, subject: string, role: 'admin' | 'user') {
  const session = createSession(ctx.app.db, subject, role);
  const access = signJwt({ typ: 'access', sub: subject, role, sid: session.id }, ctx.app.jwtSecret, ACCESS_TTL);
  setCookie(ctx.res, 'ic_access', access, ACCESS_TTL);
  setCookie(ctx.res, 'ic_refresh', session.refresh, REFRESH_TTL, true, '/api/auth');
  return session;
}

function meBody(ctx: Ctx) {
  const principal = ctx.principal;
  if (!principal) return null;
  if (principal.role === 'admin') {
    return { role: 'admin', username: principal.username, displayName: 'Admin', mustChangePassword: false };
  }
  return {
    role: 'user',
    username: principal.username,
    displayName: principal.displayName,
    mustChangePassword: principal.mustChangePassword,
    quotaBytes: principal.quotaBytes,
    usedBytes: principal.usedBytes,
  };
}

function requireUser(ctx: Ctx) {
  if (!ctx.principal || ctx.principal.role !== 'user') throw new HttpError(401, 'Sign in to continue');
  return ctx.principal;
}

function parentFromQuery(ctx: Ctx) {
  const value = ctx.url.searchParams.get('parentId');
  if (!value) return null;
  const parent = requireAccess(ctx.app.db, requireUser(ctx).id, value, 'view').node;
  if (parent.kind !== 'folder' || parent.deleted_at) throw new HttpError(404, 'Folder not found');
  return parent;
}

function mimeOf(value: unknown) {
  if (typeof value !== 'string') return 'application/octet-stream';
  const mime = value.slice(0, 120);
  return /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

function stringField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== 'string') throw new HttpError(400, `Missing ${key}`);
  return value;
}

function numberParam(ctx: Ctx, key: string) {
  const value = Number(ctx.url.searchParams.get(key));
  if (!Number.isFinite(value)) throw new HttpError(400, 'Choose a date range');
  return value;
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

const routes: Route[] = [
  {
    method: 'GET',
    re: /^\/api\/auth\/csrf$/,
    names: [],
    kind: 'public',
    run: (ctx) => json(ctx.res, 200, { ok: true }),
  },
  {
    method: 'GET',
    re: /^\/api\/auth\/me$/,
    names: [],
    kind: 'public',
    run: (ctx) => {
      if (!ctx.principal) throw new HttpError(401, 'Sign in to continue');
      json(ctx.res, 200, meBody(ctx));
    },
  },
  {
    method: 'POST',
    re: /^\/api\/auth\/login$/,
    names: [],
    kind: 'public',
    run: async (ctx) => {
      assertAttemptLimit(ctx.ip);
      const body = await readJson(ctx.req);
      const username = stringField(body, 'username').trim();
      const password = stringField(body, 'password');
      if (username === ctx.app.config.adminUsername) {
        if (!verifyAdminPassword(ctx.app.db, password)) {
          noteFailedAttempt(ctx.ip);
          throw new HttpError(401, 'Invalid credentials');
        }
        clearAttempts(ctx.ip);
        const token = signJwt({ typ: 'phrase' }, ctx.app.jwtSecret, 5 * 60);
        setCookie(ctx.res, 'ic_phrase', token, 5 * 60);
        json(ctx.res, 200, { step: 'phrase' });
        return;
      }
      const user = findUserByName(ctx.app.db, username.toLowerCase());
      if (!user || user.disabled || !passwordMatches(user, password)) {
        if (!user) burnPasswordTime(ctx.app.db, password);
        noteFailedAttempt(ctx.ip);
        throw new HttpError(401, 'Invalid credentials');
      }
      clearAttempts(ctx.ip);
      issue(ctx, user.id, 'user');
      const principal = principalFromUser(user, 'pending');
      json(ctx.res, 200, {
        step: user.must_change_password ? 'setup' : 'dashboard',
        role: 'user',
        username: principal.username,
        displayName: principal.displayName,
        mustChangePassword: principal.mustChangePassword,
        quotaBytes: principal.quotaBytes,
        usedBytes: principal.usedBytes,
      });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/auth\/admin\/phrase$/,
    names: [],
    kind: 'public',
    run: async (ctx) => {
      assertAttemptLimit(ctx.ip);
      const token = cookies(ctx.req).ic_phrase;
      const payload = token ? verifyJwt(token, ctx.app.jwtSecret) : null;
      if (!payload || payload.typ !== 'phrase') throw new HttpError(401, 'Enter the admin password again');
      const body = await readJson(ctx.req);
      if (!verifyPhrase(ctx.app.db, stringField(body, 'phrase'))) {
        noteFailedAttempt(ctx.ip);
        throw new HttpError(401, 'That phrase does not match');
      }
      clearAttempts(ctx.ip);
      clearCookie(ctx.res, 'ic_phrase');
      issue(ctx, 'admin', 'admin');
      consumePhraseFile(ctx.app.config.dataDir);
      json(ctx.res, 200, { step: 'admin', role: 'admin', username: ctx.app.config.adminUsername, displayName: 'Admin', mustChangePassword: false });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/auth\/refresh$/,
    names: [],
    kind: 'public',
    run: (ctx) => {
      const raw = cookies(ctx.req).ic_refresh;
      if (!raw) throw new HttpError(401, 'Sign in to continue');
      const hash = sha256(raw).toString('hex');
      const session = ctx.app.db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(hash) as
        | { id: string; subject: string; role: string; expires_at: number; revoked: number }
        | undefined;
      if (!session || session.revoked || session.expires_at < Date.now()) throw new HttpError(401, 'Sign in to continue');
      ctx.app.db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(session.id);
      if (session.role === 'user') {
        const user = findUser(ctx.app.db, session.subject);
        if (!user || user.disabled) throw new HttpError(401, 'Sign in to continue');
      }
      issue(ctx, session.subject, session.role === 'admin' ? 'admin' : 'user');
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/auth\/logout$/,
    names: [],
    kind: 'public',
    run: (ctx) => {
      if (ctx.principal) ctx.app.db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(ctx.principal.sessionId);
      clearCookie(ctx.res, 'ic_access');
      clearCookie(ctx.res, 'ic_refresh', '/api/auth');
      clearCookie(ctx.res, 'ic_phrase');
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/auth\/forgot$/,
    names: [],
    kind: 'public',
    run: async (ctx) => {
      assertAttemptLimit(ctx.ip);
      noteFailedAttempt(ctx.ip);
      const body = await readJson(ctx.req);
      if (typeof body.username === 'string') notifyForgotPassword(ctx.app.db, body.username);
      json(ctx.res, 200, { message: 'If that account exists, an admin has been notified.' });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/auth\/setup$/,
    names: [],
    kind: 'session',
    run: async (ctx) => {
      if (!ctx.principal || ctx.principal.role !== 'user') throw new HttpError(401, 'Sign in to continue');
      const body = await readJson(ctx.req);
      const user = completeSetup(ctx.app.db, ctx.principal.id, stringField(body, 'displayName'), stringField(body, 'password'));
      issue(ctx, user.id, 'user');
      json(ctx.res, 200, { step: 'dashboard', ...userJson(user), role: 'user' });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/admin\/users$/,
    names: [],
    kind: 'admin',
    run: (ctx) => {
      const counts = new Map<string, number>();
      const rows = ctx.app.db
        .prepare(`SELECT owner_id AS ownerId, SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END) AS files FROM nodes GROUP BY owner_id`)
        .all() as { ownerId: string; files: number | bigint }[];
      for (const row of rows) counts.set(row.ownerId, Number(row.files));
      json(ctx.res, 200, { users: listUsers(ctx.app.db).map((user) => ({ ...userJson(user), fileCount: counts.get(user.id) ?? 0 })) });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/admin\/users$/,
    names: [],
    kind: 'admin',
    run: async (ctx) => {
      const body = await readJson(ctx.req);
      const quota = typeof body.quotaBytes === 'number' ? body.quotaBytes : ctx.app.config.defaultQuota;
      const user = createUser(ctx.app.db, ctx.app.config.adminUsername, stringField(body, 'username'), quota);
      json(ctx.res, 201, userJson(user));
    },
  },
  {
    method: 'PATCH',
    re: /^\/api\/admin\/users\/([^/]+)$/,
    names: ['id'],
    kind: 'admin',
    run: async (ctx) => {
      const body = await readJson(ctx.req);
      const user = updateUser(
        ctx.app.db,
        ctx.params.id!,
        typeof body.quotaBytes === 'number' ? body.quotaBytes : undefined,
        typeof body.disabled === 'boolean' ? body.disabled : undefined,
      );
      json(ctx.res, 200, userJson(user));
    },
  },
  {
    method: 'POST',
    re: /^\/api\/admin\/users\/([^/]+)\/reset-password$/,
    names: ['id'],
    kind: 'admin',
    run: (ctx) => json(ctx.res, 200, userJson(resetUserPassword(ctx.app.db, ctx.params.id!))),
  },
  {
    method: 'DELETE',
    re: /^\/api\/admin\/users\/([^/]+)$/,
    names: ['id'],
    kind: 'admin',
    run: (ctx) => {
      deleteUser(ctx.app.db, ctx.app.config.storageDir, ctx.params.id!);
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/admin\/notifications$/,
    names: [],
    kind: 'admin',
    run: (ctx) => {
      const rows = ctx.app.db.prepare('SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 100').all() as {
        id: string;
        kind: string;
        user_id: string | null;
        username: string;
        created_at: number;
        read_at: number | null;
      }[];
      json(ctx.res, 200, {
        notifications: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          userId: row.user_id,
          username: row.username,
          createdAt: row.created_at,
          readAt: row.read_at,
        })),
      });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/admin\/notifications\/([^/]+)\/read$/,
    names: ['id'],
    kind: 'admin',
    run: (ctx) => {
      ctx.app.db.prepare('UPDATE admin_notifications SET read_at = ? WHERE id = ?').run(Date.now(), ctx.params.id);
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/appearance$/,
    names: [],
    kind: 'session',
    run: (ctx) => {
      const principal = ctx.principal!;
      json(ctx.res, 200, appearanceFor(ctx.app.db, principal.role, principal.id));
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/appearance$/,
    names: [],
    kind: 'session',
    run: async (ctx) => {
      const principal = ctx.principal!;
      const body = await readJson(ctx.req);
      json(ctx.res, 200, saveAppearance(ctx.app.db, principal.role, principal.id, body));
    },
  },
  {
    method: 'GET',
    re: /^\/api\/calendar$/,
    names: [],
    kind: 'user',
    run: (ctx) => {
      const user = requireUser(ctx);
      const from = numberParam(ctx, 'from');
      const to = numberParam(ctx, 'to');
      const startDay = ctx.url.searchParams.get('startDay') ?? '';
      const endDay = ctx.url.searchParams.get('endDay') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay) || !/^\d{4}-\d{2}-\d{2}$/.test(endDay) || startDay > endDay) {
        throw new HttpError(400, 'Choose a date range');
      }
      json(ctx.res, 200, listCalendar(ctx.app.db, user.id, from, to, startDay, endDay));
    },
  },
  {
    method: 'POST',
    re: /^\/api\/calendar\/events$/,
    names: [],
    kind: 'user',
    run: async (ctx) => {
      const user = requireUser(ctx);
      const body = await readJson(ctx.req);
      json(ctx.res, 201, { id: createEvent(ctx.app.db, user.id, body) });
    },
  },
  {
    method: 'PATCH',
    re: /^\/api\/calendar\/events\/([^/]+)$/,
    names: ['id'],
    kind: 'user',
    run: async (ctx) => {
      const user = requireUser(ctx);
      updateEvent(ctx.app.db, user.id, ctx.params.id!, await readJson(ctx.req));
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'DELETE',
    re: /^\/api\/calendar\/events\/([^/]+)$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      deleteEvent(ctx.app.db, requireUser(ctx).id, ctx.params.id!);
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/calendar\/events\/([^/]+)\/rsvp$/,
    names: ['id'],
    kind: 'user',
    run: async (ctx) => {
      const body = await readJson(ctx.req);
      respondToEvent(ctx.app.db, requireUser(ctx).id, ctx.params.id!, body.status);
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/calendar\/tasks$/,
    names: [],
    kind: 'user',
    run: async (ctx) => {
      const user = requireUser(ctx);
      const body = await readJson(ctx.req);
      json(ctx.res, 201, { id: createTask(ctx.app.db, user.id, body) });
    },
  },
  {
    method: 'PATCH',
    re: /^\/api\/calendar\/tasks\/([^/]+)$/,
    names: ['id'],
    kind: 'user',
    run: async (ctx) => {
      updateTask(ctx.app.db, requireUser(ctx).id, ctx.params.id!, await readJson(ctx.req));
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'DELETE',
    re: /^\/api\/calendar\/tasks\/([^/]+)$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      deleteTask(ctx.app.db, requireUser(ctx).id, ctx.params.id!);
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/admin\/settings$/,
    names: [],
    kind: 'admin',
    run: (ctx) => json(ctx.res, 200, readAppSettings(ctx.app.db)),
  },
  {
    method: 'PUT',
    re: /^\/api\/admin\/settings$/,
    names: [],
    kind: 'admin',
    run: async (ctx) => {
      const body = await readJson(ctx.req);
      json(ctx.res, 200, updateSettings(ctx.app.db, body));
    },
  },
  {
    method: 'GET',
    re: /^\/api\/admin\/disk$/,
    names: [],
    kind: 'admin',
    run: (ctx) => json(ctx.res, 200, diskInfo(ctx.app.config.storageDir)),
  },
  {
    method: 'GET',
    re: /^\/api\/admin\/telemetry$/,
    names: [],
    kind: 'admin',
    run: async (ctx) => json(ctx.res, 200, await readTelemetry(ctx.app.config.storageDir)),
  },
  {
    method: 'GET',
    re: /^\/api\/admin\/backups$/,
    names: [],
    kind: 'admin',
    run: (ctx) =>
      json(ctx.res, 200, {
        settings: readSettings(ctx.app.db),
        running: isBackupRunning(),
        runs: listRuns(ctx.app.db).map((run) => ({
          id: run.id,
          destination: run.destination,
          status: run.status,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          error: run.error,
          bytesCopied: run.bytes_copied,
        })),
      }),
  },
  {
    method: 'PUT',
    re: /^\/api\/admin\/backups$/,
    names: [],
    kind: 'admin',
    run: async (ctx) => {
      const body = await readJson(ctx.req);
      const settings = saveSettings(ctx.app.db, ctx.app.config, {
        destination: typeof body.destination === 'string' ? body.destination : undefined,
        cadence: body.cadence as 'hourly' | 'daily' | 'weekly' | undefined,
        hour: typeof body.hour === 'number' ? body.hour : undefined,
        minute: typeof body.minute === 'number' ? body.minute : undefined,
        weekday: typeof body.weekday === 'number' ? body.weekday : undefined,
        keep: typeof body.keep === 'number' ? body.keep : undefined,
      });
      json(ctx.res, 200, settings);
    },
  },
  {
    method: 'POST',
    re: /^\/api\/admin\/backups\/run$/,
    names: [],
    kind: 'admin',
    run: (ctx) => json(ctx.res, 202, queueBackup(ctx.app.db, ctx.app.config)),
  },
  {
    method: 'GET',
    re: /^\/api\/nodes\/shared$/,
    names: [],
    kind: 'user',
    run: (ctx) => {
      const user = requireUser(ctx);
      const nodes = sharedWith(ctx.app.db, user.id).map((node) => nodeDto(node, accessLevel(ctx.app.db, user.id, node.id) as Access));
      json(ctx.res, 200, { nodes });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/nodes\/trash$/,
    names: [],
    kind: 'user',
    run: (ctx) => {
      const user = requireUser(ctx);
      const nodes = listTrash(ctx.app.db, user.id, ctx.url.searchParams.get('q') ?? '').map((node) => nodeDto(node, 'owner'));
      json(ctx.res, 200, { nodes });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/nodes\/search$/,
    names: [],
    kind: 'user',
    run: (ctx) => {
      const user = requireUser(ctx);
      const nodes = searchNames(ctx.app.db, user.id, ctx.url.searchParams.get('q') ?? '').map((node) => {
        const parent = node.parent_id ? getNode(ctx.app.db, node.parent_id) : undefined;
        return { ...nodeDto(node, accessLevel(ctx.app.db, user.id, node.id) as Access), parentName: parent?.name ?? 'My files' };
      });
      json(ctx.res, 200, { nodes });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/nodes\/folders$/,
    names: [],
    kind: 'user',
    run: async (ctx) => {
      const user = requireUser(ctx);
      const body = await readJson(ctx.req);
      const parentId = typeof body.parentId === 'string' ? body.parentId : null;
      let ownerId = user.id;
      if (parentId) {
        const parent = requireAccess(ctx.app.db, user.id, parentId, 'edit').node;
        if (parent.kind !== 'folder') throw new HttpError(400, 'Choose a folder');
        ownerId = parent.owner_id;
      }
      const folder = transaction(ctx.app.db, () => createFolder(ctx.app.db, ownerId, parentId, stringField(body, 'name')));
      json(ctx.res, 201, nodeDto(folder, ownerId === user.id ? 'owner' : 'edit'));
    },
  },
  {
    method: 'POST',
    re: /^\/api\/nodes\/bulk\/move$/,
    names: [],
    kind: 'user',
    run: async (ctx) => {
      const user = requireUser(ctx);
      const body = await readJson(ctx.req);
      const ids = idList(body.ids);
      const parentId = typeof body.parentId === 'string' ? body.parentId : null;
      if (parentId) requireAccess(ctx.app.db, user.id, parentId, 'edit');
      const moved = transaction(ctx.app.db, () =>
        ids.map((id) => {
          const { node, level } = requireAccess(ctx.app.db, user.id, id, 'edit');
          if (parentId === null && level !== 'owner') throw new HttpError(403, 'You can only move your own items to My files');
          return nodeDto(moveNode(ctx.app.db, node, parentId), level);
        }),
      );
      json(ctx.res, 200, { nodes: moved });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/nodes\/bulk\/trash$/,
    names: [],
    kind: 'user',
    run: async (ctx) => {
      const user = requireUser(ctx);
      const body = await readJson(ctx.req);
      const ids = idList(body.ids);
      transaction(ctx.app.db, () => {
        for (const id of ids) {
          if (!canTrash(ctx.app.db, user.id, id)) throw new HttpError(403, 'You cannot move that item to the trash');
          const node = getNode(ctx.app.db, id);
          if (node) trashNode(ctx.app.db, node);
        }
      });
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/nodes\/bulk\/delete$/,
    names: [],
    kind: 'user',
    run: async (ctx) => {
      const user = requireUser(ctx);
      const body = await readJson(ctx.req);
      const ids = idList(body.ids);
      for (const id of ids) {
        const { node } = requireAccess(ctx.app.db, user.id, id, 'owner');
        if (!node.deleted_at) throw new HttpError(400, 'Move an item to the trash before deleting it');
        removeTree(ctx.app.db, ctx.app.config.storageDir, id);
      }
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/nodes\/trash\/empty$/,
    names: [],
    kind: 'user',
    run: (ctx) => {
      emptyTrash(ctx.app.db, ctx.app.config.storageDir, requireUser(ctx).id);
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/nodes$/,
    names: [],
    kind: 'user',
    run: (ctx) => {
      const user = requireUser(ctx);
      const parent = parentFromQuery(ctx);
      const ownerId = parent ? parent.owner_id : user.id;
      const level: Access = parent ? (accessLevel(ctx.app.db, user.id, parent.id) as Access) : 'owner';
      const nodes = listChildren(ctx.app.db, ownerId, parent?.id ?? null).map((node) => nodeDto(node, level === 'owner' && node.owner_id === user.id ? 'owner' : level));
      json(ctx.res, 200, { path: breadcrumb(ctx.app.db, user.id, parent?.id ?? null), nodes });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/nodes\/([^/]+)\/download$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      const { node } = requireAccess(ctx.app.db, requireUser(ctx).id, ctx.params.id!, 'view');
      if (node.kind !== 'file') throw new HttpError(400, 'Folders are downloaded one file at a time');
      const file = userFile(ctx.app.config.storageDir, node.owner_id, node.id);
      if (!fs.existsSync(file)) throw new HttpError(404, 'File bytes are missing');
      const inline = ctx.url.searchParams.get('inline') === '1' && isImageMime(node.mime);
      sendFile(ctx.req, ctx.res, file, { mime: node.mime ?? 'application/octet-stream', downloadName: node.name, inline });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/nodes\/([^/]+)\/text$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      const { node } = requireAccess(ctx.app.db, requireUser(ctx).id, ctx.params.id!, 'view');
      json(ctx.res, 200, { content: readText(ctx.app.config.storageDir, node), version: node.content_version, name: node.name });
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/nodes\/([^/]+)\/text$/,
    names: ['id'],
    kind: 'user',
    run: async (ctx) => {
      const { node, level } = requireAccess(ctx.app.db, requireUser(ctx).id, ctx.params.id!, 'edit');
      const body = await readJson(ctx.req, 3_000_000);
      if (typeof body.version !== 'number') throw new HttpError(400, 'Missing version');
      const saved = writeText(ctx.app.db, ctx.app.config.storageDir, node, stringField(body, 'content'), body.version);
      json(ctx.res, 200, nodeDto(saved, level));
    },
  },
  {
    method: 'GET',
    re: /^\/api\/nodes\/([^/]+)\/thumb$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      const { node } = requireAccess(ctx.app.db, requireUser(ctx).id, ctx.params.id!, 'view');
      const thumb = userThumb(ctx.app.config.storageDir, node.owner_id, node.id);
      if (!fs.existsSync(thumb)) {
        scheduleThumb(ctx.app.config.storageDir, node);
        throw new HttpError(404, 'Preview is not ready');
      }
      sendFile(ctx.req, ctx.res, thumb, { mime: 'image/webp', cache: 'private, max-age=86400' });
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/nodes\/([^/]+)\/access$/,
    names: ['id'],
    kind: 'user',
    run: async (ctx) => {
      const { node } = requireAccess(ctx.app.db, requireUser(ctx).id, ctx.params.id!, 'owner');
      const body = await readJson(ctx.req);
      if (body.visibility !== 'private' && body.visibility !== 'shared' && body.visibility !== 'public') {
        throw new HttpError(400, 'Choose private, shared, or public');
      }
      const shares = Array.isArray(body.shares)
        ? body.shares
            .filter((share): share is { username: string; permission: 'view' | 'edit' } => {
              if (!share || typeof share !== 'object') return false;
              const record = share as Record<string, unknown>;
              return typeof record.username === 'string' && (record.permission === 'view' || record.permission === 'edit');
            })
            .map((share) => ({ username: share.username, permission: share.permission }))
        : [];
      const saved = setAccess(ctx.app.db, node, body.visibility, shares);
      json(ctx.res, 200, { ...nodeDto(saved, 'owner'), publicPath: saved.public_token ? `/p/${saved.public_token}` : null, shares: shareList(ctx.app.db, saved.id) });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/nodes\/([^/]+)\/restore$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      const { node } = requireAccess(ctx.app.db, requireUser(ctx).id, ctx.params.id!, 'owner');
      json(ctx.res, 200, nodeDto(restoreNode(ctx.app.db, node), 'owner'));
    },
  },
  {
    method: 'POST',
    re: /^\/api\/nodes\/([^/]+)\/trash$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      const user = requireUser(ctx);
      if (!canTrash(ctx.app.db, user.id, ctx.params.id!)) throw new HttpError(403, 'You cannot move that item to the trash');
      const node = getNode(ctx.app.db, ctx.params.id!);
      if (!node) throw new HttpError(404, 'Item not found');
      json(ctx.res, 200, nodeDto(trashNode(ctx.app.db, node), 'owner'));
    },
  },
  {
    method: 'POST',
    re: /^\/api\/nodes\/([^/]+)\/move$/,
    names: ['id'],
    kind: 'user',
    run: async (ctx) => {
      const user = requireUser(ctx);
      const { node, level } = requireAccess(ctx.app.db, user.id, ctx.params.id!, 'edit');
      const body = await readJson(ctx.req);
      const parentId = typeof body.parentId === 'string' ? body.parentId : null;
      if (parentId === null && level !== 'owner') throw new HttpError(403, 'You can only move your own items to My files');
      if (parentId) requireAccess(ctx.app.db, user.id, parentId, 'edit');
      json(ctx.res, 200, nodeDto(moveNode(ctx.app.db, node, parentId), level));
    },
  },
  {
    method: 'PATCH',
    re: /^\/api\/nodes\/([^/]+)$/,
    names: ['id'],
    kind: 'user',
    run: async (ctx) => {
      const { node, level } = requireAccess(ctx.app.db, requireUser(ctx).id, ctx.params.id!, 'edit');
      const body = await readJson(ctx.req);
      json(ctx.res, 200, nodeDto(renameNode(ctx.app.db, node, stringField(body, 'name')), level));
    },
  },
  {
    method: 'DELETE',
    re: /^\/api\/nodes\/([^/]+)$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      const { node } = requireAccess(ctx.app.db, requireUser(ctx).id, ctx.params.id!, 'owner');
      if (!node.deleted_at) throw new HttpError(400, 'Move an item to the trash before deleting it');
      removeTree(ctx.app.db, ctx.app.config.storageDir, node.id);
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/nodes\/([^/]+)$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      const { node, level } = requireAccess(ctx.app.db, requireUser(ctx).id, ctx.params.id!, 'view');
      json(ctx.res, 200, {
        ...nodeDto(node, level),
        publicPath: level === 'owner' && node.public_token ? `/p/${node.public_token}` : null,
        shares: level === 'owner' ? shareList(ctx.app.db, node.id) : [],
      });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/uploads$/,
    names: [],
    kind: 'user',
    run: async (ctx) => {
      const user = requireUser(ctx);
      const body = await readJson(ctx.req);
      const parentId = typeof body.parentId === 'string' ? body.parentId : null;
      let ownerId = user.id;
      if (parentId) {
        const parent = requireAccess(ctx.app.db, user.id, parentId, 'edit').node;
        if (parent.kind !== 'folder' || parent.deleted_at) throw new HttpError(400, 'Choose a folder');
        ownerId = parent.owner_id;
      }
      if (typeof body.size !== 'number' || body.size < 0) throw new HttpError(400, 'File size is invalid');
      const upload = createUpload(
        ctx.app.db,
        ctx.app.config.storageDir,
        ctx.app.config.diskReserve,
        ownerId,
        user.id,
        parentId,
        cleanName(stringField(body, 'name')),
        mimeOf(body.mime),
        Math.trunc(body.size),
      );
      json(ctx.res, 201, { id: upload.id, chunkSize: ctx.app.config.chunkSize, received: [] });
    },
  },
  {
    method: 'GET',
    re: /^\/api\/uploads\/([^/]+)$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      const upload = ownUpload(ctx, ctx.params.id!);
      json(ctx.res, 200, { id: upload.id, size: upload.total_bytes, received: receivedIndexes(ctx.app.db, upload.id), chunkSize: ctx.app.config.chunkSize });
    },
  },
  {
    method: 'PUT',
    re: /^\/api\/uploads\/([^/]+)\/chunks\/(\d+)$/,
    names: ['id', 'index'],
    kind: 'user',
    run: async (ctx) => {
      const upload = ownUpload(ctx, ctx.params.id!);
      if (upload.status !== 'open') throw new HttpError(409, 'That upload is already finishing');
      const index = Number(ctx.params.index);
      const expected = expectedChunkSize(upload.total_bytes, index, ctx.app.config.chunkSize);
      if (expected < 0) throw new HttpError(400, 'That chunk is outside the file');
      const checksum = ctx.req.headers['x-chunk-sha256'];
      if (typeof checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(checksum)) throw new HttpError(400, 'Missing chunk checksum');
      if (freeBytes(ctx.app.config.storageDir) < expected + ctx.app.config.diskReserve) {
        throw new HttpError(507, 'The server disk does not have room for that piece');
      }
      const file = chunkFile(ctx.app.config.storageDir, upload.owner_id, upload.id, index);
      await writeChunk(ctx.req, file, expected, checksum);
      recordChunk(ctx.app.db, upload, index, expected);
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'POST',
    re: /^\/api\/uploads\/([^/]+)\/complete$/,
    names: ['id'],
    kind: 'user',
    run: async (ctx) => {
      let upload = ownUpload(ctx, ctx.params.id!);
      const count = chunkCount(upload.total_bytes, ctx.app.config.chunkSize);
      if (receivedIndexes(ctx.app.db, upload.id).length !== count) throw new HttpError(400, 'The upload is still missing pieces');
      if (!upload.result_node_id) {
        const id = crypto.randomUUID();
        ctx.app.db.prepare(`UPDATE uploads SET result_node_id = ?, status = 'assembling' WHERE id = ?`).run(id, upload.id);
        upload = getUpload(ctx.app.db, upload.id)!;
      }
      const dest = userFile(ctx.app.config.storageDir, upload.owner_id, upload.result_node_id!);
      if (!fs.existsSync(dest)) await assembleUpload(ctx.app.config.storageDir, upload, ctx.app.config.chunkSize, dest);
      const node = transaction(ctx.app.db, () => commitUpload(ctx.app.db, ctx.app.config.storageDir, upload));
      json(ctx.res, 201, nodeDto(node, node.owner_id === requireUser(ctx).id ? 'owner' : 'edit'));
    },
  },
  {
    method: 'DELETE',
    re: /^\/api\/uploads\/([^/]+)$/,
    names: ['id'],
    kind: 'user',
    run: (ctx) => {
      abortUpload(ctx.app.db, ctx.app.config.storageDir, ownUpload(ctx, ctx.params.id!));
      json(ctx.res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    re: /^\/p\/([^/]+)$/,
    names: ['token'],
    kind: 'public',
    run: (ctx) => renderPublic(ctx, ctx.params.token!, null),
  },
  {
    method: 'GET',
    re: /^\/p\/([^/]+)\/browse\/([^/]+)$/,
    names: ['token', 'id'],
    kind: 'public',
    run: (ctx) => renderPublic(ctx, ctx.params.token!, ctx.params.id!),
  },
  {
    method: 'GET',
    re: /^\/p\/([^/]+)\/file\/([^/]+)$/,
    names: ['token', 'id'],
    kind: 'public',
    run: (ctx) => {
      const root = publicRoot(ctx.app.db, ctx.params.token!);
      const node = root && isDescendant(ctx.app.db, root.id, ctx.params.id!) ? getNode(ctx.app.db, ctx.params.id!) : undefined;
      if (!root || !node || node.kind !== 'file' || inTrash(ctx.app.db, node.id)) throw new HttpError(404, 'File not found');
      const file = userFile(ctx.app.config.storageDir, node.owner_id, node.id);
      if (!fs.existsSync(file)) throw new HttpError(404, 'File not found');
      sendFile(ctx.req, ctx.res, file, { mime: 'application/octet-stream', downloadName: node.name });
    },
  },
];

function ownUpload(ctx: Ctx, id: string) {
  const user = requireUser(ctx);
  const upload = getUpload(ctx.app.db, id);
  if (!upload || (upload.actor_id !== user.id && upload.owner_id !== user.id)) throw new HttpError(404, 'Upload not found');
  if (upload.actor_id !== user.id) {
    const level = upload.parent_id ? accessLevel(ctx.app.db, user.id, upload.parent_id) : null;
    if (level !== 'owner' && level !== 'edit') throw new HttpError(404, 'Upload not found');
  }
  return upload;
}

function idList(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, 'Choose at least one item');
  }
  return value as string[];
}

function renderPublic(ctx: Ctx, token: string, folderId: string | null) {
  const root = publicRoot(ctx.app.db, token);
  if (!root) throw new HttpError(404, 'This link is not available');
  const folder = folderId ? getNode(ctx.app.db, folderId) : root;
  if (!folder || folder.kind !== 'folder' || !isDescendant(ctx.app.db, root.id, folder.id)) {
    if (!folderId && root.kind === 'file') {
      const file = userFile(ctx.app.config.storageDir, root.owner_id, root.id);
      if (!fs.existsSync(file)) throw new HttpError(404, 'File not found');
      sendFile(ctx.req, ctx.res, file, { mime: 'application/octet-stream', downloadName: root.name });
      return;
    }
    throw new HttpError(404, 'This link is not available');
  }
  const children = listChildren(ctx.app.db, folder.owner_id, folder.id);
  const items = children
    .map((child) => {
      const href = child.kind === 'folder' ? `/p/${token}/browse/${child.id}` : `/p/${token}/file/${child.id}`;
      return `<li><a href="${esc(href)}">${esc(child.name)}</a></li>`;
    })
    .join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(folder.name)}</title>
    <style>body{font-family:"Segoe UI",sans-serif;background:#d7e7f7;color:#14324f;margin:0}main{max-width:640px;margin:40px auto;padding:24px;background:rgba(255,255,255,.72);border:1px solid #fff;border-radius:12px}a{color:#1a5fad}</style>
    </head><body><main><h1>${esc(folder.name)}</h1><ul>${items || '<li>This folder is empty.</li>'}</ul></main></body></html>`;
  ctx.res.statusCode = 200;
  ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
  ctx.res.end(html);
}

export async function handleRequest(ctx: Ctx) {
  const method = ctx.req.method ?? 'GET';
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.re.exec(ctx.url.pathname);
    if (!match) continue;
    route.names.forEach((name, index) => {
      ctx.params[name] = decodeURIComponent(match[index + 1] ?? '');
    });
    if (route.kind === 'admin' && ctx.principal?.role !== 'admin') throw new HttpError(401, 'Sign in as the admin');
    if (route.kind === 'user') {
      if (ctx.principal?.role !== 'user') throw new HttpError(401, 'Sign in to continue');
      if (ctx.principal.mustChangePassword) throw new HttpError(403, 'Finish setting up your account', { code: 'setup' });
    }
    if (route.kind === 'session' && !ctx.principal) throw new HttpError(401, 'Sign in to continue');
    await route.run(ctx);
    return true;
  }
  return false;
}
