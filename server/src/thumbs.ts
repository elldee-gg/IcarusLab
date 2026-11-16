import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isImageMime, type NodeRow } from './nodes.js';
import { userFile, userThumb } from './paths.js';

const inflight = new Set<string>();

export function scheduleThumb(storageDir: string, node: NodeRow) {
  if (!isImageMime(node.mime) || node.kind !== 'file') return;
  const dest = userThumb(storageDir, node.owner_id, node.id);
  if (fs.existsSync(dest) || inflight.has(node.id)) return;
  inflight.add(node.id);
  void (async () => {
    const tmp = `${dest}.partial`;
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await sharp(userFile(storageDir, node.owner_id, node.id))
        .rotate()
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 })
        .toFile(tmp);
      const handle = await fs.promises.open(tmp, 'r+');
      await handle.sync();
      await handle.close();
      await fs.promises.rename(tmp, dest);
    } catch {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    } finally {
      inflight.delete(node.id);
    }
  })();
}
