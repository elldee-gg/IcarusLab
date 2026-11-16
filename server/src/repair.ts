import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { recalcUsed } from './nodes.js';
import { chunkFile, uploadDir, userFile } from './paths.js';
import { abortUpload, asUpload, assembleUpload, chunkCount, commitUpload, getUpload, recordChunk } from './uploads.js';

function cleanOrphanUploads(db: DatabaseSync, storageDir: string) {
  if (!fs.existsSync(storageDir)) return;
  for (const owner of fs.readdirSync(storageDir)) {
    const dir = path.join(storageDir, owner, '.uploads');
    if (!fs.existsSync(dir)) continue;
    for (const id of fs.readdirSync(dir)) {
      const known = db.prepare('SELECT 1 AS ok FROM uploads WHERE id = ?').get(id);
      if (!known) fs.rmSync(path.join(dir, id), { recursive: true, force: true });
    }
  }
}

function walk(dir: string, visitor: (file: string) => void) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visitor);
    else if (entry.isFile()) visitor(full);
  }
}

export async function repairStorage(db: DatabaseSync, config: Config) {
  const partials: string[] = [];
  walk(config.storageDir, (file) => {
    if (file.endsWith('.partial')) partials.push(file);
  });
  for (const file of partials) fs.rmSync(file, { force: true });

  const uploads = (db.prepare('SELECT * FROM uploads').all() as Record<string, unknown>[]).map((row) => asUpload(row)!);
  const now = Date.now();
  for (const upload of uploads) {
    const dir = uploadDir(config.storageDir, upload.owner_id, upload.id);
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!/^\d+$/.test(name)) continue;
        const index = Number(name);
        const size = fs.statSync(path.join(dir, name)).size;
        const known = db.prepare('SELECT 1 AS ok FROM upload_chunks WHERE upload_id = ? AND idx = ?').get(upload.id, index);
        if (!known) recordChunk(db, upload, index, size);
      }
    }
    const fresh = getUpload(db, upload.id);
    if (!fresh) continue;
    if (fresh.status === 'assembling' && fresh.result_node_id) {
      const dest = userFile(config.storageDir, fresh.owner_id, fresh.result_node_id);
      if (!fs.existsSync(dest)) {
        const have = chunkCount(fresh.total_bytes, config.chunkSize);
        const got = db.prepare('SELECT COUNT(*) AS n FROM upload_chunks WHERE upload_id = ?').get(fresh.id) as { n: number };
        if (Number(got.n) === have) await assembleUpload(config.storageDir, fresh, config.chunkSize, dest);
      }
      if (fs.existsSync(dest)) {
        commitUpload(db, config.storageDir, fresh);
        continue;
      }
    }
    if (fresh.expires_at < now && fresh.status === 'open') abortUpload(db, config.storageDir, fresh);
  }

  const users = db.prepare('SELECT id FROM users').all() as { id: string }[];
  for (const user of users) recalcUsed(db, user.id);
  cleanOrphanUploads(db, config.storageDir);

  const runs = db.prepare(`SELECT id, destination FROM backup_runs WHERE status = 'in_progress'`).all() as {
    id: string;
    destination: string;
  }[];
  for (const run of runs) {
    fs.rmSync(run.destination, { recursive: true, force: true });
    db.prepare(`UPDATE backup_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`).run(
      Date.now(),
      'The backup was interrupted and its partial copy was removed',
      run.id,
    );
  }
}
