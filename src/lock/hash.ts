import { createHash } from 'node:crypto';
import type { FileEntry } from '../core/model.js';

/**
 * The `sha256` of a skill directory in `ronin.lock` (spec 5.8): the SHA-256 hex digest of the
 * concatenation, over the files sorted by path (plain string comparison), of
 * `<path>\0<1 if executable, else 0>\0<SHA-256 hex of the file's bytes>\n`. Does not modify `files`.
 */
export function hashSkillFiles(files: FileEntry[]): string {
  const outer = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    outer.update(`${file.path}\0${file.executable ? '1' : '0'}\0${sha256Hex(file.bytes)}\n`);
  }
  return outer.digest('hex');
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
