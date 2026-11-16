import fs from 'node:fs';
import path from 'node:path';

export type Config = {
  host: string;
  port: number;
  root: string;
  dataDir: string;
  storageDir: string;
  adminUsername: string;
  adminPassword: string;
  chunkSize: number;
  diskReserve: number;
  defaultQuota: number;
  clientDist: string;
};

export function loadEnvFile(file: string) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig(): Config {
  const root = path.resolve(process.env.ICARUS_ROOT ?? path.join(import.meta.dirname, '..', '..'));
  loadEnvFile(path.join(root, '.env'));
  const adminUsername = process.env.ADMIN_USERNAME?.trim() ?? '';
  const adminPassword = process.env.ADMIN_PASSWORD ?? '';
  if (!adminUsername || !adminPassword) {
    throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment or in .env');
  }
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
  const storageDir = path.resolve(process.env.STORAGE_DIR ?? path.join(root, 'storage'));
  return {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: Number(process.env.PORT ?? 8443),
    root,
    dataDir,
    storageDir,
    adminUsername,
    adminPassword,
    chunkSize: 8 * 1024 * 1024,
    diskReserve: 512 * 1024 * 1024,
    defaultQuota: 10 * 1024 * 1024 * 1024,
    clientDist: path.join(root, 'client', 'dist'),
  };
}
