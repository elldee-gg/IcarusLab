import fs from 'node:fs';
import path from 'node:path';

export function writeAtomic(file: string, data: Buffer | string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fh = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fh, data);
    fs.fsyncSync(fh);
  } finally {
    fs.closeSync(fh);
  }
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch {
    // Windows cannot fsync a directory. The file fsync above is the durability point.
  }
}

export function fsyncFile(file: string) {
  const fh = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fh);
  } finally {
    fs.closeSync(fh);
  }
}
