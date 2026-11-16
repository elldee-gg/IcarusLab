import type { DatabaseSync } from 'node:sqlite';
import { metaGet, metaSet } from './db.js';
import { HttpError } from './http-error.js';

export const COLOR_MODES = ['system', 'light', 'dark'] as const;
export const AESTHETICS = ['win98', 'winxp', 'winvista', 'modern', 'html'] as const;

export type ColorMode = (typeof COLOR_MODES)[number];
export type Aesthetic = (typeof AESTHETICS)[number];

export type Appearance = { colorMode: ColorMode; aesthetic: Aesthetic };

const DEFAULT_APPEARANCE: Appearance = { colorMode: 'system', aesthetic: 'winvista' };

export function readAppearance(db: DatabaseSync): Appearance {
  const raw = metaGet(db, 'appearance');
  if (!raw) return DEFAULT_APPEARANCE;
  try {
    const parsed = JSON.parse(raw) as { colorMode?: unknown; aesthetic?: unknown };
    return {
      colorMode: isColorMode(parsed.colorMode) ? parsed.colorMode : DEFAULT_APPEARANCE.colorMode,
      aesthetic: isAesthetic(parsed.aesthetic) ? parsed.aesthetic : DEFAULT_APPEARANCE.aesthetic,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function allowLan(db: DatabaseSync) {
  return metaGet(db, 'allow_lan') !== '0';
}

export function readSettings(db: DatabaseSync) {
  return { allowLan: allowLan(db) };
}

export function updateSettings(db: DatabaseSync, body: Record<string, unknown>) {
  if (typeof body.allowLan !== 'boolean') throw new HttpError(400, 'Allow LAN must be on or off');
  metaSet(db, 'allow_lan', body.allowLan ? '1' : '0');
  return readSettings(db);
}

export function appearanceFor(db: DatabaseSync, role: 'admin' | 'user', userId: string): Appearance {
  if (role === 'admin') return readAppearance(db);
  const row = db.prepare('SELECT color_mode, aesthetic FROM users WHERE id = ?').get(userId) as { color_mode?: string; aesthetic?: string } | undefined;
  return normalizeAppearance(row?.color_mode, row?.aesthetic);
}

export function saveAppearance(db: DatabaseSync, role: 'admin' | 'user', userId: string, body: Record<string, unknown>) {
  const current = appearanceFor(db, role, userId);
  const colorMode = body.colorMode === undefined ? current.colorMode : body.colorMode;
  const aesthetic = body.aesthetic === undefined ? current.aesthetic : body.aesthetic;
  if (!isColorMode(colorMode)) throw new HttpError(400, 'Choose light, dark, or match this computer');
  if (!isAesthetic(aesthetic)) throw new HttpError(400, 'Choose an appearance');
  const next = { colorMode, aesthetic };
  if (role === 'admin') metaSet(db, 'appearance', JSON.stringify(next));
  else db.prepare('UPDATE users SET color_mode = ?, aesthetic = ?, updated_at = ? WHERE id = ?').run(colorMode, aesthetic, Date.now(), userId);
  return next;
}

function normalizeAppearance(colorMode: unknown, aesthetic: unknown): Appearance {
  return {
    colorMode: isColorMode(colorMode) ? colorMode : DEFAULT_APPEARANCE.colorMode,
    aesthetic: isAesthetic(aesthetic) ? aesthetic : DEFAULT_APPEARANCE.aesthetic,
  };
}

export function isLoopback(ip: string) {
  const host = ip.toLowerCase().replace(/^::ffff:/i, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function isColorMode(value: unknown): value is ColorMode {
  return typeof value === 'string' && (COLOR_MODES as readonly string[]).includes(value);
}

function isAesthetic(value: unknown): value is Aesthetic {
  return typeof value === 'string' && (AESTHETICS as readonly string[]).includes(value);
}
