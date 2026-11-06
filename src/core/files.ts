import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry } from './model.js';

export interface TreeContents {
  /** Regular files, sorted by path. */
  files: FileEntry[];
  /** Symbolic links, sorted by path. Never followed, and not in `files`. */
  symlinks: string[];
}

/**
 * Reads the directory `dir` recursively. Paths are relative to `dir`, use `/` on every platform, and are
 * sorted by plain string comparison (so the order does not depend on locale or on the file system).
 * `executable` is true when any execute bit is set.
 *
 * A symbolic link, to a file or to a directory, is never followed: it is listed in `symlinks` and is
 * not in `files`, and a linked directory is not entered, so nothing from outside `dir` is read.
 * `.git` entries, at any depth, are skipped. Other entries that are neither regular files nor
 * directories (sockets, FIFOs, devices) are skipped without being opened.
 *
 * `dir` itself is resolved by the operating system, so a caller that must not read through a link at
 * the top has to check that first. Rejects if `dir`, or a directory in it, cannot be read.
 */
export async function readTree(dir: string): Promise<TreeContents> {
  const files: FileEntry[] = [];
  const symlinks: string[] = [];
  await walk(dir, '', files, symlinks);
  files.sort((a, b) => compare(a.path, b.path));
  symlinks.sort(compare);
  return { files, symlinks };
}

async function walk(root: string, rel: string, files: FileEntry[], symlinks: string[]): Promise<void> {
  const abs = rel === '' ? root : path.join(root, ...rel.split('/'));
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    // Checked before the `.git` name, so a link is never silently dropped.
    if (entry.isSymbolicLink()) {
      symlinks.push(entryRel);
    } else if (entry.name !== '.git' && entry.isDirectory()) {
      await walk(root, entryRel, files, symlinks);
    } else if (entry.name !== '.git' && entry.isFile()) {
      const file = path.join(abs, entry.name);
      const { mode } = await lstat(file);
      files.push({
        path: entryRel,
        bytes: new Uint8Array(await readFile(file)),
        executable: (mode & 0o111) !== 0,
      });
    }
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
