import fs from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertId(id: string) {
  if (!UUID.test(id)) throw new Error('Invalid id');
  return id;
}

export function userFile(storageDir: string, ownerId: string, nodeId: string) {
  return path.join(storageDir, assertId(ownerId), 'files', assertId(nodeId));
}

export function userThumb(storageDir: string, ownerId: string, nodeId: string) {
  return path.join(storageDir, assertId(ownerId), '.thumbs', `${assertId(nodeId)}.webp`);
}

export function uploadDir(storageDir: string, ownerId: string, uploadId: string) {
  return path.join(storageDir, assertId(ownerId), '.uploads', assertId(uploadId));
}

export function chunkFile(storageDir: string, ownerId: string, uploadId: string, index: number) {
  if (!Number.isInteger(index) || index < 0 || index > 1_000_000) throw new Error('Invalid chunk');
  return path.join(uploadDir(storageDir, ownerId, uploadId), String(index));
}

export function freeBytes(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const stats = fs.statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

export function diskInfo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const stats = fs.statfsSync(dir);
  const block = Number(stats.bsize);
  return { freeBytes: Number(stats.bavail) * block, totalBytes: Number(stats.blocks) * block };
}
