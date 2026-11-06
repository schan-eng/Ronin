import { randomBytes } from 'node:crypto';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { error } from '../core/diagnostics.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { isRecord, lineAt, readYamlFile, validate } from '../core/load-util.js';
import { NAME_RE } from '../core/model.js';
import type { ParsedYaml } from '../core/yaml.js';
import { COMMIT_RE } from './git.js';
import type { LicenseFrom } from './license.js';

/** The lockfile, relative to the project root (spec 5.8). Where diagnostics about the lock and what it pins are reported. */
export const LOCK_FILE = 'ronin.lock';

export interface LockedSource {
  repo: string;
  ref: string;
  /** 40 lowercase hex digits. */
  commit: string;
}

export interface LockedSkill {
  /** The skill directory in the upstream repository. */
  path: string;
  /** 64 lowercase hex digits (see `hashSkillFiles`). */
  sha256: string;
  /** An SPDX identifier, or null when unknown. */
  license: string | null;
  licenseFrom: LicenseFrom | null;
  /** Path in the upstream repository of the license file that was used. Absent when none was. */
  licenseFile?: string;
}

export interface Lock {
  lockVersion: 1;
  /** Keyed by source name. */
  sources: Record<string, LockedSource>;
  /** Keyed by `<source>/<skill>`. */
  skills: Record<string, LockedSkill>;
}

export function emptyLock(): Lock {
  return { lockVersion: 1, sources: {}, skills: {} };
}

// The lock arrives through contributor pull requests, and `path` is later joined onto cache directories,
// so everything is checked strictly (R14).

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Typed as a record so that a new `LicenseFrom` value fails to compile here until it is listed. */
const LICENSE_FROM_VALUES: Record<LicenseFrom, true> = {
  asserted: true,
  frontmatter: true,
  'skill-file': true,
  'repo-root': true,
};

const nonEmpty = z.string().min(1, 'must not be empty');

/**
 * Why `p` may not be used as a path inside a repository checkout, or `undefined` if it is fine. It must be
 * relative and `/`-separated, and stay where it says: no leading `/`, no `\`, no Windows drive, and no
 * empty, `.` or `..` segment.
 */
function pathProblem(p: string): string | undefined {
  if (p.includes('\\')) return 'must use "/" separators, not "\\"';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'must be a relative path, not an absolute path';
  const segments = p.split('/');
  if (segments.includes('')) return 'must not have an empty segment (a leading, trailing or doubled "/")';
  if (segments.includes('.') || segments.includes('..')) return 'must not have a "." or ".." segment';
  return undefined;
}

const repoPath = z.string().check((ctx) => {
  const problem = pathProblem(ctx.value);
  if (problem) ctx.issues.push({ code: 'custom', message: problem, input: ctx.value });
});

const LockedSourceSchema = z.strictObject({
  repo: nonEmpty,
  ref: nonEmpty,
  commit: z.string().regex(COMMIT_RE, 'must be 40 lowercase hex digits'),
});

const LockedSkillSchema = z.strictObject({
  path: repoPath,
  sha256: z.string().regex(SHA256_RE, 'must be 64 lowercase hex digits'),
  license: z.string().nullable(),
  licenseFrom: z.enum(Object.keys(LICENSE_FROM_VALUES) as [LicenseFrom, ...LicenseFrom[]]).nullable(),
  licenseFile: repoPath.optional(),
});

/** `ronin.lock` (spec 5.8). The names in the keys of `sources` and `skills` are checked by `keyDiagnostics`. */
const LockSchema = z.strictObject({
  lockVersion: z.literal(1),
  sources: z.record(z.string(), LockedSourceSchema),
  skills: z.record(z.string(), LockedSkillSchema),
});

/**
 * Checks the keys of `sources` (a name) and `skills` (`<source>/<skill>`, with a source that is in `sources`).
 * Done on the raw data, as `loadSources` does for source names, so that each problem is reported at its key
 * together with the schema errors, and a skill is not also blamed for a source whose entry is malformed.
 */
function keyDiagnostics(parsed: ParsedYaml): Diagnostic[] {
  const found: Diagnostic[] = [];
  const { data } = parsed;
  const sources = isRecord(data) && isRecord(data['sources']) ? data['sources'] : {};
  const skills = isRecord(data) && isRecord(data['skills']) ? data['skills'] : {};
  for (const name of Object.keys(sources)) {
    if (NAME_RE.test(name)) continue;
    const message = `invalid source name ${JSON.stringify(name)}: must match ${NAME_RE.source}`;
    found.push(error('SCHEMA', LOCK_FILE, message, lineAt(parsed, ['sources', name])));
  }
  for (const key of Object.keys(skills)) {
    const [source, skill, ...rest] = key.split('/');
    let message: string | undefined;
    const wellFormed =
      source !== undefined && skill !== undefined && rest.length === 0 && NAME_RE.test(source) && NAME_RE.test(skill);
    if (!wellFormed) {
      message = `invalid skill key ${JSON.stringify(key)}: must be <source>/<skill>, both matching ${NAME_RE.source}`;
    } else if (!Object.hasOwn(sources, source)) {
      message = `skill ${JSON.stringify(key)} refers to source ${JSON.stringify(source)}, which is not in sources`;
    }
    if (message !== undefined) found.push(error('SCHEMA', LOCK_FILE, message, lineAt(parsed, ['skills', key])));
  }
  return found;
}

/**
 * Reads `ronin.lock` under `root`. A missing file gives `emptyLock()` and no diagnostics. Anything invalid
 * (malformed YAML, or content that fails the checks above) gives `emptyLock()` and a `SCHEMA` error for each
 * problem, located by line where there is one: a lock is used whole or not at all.
 */
export async function readLock(root: string): Promise<{ lock: Lock; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const parsed = await readYamlFile(root, LOCK_FILE, diagnostics, { required: false });
  if (!parsed) return { lock: emptyLock(), diagnostics };
  const lock = validate(LOCK_FILE, parsed, LockSchema, diagnostics);
  diagnostics.push(...keyDiagnostics(parsed));
  return { lock: lock && diagnostics.length === 0 ? lock : emptyLock(), diagnostics };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The entries of `record` as a `Map` in plain string order of key, mapped through `fn`. */
function sortedMap<T>(
  record: Record<string, T>,
  fn: (value: T) => Map<string, unknown>,
): Map<string, Map<string, unknown>> {
  return new Map(
    Object.keys(record)
      .sort(compare)
      .map((key) => [key, fn(record[key]!)]),
  );
}

/**
 * The YAML text of `lock` (spec 5.8). Deterministic: `sources` and `skills` are sorted by plain string
 * comparison, fields are in the order of the spec, `licenseFile` is left out when undefined, and long values
 * are never folded. LF line endings, 2-space indentation, one trailing newline.
 *
 * Maps are used rather than objects because a JavaScript object lists integer-like keys (a source named
 * `9`) first, whatever the order they were added in. Strings that YAML would read as another type
 * (`1.0`, `0123`, `true`, `null`) are quoted by the serializer, so they round-trip as strings.
 */
export function serializeLock(lock: Lock): string {
  const document = new Map<string, unknown>([
    ['lockVersion', lock.lockVersion],
    [
      'sources',
      sortedMap(lock.sources, (s) => new Map([['repo', s.repo], ['ref', s.ref], ['commit', s.commit]])),
    ],
    [
      'skills',
      sortedMap(lock.skills, (s) => {
        const fields = new Map<string, unknown>([
          ['path', s.path],
          ['sha256', s.sha256],
          ['license', s.license],
          ['licenseFrom', s.licenseFrom],
        ]);
        if (s.licenseFile !== undefined) fields.set('licenseFile', s.licenseFile);
        return fields;
      }),
    ],
  ]);
  return stringify(document, { indent: 2, lineWidth: 0 });
}

/**
 * Writes `ronin.lock` under `root`. The content goes to a temporary file in the same directory first, which
 * is then renamed into place, so an interrupted write never leaves a partial lock.
 */
export async function writeLock(root: string, lock: Lock): Promise<void> {
  const target = path.join(root, LOCK_FILE);
  const temp = path.join(root, `.${LOCK_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, serializeLock(lock), { flag: 'wx' });
    await chmod(temp, 0o644);
    await rename(temp, target);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}
