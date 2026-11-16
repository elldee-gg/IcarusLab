import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { HttpError } from './http-error.js';
import { metaGet, metaSet } from './db.js';

export type BackupSettings = {
  destination: string;
  cadence: 'hourly' | 'daily' | 'weekly';
  hour: number;
  minute: number;
  weekday: number;
  keep: number;
  nextRun: number | null;
};

const DEFAULTS: BackupSettings = {
  destination: '',
  cadence: 'daily',
  hour: 2,
  minute: 0,
  weekday: 0,
  keep: 7,
  nextRun: null,
};

let running = false;

export function isBackupRunning() {
  return running;
}

export function readSettings(db: DatabaseSync): BackupSettings {
  const raw = metaGet(db, 'backup_settings');
  if (!raw) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...(JSON.parse(raw) as BackupSettings) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(db: DatabaseSync, config: Config, input: Partial<BackupSettings>) {
  const current = readSettings(db);
  const next: BackupSettings = {
    destination: typeof input.destination === 'string' ? input.destination.trim() : current.destination,
    cadence: input.cadence === 'hourly' || input.cadence === 'weekly' || input.cadence === 'daily' ? input.cadence : current.cadence,
    hour: clamp(input.hour ?? current.hour, 0, 23),
    minute: clamp(input.minute ?? current.minute, 0, 59),
    weekday: clamp(input.weekday ?? current.weekday, 0, 6),
    keep: clamp(input.keep ?? current.keep, 1, 100),
    nextRun: null,
  };
  if (next.destination) assertDestination(config, next.destination);
  next.nextRun = next.destination ? computeNext(next, Date.now()) : null;
  metaSet(db, 'backup_settings', JSON.stringify(next));
  return next;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function assertDestination(config: Config, destination: string) {
  if (!path.isAbsolute(destination)) throw new HttpError(400, 'The backup folder must be an absolute path');
  const resolved = path.resolve(destination);
  const blocked = [path.resolve(config.dataDir), path.resolve(config.storageDir)];
  const lower = resolved.toLowerCase();
  for (const dir of blocked) {
    const block = dir.toLowerCase();
    if (lower === block || lower.startsWith(block + path.sep)) {
      throw new HttpError(400, 'The backup folder must sit outside data and storage');
    }
  }
}

export function computeNext(settings: BackupSettings, fromMs: number) {
  const from = new Date(fromMs);
  if (settings.cadence === 'hourly') {
    const next = new Date(from);
    next.setMinutes(settings.minute, 0, 0);
    if (next.getTime() <= fromMs) next.setHours(next.getHours() + 1);
    return next.getTime();
  }
  const next = new Date(from);
  next.setHours(settings.hour, settings.minute, 0, 0);
  if (settings.cadence === 'weekly') {
    const delta = (settings.weekday - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + delta);
    if (next.getTime() <= fromMs) next.setDate(next.getDate() + 7);
    return next.getTime();
  }
  if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export function listRuns(db: DatabaseSync) {
  return db.prepare('SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 20').all() as {
    id: string;
    destination: string;
    status: string;
    started_at: number;
    finished_at: number | null;
    error: string | null;
    bytes_copied: number;
  }[];
}

export function queueBackup(db: DatabaseSync, config: Config) {
  if (running) throw new HttpError(409, 'A backup is already running');
  const settings = readSettings(db);
  if (!settings.destination) throw new HttpError(400, 'Choose a backup folder first');
  assertDestination(config, settings.destination);
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const folder = path.join(settings.destination, stamp);
  db.prepare(
    `INSERT INTO backup_runs (id, destination, status, started_at, finished_at, error, bytes_copied) VALUES (?, ?, 'in_progress', ?, NULL, NULL, 0)`,
  ).run(id, folder, Date.now());
  running = true;
  void executeBackup(db, config, id, folder, settings.keep)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Backup failed';
      failRun(db, id, folder, message);
    })
    .finally(() => {
      running = false;
    });
  return { id };
}

function failRun(db: DatabaseSync, id: string, folder: string, message: string) {
  fs.rmSync(folder, { recursive: true, force: true });
  db.prepare(`UPDATE backup_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`).run(Date.now(), message, id);
}

export async function executeBackup(db: DatabaseSync, config: Config, id: string, folder: string, keep: number) {
  fs.mkdirSync(folder, { recursive: true });
  const snapshot = path.join(folder, 'icarus.sqlite');
  const sqlPath = snapshot.replaceAll('\\', '/').replaceAll("'", "''");
  db.exec(`VACUUM INTO '${sqlPath}'`);
  const previous = db
    .prepare(`SELECT destination FROM backup_runs WHERE status = 'succeeded' ORDER BY started_at DESC LIMIT 1`)
    .get() as { destination: string } | undefined;
  let bytes = 0;
  bytes += await copyTree(config.storageDir, path.join(folder, 'storage'), previous ? path.join(previous.destination, 'storage') : null);
  for (const name of ['jwt.secret', 'ca.crt', 'ca.key', 'server.crt', 'server.key', 'admin-phrase.once.txt']) {
    const source = path.join(config.dataDir, name);
    if (!fs.existsSync(source)) continue;
    const dest = path.join(folder, name);
    await copyAtomic(source, dest);
    bytes += fs.statSync(source).size;
  }
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    restore: 'Stop IcarusLab. Replace the data and storage folders with this copy, then start it again with the same admin environment variables.',
  };
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
  db.prepare(`UPDATE backup_runs SET status = 'succeeded', finished_at = ?, bytes_copied = ? WHERE id = ?`).run(Date.now(), bytes, id);
  prune(db, keep);
  const settings = readSettings(db);
  if (settings.destination) {
    settings.nextRun = computeNext(settings, Date.now());
    metaSet(db, 'backup_settings', JSON.stringify(settings));
  }
}

function prune(db: DatabaseSync, keep: number) {
  const rows = db.prepare(`SELECT id, destination FROM backup_runs WHERE status = 'succeeded' ORDER BY started_at DESC`).all() as {
    id: string;
    destination: string;
  }[];
  for (const old of rows.slice(keep)) {
    fs.rmSync(old.destination, { recursive: true, force: true });
    db.prepare('DELETE FROM backup_runs WHERE id = ?').run(old.id);
  }
}

async function copyTree(sourceRoot: string, destRoot: string, previousRoot: string | null) {
  let bytes = 0;
  if (!fs.existsSync(sourceRoot)) return bytes;
  const visit = async (dir: string) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.uploads') continue;
      const source = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(source);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(sourceRoot, source);
      const dest = path.join(destRoot, rel);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const live = await fs.promises.stat(source);
      const prev = previousRoot ? path.join(previousRoot, rel) : '';
      let linked = false;
      if (prev && fs.existsSync(prev)) {
        const old = await fs.promises.stat(prev);
        if (old.size === live.size && Math.abs(old.mtimeMs - live.mtimeMs) < 1) {
          try {
            await fs.promises.link(prev, dest);
            linked = true;
          } catch {
            linked = false;
          }
        }
      }
      if (!linked) await copyAtomic(source, dest);
      bytes += live.size;
    }
  };
  await visit(sourceRoot);
  return bytes;
}

async function copyAtomic(source: string, dest: string) {
  const tmp = `${dest}.partial`;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(source, tmp);
  const handle = await fs.promises.open(tmp, 'r+');
  await handle.sync();
  await handle.close();
  await fs.promises.rename(tmp, dest);
}

export function startScheduler(db: DatabaseSync, config: Config) {
  const timer = setInterval(() => {
    const settings = readSettings(db);
    if (!settings.destination || settings.nextRun == null || settings.nextRun > Date.now() || running) return;
    try {
      queueBackup(db, config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
  }, 30_000);
  timer.unref();
  return timer;
}
