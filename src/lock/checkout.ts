import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { error } from '../core/diagnostics.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { SYMLINK_MESSAGE, isNotFound } from '../core/load-util.js';
import { NAME_RE } from '../core/model.js';
import type { FileEntry } from '../core/model.js';
import { LICENSE_FILE_NAMES } from './license.js';
import { LOCK_FILE } from './lockfile.js';

// Reading skills out of a checkout of a source repository (`ensureCommit`). Shared by `runLock`, which pins
// the skills, and by `resolveLibrary`, which reads them back and checks them against the lock, so that both
// look in the same place and word the same problems the same way.

/**
 * The path components of skill `skill` in a source repository whose skill directories are in `root` (spec
 * 5.7): the parts of `root` (either separator; empty and `.` parts dropped), then the skill name. Joined with
 * `/` this is `path` in `ronin.lock`.
 */
export function skillSegments(root: string, skill: string): string[] {
  return [...root.split(/[\\/]/).filter((s) => s !== '' && s !== '.'), skill];
}

export type Located = { kind: 'directory'; dir: string } | { kind: 'missing' } | { kind: 'symlink'; path: string };

/**
 * Walks `segments` down from `checkout`, looking at each component without following it (`lstat`), so that
 * a link anywhere on the way is seen and nothing outside the checkout is read. Anything that is not there,
 * or is not a directory, is `missing`.
 */
export async function locateSkillDir(checkout: string, segments: string[]): Promise<Located> {
  let dir = checkout;
  for (const [index, segment] of segments.entries()) {
    dir = path.join(dir, segment);
    const info = await lstat(dir).catch(ignoreMissing);
    if (info === null) return { kind: 'missing' };
    if (info.isSymbolicLink()) return { kind: 'symlink', path: segments.slice(0, index + 1).join('/') };
    if (!info.isDirectory()) return { kind: 'missing' };
  }
  return { kind: 'directory', dir };
}

/** The regular files of the repository's top level that can be a license (`LICENSE_FILE_NAMES`). A link is ignored. */
export async function readRepoRootLicenseFiles(checkout: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  for (const name of LICENSE_FILE_NAMES) {
    const file = path.join(checkout, name);
    const info = await lstat(file).catch(ignoreMissing);
    if (info?.isFile()) {
      files.push({ path: name, bytes: new Uint8Array(await readFile(file)), executable: (info.mode & 0o111) !== 0 });
    }
  }
  return files;
}

/** `SCHEMA` at `ronin.lock` for a symbolic link, at `upstreamPath` in the source repository, in or on the way to skill `id`. */
export function symlinkDiagnostic(id: string, upstreamPath: string): Diagnostic {
  return error('SCHEMA', LOCK_FILE, `${JSON.stringify(id)}: ${SYMLINK_MESSAGE}: ${upstreamPath}`);
}

/** `agents` are the files of the agents that reference skill `id`, sorted. */
export function unknownSourceMessage(id: string, source: string, agents: string[]): string {
  return `${JSON.stringify(id)}: unknown source ${JSON.stringify(source)}; referenced by ${agents.join(', ')}`;
}

/** `agents` are the files of the agents that reference skill `id`, sorted. */
export function skillNotFoundMessage(id: string, commit: string, agents: string[]): string {
  return `${JSON.stringify(id)} not found at ${commit}; referenced by ${agents.join(', ')}`;
}

/** The message for a reference that is neither `<skill>` nor `<source>/<skill>`. */
export function invalidReferenceMessage(ref: string): string {
  const use = 'use <skill> or <source>/<skill>';
  return `invalid skill reference ${JSON.stringify(ref)}: ${use}, each part matching ${NAME_RE.source}`;
}

/** A path that does not exist is `null`; any other failure is rethrown. */
function ignoreMissing(err: unknown): null {
  if (isNotFound(err)) return null;
  throw err;
}
