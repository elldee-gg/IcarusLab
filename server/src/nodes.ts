import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { writeAtomic } from './atomic.js';
import { HttpError } from './http-error.js';
import { userFile, userThumb } from './paths.js';

export type NodeRow = {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  kind: 'file' | 'folder';
  mime: string | null;
  size_bytes: number;
  content_version: number;
  visibility: 'private' | 'shared' | 'public';
  public_token: string | null;
  deleted_at: number | null;
  restore_parent_id: string | null;
  created_at: number;
  updated_at: number;
};

export type Access = 'owner' | 'edit' | 'view';

const IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function isImageMime(mime: string | null) {
  return mime !== null && IMAGE.has(mime);
}

function num(value: unknown) {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

export function asNode(row: Record<string, unknown> | undefined): NodeRow | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    parent_id: row.parent_id == null ? null : String(row.parent_id),
    name: String(row.name),
    kind: row.kind === 'folder' ? 'folder' : 'file',
    mime: row.mime == null ? null : String(row.mime),
    size_bytes: num(row.size_bytes),
    content_version: num(row.content_version),
    visibility: (row.visibility as NodeRow['visibility']) ?? 'private',
    public_token: row.public_token == null ? null : String(row.public_token),
    deleted_at: row.deleted_at == null ? null : num(row.deleted_at),
    restore_parent_id: row.restore_parent_id == null ? null : String(row.restore_parent_id),
    created_at: num(row.created_at),
    updated_at: num(row.updated_at),
  };
}

export function getNode(db: DatabaseSync, id: string) {
  return asNode(db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as Record<string, unknown> | undefined);
}

export function cleanName(input: string) {
  const name = input.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length > 240) throw new HttpError(400, 'That name is too long');
  if (!name || /^\.+$/.test(name)) throw new HttpError(400, 'That name is not allowed');
  return name;
}

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, ''];
  const ext = name.slice(dot);
  if (!/^\.[A-Za-z0-9]{1,8}$/.test(ext)) return [name, ''];
  return [name.slice(0, dot), ext];
}

export function uniqueName(db: DatabaseSync, ownerId: string, parentId: string | null, wanted: string, exceptId?: string) {
  const parentKey = parentId ?? '';
  const taken = (name: string) => {
    const row = db
      .prepare(
        `SELECT id FROM nodes WHERE owner_id = ? AND ifnull(parent_id, '') = ? AND name = ? AND deleted_at IS NULL`,
      )
      .get(ownerId, parentKey, name) as { id: string } | undefined;
    return Boolean(row && row.id !== exceptId);
  };
  if (!taken(wanted)) return wanted;
  const [base, ext] = splitExt(wanted);
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  throw new HttpError(409, 'Too many items already use that name');
}

export function inTrash(db: DatabaseSync, id: string) {
  const row = db
    .prepare(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_id, deleted_at FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.id, n.parent_id, n.deleted_at FROM nodes n JOIN chain c ON n.id = c.parent_id
       )
       SELECT 1 AS ok FROM chain WHERE deleted_at IS NOT NULL LIMIT 1`,
    )
    .get(id) as { ok: number } | undefined;
  return Boolean(row);
}

export function accessLevel(db: DatabaseSync, userId: string, nodeId: string): Access | null {
  const node = getNode(db, nodeId);
  if (!node) return null;
  if (node.owner_id === userId) return 'owner';
  if (inTrash(db, nodeId)) return null;
  const grants = db
    .prepare(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_id FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.id, n.parent_id FROM nodes n JOIN chain c ON n.id = c.parent_id
       )
       SELECT s.permission AS permission
       FROM shares s JOIN chain c ON c.id = s.node_id
       WHERE s.grantee_id = ?`,
    )
    .all(nodeId, userId) as { permission: string }[];
  if (grants.some((grant) => grant.permission === 'edit')) return 'edit';
  if (grants.length > 0) return 'view';
  return null;
}

export function canTrash(db: DatabaseSync, userId: string, nodeId: string) {
  const level = accessLevel(db, userId, nodeId);
  if (level === 'owner') return true;
  if (level !== 'edit') return false;
  const row = db
    .prepare(
      `WITH RECURSIVE chain AS (
         SELECT parent_id AS id FROM nodes WHERE id = ? AND parent_id IS NOT NULL
         UNION ALL
         SELECT n.parent_id FROM nodes n JOIN chain c ON n.id = c.id WHERE n.parent_id IS NOT NULL
       )
       SELECT 1 AS ok FROM shares s JOIN chain c ON c.id = s.node_id
       WHERE s.grantee_id = ? AND s.permission = 'edit' LIMIT 1`,
    )
    .get(nodeId, userId) as { ok: number } | undefined;
  return Boolean(row);
}

function descendantIds(db: DatabaseSync, rootId: string) {
  const rows = db
    .prepare(
      `WITH RECURSIVE tree AS (
         SELECT id FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN tree t ON n.parent_id = t.id
       )
       SELECT id FROM tree`,
    )
    .all(rootId) as { id: string }[];
  return rows.map((row) => row.id);
}

export function ftsRemove(db: DatabaseSync, nodeId: string) {
  db.prepare('DELETE FROM nodes_fts WHERE node_id = ?').run(nodeId);
}

export function ftsUpsert(db: DatabaseSync, nodeId: string, name: string) {
  ftsRemove(db, nodeId);
  db.prepare('INSERT INTO nodes_fts (name, node_id) VALUES (?, ?)').run(name, nodeId);
}

export function recalcUsed(db: DatabaseSync, ownerId: string) {
  db.prepare(
    `UPDATE users SET used_bytes = (
       SELECT COALESCE(SUM(size_bytes), 0) FROM nodes WHERE owner_id = ? AND kind = 'file'
     ), updated_at = ? WHERE id = ?`,
  ).run(ownerId, Date.now(), ownerId);
}

export function reservedBytes(db: DatabaseSync, ownerId: string) {
  const row = db.prepare(`SELECT COALESCE(SUM(total_bytes), 0) AS n FROM uploads WHERE owner_id = ?`).get(ownerId) as {
    n: number | bigint;
  };
  return num(row.n);
}

export function assertQuota(db: DatabaseSync, ownerId: string, extra: number) {
  const user = db.prepare('SELECT quota_bytes, used_bytes FROM users WHERE id = ?').get(ownerId) as
    | { quota_bytes: number | bigint; used_bytes: number | bigint }
    | undefined;
  if (!user) throw new HttpError(404, 'User not found');
  if (num(user.used_bytes) + reservedBytes(db, ownerId) + extra > num(user.quota_bytes)) {
    throw new HttpError(413, 'That upload is larger than the remaining space');
  }
}

export function nodeDto(node: NodeRow, permission: Access) {
  return {
    id: node.id,
    parentId: node.parent_id,
    name: node.name,
    kind: node.kind,
    mime: node.mime,
    sizeBytes: node.size_bytes,
    version: node.content_version,
    visibility: node.visibility,
    updatedAt: node.updated_at,
    deletedAt: node.deleted_at,
    permission,
    image: isImageMime(node.mime),
  };
}

export function requireNode(db: DatabaseSync, id: string) {
  const node = getNode(db, id);
  if (!node) throw new HttpError(404, 'Item not found');
  return node;
}

export function requireAccess(db: DatabaseSync, userId: string, id: string, need: Access) {
  const node = requireNode(db, id);
  const level = accessLevel(db, userId, id);
  if (!level) throw new HttpError(404, 'Item not found');
  const rank = { view: 1, edit: 2, owner: 3 };
  if (rank[level] < rank[need]) throw new HttpError(403, 'You cannot change that item');
  return { node, level };
}

export function listChildren(db: DatabaseSync, ownerId: string, parentId: string | null) {
  const rows = db
    .prepare(
      `SELECT * FROM nodes WHERE owner_id = ? AND ifnull(parent_id, '') = ? AND deleted_at IS NULL ORDER BY kind DESC, name COLLATE NOCASE`,
    )
    .all(ownerId, parentId ?? '') as Record<string, unknown>[];
  return rows.map((row) => asNode(row)!);
}

export function breadcrumb(db: DatabaseSync, userId: string, folderId: string | null) {
  if (!folderId) return [{ id: null as string | null, name: 'My files' }];
  const chain: NodeRow[] = [];
  let current: NodeRow | undefined = getNode(db, folderId);
  const guard = new Set<string>();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    chain.push(current);
    current = current.parent_id ? getNode(db, current.parent_id) : undefined;
  }
  chain.reverse();
  const visible = chain.filter((node) => accessLevel(db, userId, node.id));
  const owner = visible[0]?.owner_id === userId;
  const crumbs = owner ? [{ id: null as string | null, name: 'My files' }] : [];
  for (const node of visible) crumbs.push({ id: node.id, name: node.name });
  return crumbs;
}

export function createFolder(db: DatabaseSync, ownerId: string, parentId: string | null, rawName: string) {
  const name = uniqueName(db, ownerId, parentId, cleanName(rawName));
  const now = Date.now();
  const id = cryptoId();
  db.prepare(
    `INSERT INTO nodes (id, owner_id, parent_id, name, kind, mime, size_bytes, content_version, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'folder', NULL, 0, 1, 'private', ?, ?)`,
  ).run(id, ownerId, parentId, name, now, now);
  ftsUpsert(db, id, name);
  return requireNode(db, id);
}

function cryptoId() {
  return globalThis.crypto.randomUUID();
}

export function renameNode(db: DatabaseSync, node: NodeRow, rawName: string) {
  const name = uniqueName(db, node.owner_id, node.parent_id, cleanName(rawName), node.id);
  db.prepare('UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), node.id);
  ftsUpsert(db, node.id, name);
  return requireNode(db, node.id);
}

function isInside(db: DatabaseSync, ancestorId: string, nodeId: string) {
  const row = db
    .prepare(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_id FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.id, n.parent_id FROM nodes n JOIN chain c ON n.id = c.parent_id
       )
       SELECT 1 AS ok FROM chain WHERE id = ? LIMIT 1`,
    )
    .get(nodeId, ancestorId) as { ok: number } | undefined;
  return Boolean(row);
}

export function moveNode(db: DatabaseSync, node: NodeRow, parentId: string | null) {
  if (parentId === node.id || (parentId && isInside(db, node.id, parentId))) {
    throw new HttpError(400, 'A folder cannot be moved into itself');
  }
  if (parentId) {
    const parent = requireNode(db, parentId);
    if (parent.kind !== 'folder') throw new HttpError(400, 'Items can only be moved into a folder');
    if (parent.owner_id !== node.owner_id) throw new HttpError(403, 'That folder belongs to someone else');
    if (inTrash(db, parent.id)) throw new HttpError(400, 'That folder is in the trash');
  }
  const name = uniqueName(db, node.owner_id, parentId, node.name, node.id);
  db.prepare('UPDATE nodes SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?').run(parentId, name, Date.now(), node.id);
  return requireNode(db, node.id);
}

export function trashNode(db: DatabaseSync, node: NodeRow) {
  if (node.deleted_at) return node;
  const now = Date.now();
  db.prepare('UPDATE nodes SET deleted_at = ?, restore_parent_id = parent_id, public_token = NULL, updated_at = ? WHERE id = ?').run(
    now,
    now,
    node.id,
  );
  for (const id of descendantIds(db, node.id)) ftsRemove(db, id);
  return requireNode(db, node.id);
}

export function restoreNode(db: DatabaseSync, node: NodeRow) {
  if (!node.deleted_at) return node;
  let parentId = node.restore_parent_id;
  if (parentId) {
    const parent = getNode(db, parentId);
    if (!parent || parent.owner_id !== node.owner_id || inTrash(db, parent.id) || parent.kind !== 'folder') parentId = null;
  }
  const name = uniqueName(db, node.owner_id, parentId, node.name, node.id);
  db.prepare(
    'UPDATE nodes SET deleted_at = NULL, parent_id = ?, restore_parent_id = NULL, name = ?, updated_at = ? WHERE id = ?',
  ).run(parentId, name, Date.now(), node.id);
  const rows = db
    .prepare(
      `WITH RECURSIVE tree AS (
         SELECT id, name FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.id, n.name FROM nodes n JOIN tree t ON n.parent_id = t.id
       )
       SELECT id, name FROM tree`,
    )
    .all(node.id) as { id: string; name: string }[];
  for (const row of rows) ftsUpsert(db, row.id, row.name);
  return requireNode(db, node.id);
}

export function removeTree(db: DatabaseSync, storageDir: string, rootId: string) {
  const node = getNode(db, rootId);
  if (!node) return;
  const ids = descendantIds(db, rootId);
  for (const id of ids) {
    const item = getNode(db, id);
    if (!item || item.kind !== 'file') continue;
    fs.rmSync(userFile(storageDir, item.owner_id, item.id), { force: true });
    fs.rmSync(userThumb(storageDir, item.owner_id, item.id), { force: true });
  }
  const dropShare = db.prepare('DELETE FROM shares WHERE node_id = ?');
  const dropFts = db.prepare('DELETE FROM nodes_fts WHERE node_id = ?');
  const dropNode = db.prepare('DELETE FROM nodes WHERE id = ?');
  for (const id of ids) {
    dropShare.run(id);
    dropFts.run(id);
  }
  for (const id of ids.reverse()) dropNode.run(id);
  recalcUsed(db, node.owner_id);
}

export function emptyTrash(db: DatabaseSync, storageDir: string, ownerId: string) {
  const rows = db.prepare('SELECT id FROM nodes WHERE owner_id = ? AND deleted_at IS NOT NULL').all(ownerId) as { id: string }[];
  for (const row of rows) removeTree(db, storageDir, row.id);
}

export function searchNames(db: DatabaseSync, userId: string, query: string) {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return [];
  const match = tokens.map((token) => `"${token.replaceAll('"', '')}"*`).join(' AND ');
  let rows: { node_id: string }[] = [];
  try {
    rows = db.prepare('SELECT node_id FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 200').all(match) as { node_id: string }[];
  } catch {
    return [];
  }
  const found: NodeRow[] = [];
  for (const row of rows) {
    const node = getNode(db, row.node_id);
    if (!node || inTrash(db, node.id)) continue;
    if (!accessLevel(db, userId, node.id)) continue;
    found.push(node);
  }
  return found;
}

export function sharedWith(db: DatabaseSync, userId: string) {
  const rows = db
    .prepare(
      `SELECT n.* FROM shares s JOIN nodes n ON n.id = s.node_id
       WHERE s.grantee_id = ? AND n.deleted_at IS NULL ORDER BY n.name COLLATE NOCASE`,
    )
    .all(userId) as Record<string, unknown>[];
  return rows.map((row) => asNode(row)!).filter((node) => !inTrash(db, node.id));
}

export function listTrash(db: DatabaseSync, ownerId: string, query: string) {
  const needle = query.trim().toLowerCase();
  const rows = db
    .prepare('SELECT * FROM nodes WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC')
    .all(ownerId) as Record<string, unknown>[];
  return rows
    .map((row) => asNode(row)!)
    .filter((node) => !needle || node.name.toLowerCase().includes(needle));
}

export function setAccess(
  db: DatabaseSync,
  node: NodeRow,
  visibility: 'private' | 'shared' | 'public',
  shares: { username: string; permission: 'view' | 'edit' }[],
) {
  db.prepare('DELETE FROM shares WHERE node_id = ?').run(node.id);
  if (visibility === 'private' || (visibility === 'shared' && shares.length === 0)) {
    db.prepare(`UPDATE nodes SET visibility = 'private', public_token = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), node.id);
    return requireNode(db, node.id);
  }
  if (visibility === 'public') {
    const token = node.public_token ?? randomToken();
    db.prepare(`UPDATE nodes SET visibility = 'public', public_token = ?, updated_at = ? WHERE id = ?`).run(token, Date.now(), node.id);
    return requireNode(db, node.id);
  }
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(node.owner_id) as { username: string };
  const insert = db.prepare('INSERT INTO shares (node_id, grantee_id, permission) VALUES (?, ?, ?)');
  const seen = new Set<string>();
  for (const share of shares) {
    const username = share.username.trim().toLowerCase();
    if (!username || username === owner.username || seen.has(username)) continue;
    if (share.permission !== 'view' && share.permission !== 'edit') throw new HttpError(400, 'Permission must be view or edit');
    const user = db.prepare('SELECT id FROM users WHERE username = ? AND disabled = 0').get(username) as { id: string } | undefined;
    if (!user) throw new HttpError(400, `No active user named ${username}`);
    seen.add(username);
    insert.run(node.id, user.id, share.permission);
  }
  if (seen.size === 0) {
    db.prepare(`UPDATE nodes SET visibility = 'private', public_token = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), node.id);
  } else {
    db.prepare(`UPDATE nodes SET visibility = 'shared', public_token = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), node.id);
  }
  return requireNode(db, node.id);
}

function randomToken() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export function shareList(db: DatabaseSync, nodeId: string) {
  return db
    .prepare(
      `SELECT u.username AS username, s.permission AS permission
       FROM shares s JOIN users u ON u.id = s.grantee_id
       WHERE s.node_id = ? ORDER BY u.username`,
    )
    .all(nodeId) as { username: string; permission: 'view' | 'edit' }[];
}

export function readText(storageDir: string, node: NodeRow) {
  if (node.kind !== 'file') throw new HttpError(400, 'Folders have no text to edit');
  if (node.size_bytes > 2 * 1024 * 1024) throw new HttpError(413, 'This file is too large to edit here');
  const file = userFile(storageDir, node.owner_id, node.id);
  if (!fs.existsSync(file)) throw new HttpError(404, 'File bytes are missing');
  return fs.readFileSync(file, 'utf8');
}

export function writeText(db: DatabaseSync, storageDir: string, node: NodeRow, content: string, version: number) {
  if (node.kind !== 'file') throw new HttpError(400, 'Folders have no text to edit');
  if (node.content_version !== version) {
    throw new HttpError(409, 'This file changed. Reload to see the new version.', {
      version: node.content_version,
      content: readText(storageDir, node),
    });
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > 2 * 1024 * 1024) throw new HttpError(413, 'That text is too large to save here');
  assertQuota(db, node.owner_id, Math.max(0, bytes.length - node.size_bytes));
  writeAtomic(userFile(storageDir, node.owner_id, node.id), bytes);
  db.prepare('UPDATE nodes SET size_bytes = ?, content_version = content_version + 1, updated_at = ? WHERE id = ?').run(
    bytes.length,
    Date.now(),
    node.id,
  );
  recalcUsed(db, node.owner_id);
  return requireNode(db, node.id);
}

export function publicRoot(db: DatabaseSync, token: string) {
  const node = asNode(db.prepare('SELECT * FROM nodes WHERE public_token = ?').get(token) as Record<string, unknown> | undefined);
  if (!node || inTrash(db, node.id)) return undefined;
  return node;
}

export function isDescendant(db: DatabaseSync, ancestorId: string, nodeId: string) {
  return ancestorId === nodeId || isInside(db, ancestorId, nodeId);
}
