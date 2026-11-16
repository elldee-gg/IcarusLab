import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUser, findUserByName, notifyForgotPassword } from '../src/accounts.js';
import { executeBackup } from '../src/backups.js';
import { ensurePhrase, phrasePath, readPhraseFile, storePhraseHash, verifyPhrase } from '../src/bootstrap.js';
import type { Config } from '../src/config.js';
import { metaGet, openDatabase } from '../src/db.js';
import { accessLevel, canTrash, cleanName, createFolder, ftsUpsert, renameNode, restoreNode, searchNames, setAccess, trashNode } from '../src/nodes.js';
import { createUpload } from '../src/uploads.js';

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-'));
  const db = openDatabase(path.join(dir, 'data', 'icarus.sqlite'));
  const storage = path.join(dir, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  return { dir, db, storage };
}

function config(dir: string): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    root: dir,
    dataDir: path.join(dir, 'data'),
    storageDir: path.join(dir, 'storage'),
    adminUsername: 'admin',
    adminPassword: 'admin-secret',
    chunkSize: 8,
    diskReserve: 0,
    defaultQuota: 1000,
    clientDist: path.join(dir, 'client'),
  };
}

test('the admin phrase survives a restart and a crash before the hash is stored', () => {
  const { dir, db } = tempRoot();
  ensurePhrase(db, path.join(dir, 'data'));
  const phrase = readPhraseFile(path.join(dir, 'data'))!.trim();
  assert.equal(phrase.split(/\s+/).length, 12);
  const firstHash = metaGet(db, 'admin_phrase_hash');
  ensurePhrase(db, path.join(dir, 'data'));
  assert.equal(metaGet(db, 'admin_phrase_hash'), firstHash);
  assert.equal(verifyPhrase(db, phrase), true);

  db.prepare(`DELETE FROM server_meta WHERE key IN ('admin_phrase_hash', 'admin_phrase_salt')`).run();
  ensurePhrase(db, path.join(dir, 'data'));
  assert.equal(readPhraseFile(path.join(dir, 'data'))!.trim(), phrase);
  assert.equal(verifyPhrase(db, phrase), true);

  fs.rmSync(phrasePath(path.join(dir, 'data')));
  ensurePhrase(db, path.join(dir, 'data'));
  assert.equal(fs.existsSync(phrasePath(path.join(dir, 'data'))), false);
  assert.equal(verifyPhrase(db, phrase), true);
  storePhraseHash(db, phrase);
});

test('a forgotten password notifies the admin and leaves the hash unchanged', () => {
  const { db } = tempRoot();
  const user = createUser(db, 'admin', 'ada', 1000);
  notifyForgotPassword(db, 'ada');
  const again = findUserByName(db, 'ada')!;
  assert.equal(again.password_hash, user.password_hash);
  assert.equal(again.password_salt, user.password_salt);
  const note = db.prepare(`SELECT username FROM admin_notifications WHERE user_id = ? AND read_at IS NULL`).get(user.id) as { username: string };
  assert.equal(note.username, 'ada');
  notifyForgotPassword(db, 'ada');
  const count = db.prepare(`SELECT COUNT(*) AS n FROM admin_notifications WHERE user_id = ?`).get(user.id) as { n: number };
  assert.equal(Number(count.n), 1);
});

test('uploads cannot reserve more than the quota', () => {
  const { db, storage } = tempRoot();
  const user = createUser(db, 'admin', 'ada', 100);
  createUpload(db, storage, 0, user.id, user.id, null, 'a.txt', 'text/plain', 80);
  assert.throws(() => createUpload(db, storage, 0, user.id, user.id, null, 'b.txt', 'text/plain', 30), /remaining space/);
});

test('names are searchable until they are trashed, and restore brings them back', () => {
  const { db } = tempRoot();
  const user = createUser(db, 'admin', 'ada', 1000);
  const folder = createFolder(db, user.id, null, 'Notes');
  const file = createFolder(db, user.id, folder.id, 'hello.txt');
  ftsUpsert(db, file.id, file.name);
  assert.equal(searchNames(db, user.id, 'hello').length, 1);
  const renamed = renameNode(db, file, 'renamed.txt');
  assert.equal(searchNames(db, user.id, 'hello').length, 0);
  assert.equal(searchNames(db, user.id, 'renamed').length, 1);
  trashNode(db, renamed);
  assert.equal(searchNames(db, user.id, 'renamed').length, 0);
  restoreNode(db, { ...renamed, deleted_at: Date.now(), restore_parent_id: folder.id });
  assert.equal(searchNames(db, user.id, 'renamed').length, 1);
});

test('an editor can trash a child of a shared folder and not the shared folder itself', () => {
  const { db } = tempRoot();
  const owner = createUser(db, 'admin', 'ada', 1000);
  const editor = createUser(db, 'admin', 'bea', 1000);
  const folder = createFolder(db, owner.id, null, 'Shared');
  const child = createFolder(db, owner.id, folder.id, 'Inside');
  setAccess(db, folder, 'shared', [{ username: 'bea', permission: 'edit' }]);
  assert.equal(accessLevel(db, editor.id, child.id), 'edit');
  assert.equal(canTrash(db, editor.id, child.id), true);
  assert.equal(canTrash(db, editor.id, folder.id), false);
  assert.equal(accessLevel(db, editor.id, folder.id), 'edit');
});

test('backup snapshots can be opened and include the user table', async () => {
  const { dir, db } = tempRoot();
  createUser(db, 'admin', 'ada', 1000);
  const destination = path.join(dir, 'backups');
  fs.mkdirSync(destination, { recursive: true });
  const folder = path.join(destination, 'one');
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO backup_runs (id, destination, status, started_at, bytes_copied) VALUES (?, ?, 'in_progress', ?, 0)`).run(id, folder, Date.now());
  await executeBackup(db, config(dir), id, folder, 3);
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(path.join(folder, 'icarus.sqlite'));
  const row = copy.prepare(`SELECT username FROM users WHERE username = 'ada'`).get() as { username: string };
  assert.equal(row.username, 'ada');
  copy.close();
});

test('dot-only names are rejected', () => {
  assert.throws(() => cleanName('..'), /not allowed/);
});
