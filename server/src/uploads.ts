import fs from 'node:fs';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './http-error.js';
import { assertQuota, ftsUpsert, getNode, recalcUsed, requireNode, uniqueName } from './nodes.js';
import { chunkFile, freeBytes, uploadDir, userFile } from './paths.js';

export type UploadRow = {
  id: string;
  owner_id: string;
  actor_id: string;
  parent_id: string | null;
  name: string;
  mime: string | null;
  total_bytes: number;
  received_bytes: number;
  status: string;
  result_node_id: string | null;
  created_at: number;
  expires_at: number;
};

function num(value: unknown) {
  return typeof value === 'bigint' ? Number(value) : Number(value);
}

export function asUpload(row: Record<string, unknown> | undefined): UploadRow | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    actor_id: String(row.actor_id),
    parent_id: row.parent_id == null ? null : String(row.parent_id),
    name: String(row.name),
    mime: row.mime == null ? null : String(row.mime),
    total_bytes: num(row.total_bytes),
    received_bytes: num(row.received_bytes),
    status: String(row.status),
    result_node_id: row.result_node_id == null ? null : String(row.result_node_id),
    created_at: num(row.created_at),
    expires_at: num(row.expires_at),
  };
}

export function getUpload(db: DatabaseSync, id: string) {
  return asUpload(db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as Record<string, unknown> | undefined);
}

export function chunkCount(total: number, chunkSize: number) {
  if (total <= 0) return 0;
  return Math.ceil(total / chunkSize);
}

export function expectedChunkSize(total: number, index: number, chunkSize: number) {
  const count = chunkCount(total, chunkSize);
  if (index < 0 || index >= count) return -1;
  const start = index * chunkSize;
  return Math.min(chunkSize, total - start);
}

export function createUpload(
  db: DatabaseSync,
  storageDir: string,
  diskReserve: number,
  ownerId: string,
  actorId: string,
  parentId: string | null,
  name: string,
  mime: string | null,
  totalBytes: number,
) {
  if (!Number.isFinite(totalBytes) || totalBytes < 0) throw new HttpError(400, 'File size is invalid');
  assertQuota(db, ownerId, totalBytes);
  if (freeBytes(storageDir) < totalBytes + diskReserve) throw new HttpError(507, 'The server disk does not have room for that file');
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO uploads (id, owner_id, actor_id, parent_id, name, mime, total_bytes, received_bytes, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, ?)`,
  ).run(id, ownerId, actorId, parentId, name, mime, totalBytes, now, now + 24 * 60 * 60 * 1000);
  return getUpload(db, id)!;
}

export function receivedIndexes(db: DatabaseSync, uploadId: string) {
  return (db.prepare('SELECT idx FROM upload_chunks WHERE upload_id = ? ORDER BY idx').all(uploadId) as { idx: number }[]).map(
    (row) => num(row.idx),
  );
}

export async function writeChunk(req: IncomingMessage, file: string, expectedSize: number, expectedHash: string) {
  await fs.promises.mkdir(pathDir(file), { recursive: true });
  const tmp = `${file}.partial`;
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(tmp, 'w');
  let size = 0;
  try {
    for await (const piece of req) {
      const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      size += buf.length;
      if (size > expectedSize) throw new HttpError(400, 'Chunk is larger than expected');
      hash.update(buf);
      await handle.write(buf);
    }
    if (size !== expectedSize) throw new HttpError(400, 'Chunk size does not match');
    const digest = hash.digest('hex');
    if (digest !== expectedHash.toLowerCase()) throw new HttpError(400, 'Chunk checksum does not match');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.promises.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  await fs.promises.rename(tmp, file);
}

function pathDir(file: string) {
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
}

export function recordChunk(db: DatabaseSync, upload: UploadRow, index: number, size: number) {
  const existing = db.prepare('SELECT size_bytes FROM upload_chunks WHERE upload_id = ? AND idx = ?').get(upload.id, index) as
    | { size_bytes: number | bigint }
    | undefined;
  if (existing) {
    db.prepare('UPDATE upload_chunks SET size_bytes = ? WHERE upload_id = ? AND idx = ?').run(size, upload.id, index);
    db.prepare('UPDATE uploads SET received_bytes = received_bytes - ? + ? WHERE id = ?').run(num(existing.size_bytes), size, upload.id);
  } else {
    db.prepare('INSERT INTO upload_chunks (upload_id, idx, size_bytes) VALUES (?, ?, ?)').run(upload.id, index, size);
    db.prepare('UPDATE uploads SET received_bytes = received_bytes + ? WHERE id = ?').run(size, upload.id);
  }
}

export async function assembleUpload(storageDir: string, upload: UploadRow, chunkSize: number, dest: string) {
  await fs.promises.mkdir(pathDir(dest), { recursive: true });
  const tmp = `${dest}.partial`;
  const out = await fs.promises.open(tmp, 'w');
  try {
    const count = chunkCount(upload.total_bytes, chunkSize);
    const buf = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < count; index += 1) {
      const source = chunkFile(storageDir, upload.owner_id, upload.id, index);
      const input = await fs.promises.open(source, 'r');
      try {
        let position = 0;
        while (true) {
          const { bytesRead } = await input.read(buf, 0, buf.length, position);
          if (bytesRead === 0) break;
          await out.write(buf, 0, bytesRead, null);
          position += bytesRead;
        }
      } finally {
        await input.close();
      }
    }
    await out.sync();
  } catch (error) {
    await out.close().catch(() => undefined);
    await fs.promises.rm(tmp, { force: true });
    throw error;
  }
  await out.close();
  await fs.promises.rename(tmp, dest);
}

export function commitUpload(db: DatabaseSync, storageDir: string, upload: UploadRow) {
  if (!upload.result_node_id) throw new HttpError(500, 'Upload has no destination');
  const existing = getNode(db, upload.result_node_id);
  if (!existing) {
    const name = uniqueName(db, upload.owner_id, upload.parent_id, upload.name);
    const now = Date.now();
    db.prepare(
      `INSERT INTO nodes (id, owner_id, parent_id, name, kind, mime, size_bytes, content_version, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'file', ?, ?, 1, 'private', ?, ?)`,
    ).run(upload.result_node_id, upload.owner_id, upload.parent_id, name, upload.mime, upload.total_bytes, now, now);
    ftsUpsert(db, upload.result_node_id, name);
    recalcUsed(db, upload.owner_id);
  }
  db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(upload.id);
  db.prepare('DELETE FROM uploads WHERE id = ?').run(upload.id);
  fs.rmSync(uploadDir(storageDir, upload.owner_id, upload.id), { recursive: true, force: true });
  return requireNode(db, upload.result_node_id);
}

export function abortUpload(db: DatabaseSync, storageDir: string, upload: UploadRow) {
  fs.rmSync(uploadDir(storageDir, upload.owner_id, upload.id), { recursive: true, force: true });
  if (upload.result_node_id && !getNode(db, upload.result_node_id)) {
    fs.rmSync(userFile(storageDir, upload.owner_id, upload.result_node_id), { force: true });
  }
  db.prepare('DELETE FROM upload_chunks WHERE upload_id = ?').run(upload.id);
  db.prepare('DELETE FROM uploads WHERE id = ?').run(upload.id);
}
