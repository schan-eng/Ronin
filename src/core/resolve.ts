import path from 'node:path';
import { ensureCommit } from '../lock/cache.js';
import {
  invalidReferenceMessage,
  locateSkillDir,
  readRepoRootLicenseFiles,
  skillNotFoundMessage,
  skillSegments,
  symlinkDiagnostic,
  unknownSourceMessage,
} from '../lock/checkout.js';
import { hashSkillFiles } from '../lock/hash.js';
import { LICENSE_FILE_NAMES, detectLicense, licensePolicyDiagnostic } from '../lock/license.js';
import { LOCK_FILE } from '../lock/lockfile.js';
import type { Lock, LockedSkill, LockedSource } from '../lock/lockfile.js';
import { error, warning } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { readTree } from './files.js';
import { isRecord } from './load-util.js';
import { NAME_RE } from './model.js';
import type {
  FileEntry,
  PackDef,
  Project,
  ResolvedLibrary,
  ResolvedPack,
  ResolvedSkill,
  SourceDef,
} from './model.js';
import { ParseError, parseFrontmatter } from './yaml.js';

/** The SPDX token for a license that is not known. */
const NO_ASSERTION = 'NOASSERTION';

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Turns a loaded project into a `ResolvedLibrary` (spec 8): every skill an agent references, with its
 * files read, its origin, and its license. Problems are returned as diagnostics, never thrown, and
 * resolution continues past them, so a skill that fails is left out of its packs while the rest is resolved.
 * Callers stop on errors before rendering.
 *
 * A bare reference is a first-party skill (spec 5.5). It is `SKILL-UNRESOLVED` when `skills/<name>/SKILL.md`
 * does not exist: one diagnostic per skill, at the first agent file that references it (in plain string
 * order), naming all of them. A first-party skill whose directory has a license file (`LICENSE_FILE_NAMES`,
 * top level) is a fork: its license is detected from the frontmatter and that file, and is `LICENSE-UNKNOWN`
 * or `LICENSE-DISALLOWED` at its `SKILL.md`. Any other first-party skill is covered by the repository
 * license, so its `license` is null. A first-party skill named like a source is `SKILL-COLLISION` at its
 * `SKILL.md`, whether or not an agent references it; it is still resolved.
 *
 * A `<source>/<skill>` reference is a third-party skill (spec 5.7, 5.8, 6.6), resolved against `lock` and the
 * content cache, so that the build is reproducible from the lock alone. All its diagnostics are at
 * `ronin.lock`, except where noted. A source that is not in `sources.yaml` is `SKILL-UNRESOLVED` at the first
 * agent file that references the skill (plain string order), as for a missing first-party skill. Then:
 * - `LOCK-STALE` when the lock lacks the source, or has it with another `repo` or `ref` (reported once per
 *   source, and none of its skills is resolved), or lacks the skill, has it at another path than the source's
 *   `root` gives, or disagrees with `sources.yaml` about a license assertion. A stale skill is not fetched
 *   or hashed. Every `LOCK-STALE` message ends with the remedy: run `ronin lock`.
 * - The locked commit is taken from the cache, and fetched into it when missing (`ensureCommit`, at most once
 *   per source); a `GitError` is not caught. The skill directory is found without following symbolic links:
 *   one on the way there is `SCHEMA`. A missing directory or `SKILL.md` is `SKILL-UNRESOLVED`.
 * - `HASH-MISMATCH` when `hashSkillFiles` of the skill's own files differs from the lock's `sha256`.
 * - `SCHEMA` when `SKILL.md` has no parseable frontmatter or no `description` that is a non-blank string.
 * - The license is the lock's: `LICENSE-UNKNOWN` when null (its `spdx` is then `NOASSERTION`), and
 *   `LICENSE-DISALLOWED` when not on the allowlist. A license file in the skill directory is `license.file`.
 *   Failing that, the first regular `LICENSE_FILE_NAMES` file at the top of the repository is appended to
 *   `files` as `LICENSE` (after the hash is taken, and after the sorted files), and is `license.file`. With
 *   neither, `license.file` is null and `NO-LICENSE-TEXT` is a warning.
 *
 * A skill with `LOCK-STALE`, `HASH-MISMATCH`, `SKILL-UNRESOLVED` or `SCHEMA` is left out of its packs; one
 * with only a license problem is kept. Symbolic links inside a skill directory are not reported yet (Task 4.3).
 *
 * `pack.skills` is filled in plain string order of skill id, but JavaScript enumerates integer-like keys
 * (a skill named `9`) first, so consumers must sort the keys themselves. Packs keep `project.packs` order.
 * A skill that several packs use is read once and is the same object in each, with one diagnostic.
 */
export async function resolveLibrary(
  project: Project,
  lock: Lock,
): Promise<{ library: ResolvedLibrary; diagnostics: Diagnostic[] }> {
  const ctx: Context = {
    project,
    lock,
    agentFiles: agentFilesByRef(project),
    diagnostics: collisionDiagnostics(project),
    pinned: new Map(),
    checkouts: new Map(),
  };

  // By skill id. A skill that failed to resolve is undefined, so it is reported only once.
  const resolved = new Map<string, ResolvedSkill | undefined>();
  const packs: ResolvedPack[] = [];
  for (const pack of project.packs) {
    const skills: Record<string, ResolvedSkill> = {};
    for (const ref of referencesOf(pack)) {
      if (!resolved.has(ref)) resolved.set(ref, await resolveRef(ctx, ref));
      const skill = resolved.get(ref);
      if (skill) skills[ref] = skill;
    }
    packs.push({ ...pack, skills });
  }
  return { library: { marketplace: project.marketplace, packs }, diagnostics: ctx.diagnostics };
}

/** What resolving the references of a library shares. */
interface Context {
  project: Project;
  lock: Lock;
  /** For each skill reference, the files of the agents that use it, sorted. */
  agentFiles: Map<string, string[]>;
  diagnostics: Diagnostic[];
  /** By source name, for each source seen: its locked entry, or undefined when the lock cannot be used for it. */
  pinned: Map<string, LockedSource | undefined>;
  /** By source name, for each source that has been fetched. */
  checkouts: Map<string, Checkout>;
}

/** A source at its locked commit in the cache. */
interface Checkout {
  dir: string;
  /** The first regular `LICENSE_FILE_NAMES` file at the top of the repository, if there is one. */
  rootLicense: FileEntry | undefined;
}

/** The distinct skill references of the agents of `pack`, in plain string order. */
function referencesOf(pack: PackDef): string[] {
  return [...new Set(pack.agents.flatMap((agent) => agent.skills))].sort(compare);
}

/** For each skill reference, the files of the agents that use it, in plain string order. */
function agentFilesByRef(project: Project): Map<string, string[]> {
  const byRef = new Map<string, Set<string>>();
  for (const pack of project.packs) {
    for (const agent of pack.agents) {
      for (const ref of agent.skills) {
        const files = byRef.get(ref) ?? new Set<string>();
        files.add(agent.file);
        byRef.set(ref, files);
      }
    }
  }
  return new Map([...byRef].map(([ref, files]) => [ref, [...files].sort(compare)]));
}

/** `SKILL-COLLISION` for every first-party skill that has the name of a source (spec 5.5). */
function collisionDiagnostics(project: Project): Diagnostic[] {
  return Object.values(project.firstPartySkills)
    .filter((skill) => Object.hasOwn(project.sources, skill.name))
    .map((skill) => {
      const message = `first-party skill ${JSON.stringify(skill.name)} has the same name as a source in sources.yaml: rename one of them`;
      return error('SKILL-COLLISION', `${skill.dir}/SKILL.md`, message);
    });
}

/** Resolves one reference, or returns undefined after reporting why not. */
async function resolveRef(ctx: Context, ref: string): Promise<ResolvedSkill | undefined> {
  const agents = ctx.agentFiles.get(ref) ?? [];
  if (ref.includes('/')) return resolveThirdParty(ctx, ref, agents);
  return resolveFirstParty(ctx.project, ref, agents, ctx.diagnostics);
}

/** `agents` are the files of the agents that reference the skill, sorted. */
async function resolveFirstParty(
  project: Project,
  name: string,
  agents: string[],
  diagnostics: Diagnostic[],
): Promise<ResolvedSkill | undefined> {
  if (!Object.hasOwn(project.firstPartySkills, name)) {
    const message = `${JSON.stringify(name)} not found at skills/${name}/SKILL.md; referenced by ${agents.join(', ')}`;
    // An unresolved reference comes from an agent, so `agents` is never empty.
    diagnostics.push(error('SKILL-UNRESOLVED', agents[0]!, message));
    return undefined;
  }

  const skill = project.firstPartySkills[name]!;
  // Symbolic links are intentionally dropped here until Task 4.3 adds their diagnostics.
  const { files } = await readTree(path.join(project.root, ...skill.dir.split('/')));
  const resolved = { id: skill.name, description: skill.description, frontmatter: skill.frontmatter, files };

  const licenseFile = LICENSE_FILE_NAMES.find((fileName) => files.some((file) => file.path === fileName));
  if (licenseFile === undefined) return { ...resolved, origin: { kind: 'first-party' }, license: null };

  const detected = detectLicense({
    frontmatterLicense: skill.frontmatter['license'],
    skillFiles: files,
    repoRootFiles: [],
  });
  const licenseProblem = licensePolicyDiagnostic(
    `${skill.dir}/SKILL.md`,
    skill.name,
    detected,
    'keep the upstream license file unchanged',
  );
  if (licenseProblem) diagnostics.push(licenseProblem);
  return {
    ...resolved,
    origin: { kind: 'fork' },
    license: { spdx: detected.license ?? NO_ASSERTION, file: licenseFile },
  };
}

/** What every `LOCK-STALE` message ends with. */
const LOCK_STALE_REMEDY = 'run `ronin lock`';

/** What to do about `LICENSE-UNKNOWN`. `runLock` reports it too, but there the lock is still to be written. */
const LICENSE_UNKNOWN_REMEDY = 'run `ronin lock` after asserting it under licenses in sources.yaml';

const q = (text: string): string => JSON.stringify(text);

/** `LOCK-STALE` at `ronin.lock`; `problem` is what is out of date, and the message adds what to do about it. */
function lockStale(problem: string): Diagnostic {
  return error('LOCK-STALE', LOCK_FILE, `${problem}; ${LOCK_STALE_REMEDY}`);
}

/**
 * Resolves the third-party skill `id` (`<source>/<skill>`) against the lock and the cache. `agents` are the
 * files of the agents that reference it, sorted.
 */
async function resolveThirdParty(ctx: Context, id: string, agents: string[]): Promise<ResolvedSkill | undefined> {
  const { project, diagnostics } = ctx;
  // An unresolved reference comes from an agent, so `agents` is never empty.
  const agentFile = agents[0]!;

  // The loader leaves out agents with a reference like this, so only a hand-made project has one. It must not
  // reach the file system: the parts are joined onto the cache path.
  const parts = id.split('/');
  const [source, skill] = parts;
  if (parts.length !== 2 || !NAME_RE.test(source) || !NAME_RE.test(skill)) {
    diagnostics.push(error('NAME', agentFile, invalidReferenceMessage(id)));
    return undefined;
  }
  if (!Object.hasOwn(project.sources, source)) {
    diagnostics.push(error('SKILL-UNRESOLVED', agentFile, unknownSourceMessage(id, source, agents)));
    return undefined;
  }
  const def = project.sources[source]!;

  const pinned = pinnedSource(ctx, source, def);
  if (pinned === undefined) return undefined;
  const entry = Object.hasOwn(ctx.lock.skills, id) ? ctx.lock.skills[id] : undefined;
  if (entry === undefined) {
    diagnostics.push(lockStale(`${q(id)} is not in ronin.lock`));
    return undefined;
  }
  const stale = staleSkill(id, skill, def, entry);
  if (stale !== undefined) {
    diagnostics.push(lockStale(stale));
    return undefined;
  }

  const checkout = await fetchSource(ctx, source, def, pinned);
  const segments = skillSegments(def.root, skill);
  const located = await locateSkillDir(checkout.dir, segments);
  if (located.kind === 'symlink') {
    diagnostics.push(symlinkDiagnostic(id, located.path));
    return undefined;
  }
  // Symbolic links inside the skill directory are left out of `files` here; Task 4.3 reports them.
  const files = located.kind === 'directory' ? (await readTree(located.dir)).files : [];
  const skillMd = files.find((file) => file.path === 'SKILL.md');
  if (skillMd === undefined) {
    diagnostics.push(error('SKILL-UNRESOLVED', LOCK_FILE, skillNotFoundMessage(id, pinned.commit, agents)));
    return undefined;
  }

  // Before the root license is added: the lock hashes the skill directory as fetched (spec 5.8).
  const actual = hashSkillFiles(files);
  if (actual !== entry.sha256) {
    const cache = `.ronin/cache/${source}/${pinned.commit}`;
    const message =
      `${q(id)}: the files at ${pinned.commit} do not match the sha256 in ronin.lock ` +
      `(locked ${entry.sha256}, found ${actual}); delete ${cache} to fetch it again; ` +
      `if the mismatch remains, the lock is out of date: ${LOCK_STALE_REMEDY}`;
    diagnostics.push(error('HASH-MISMATCH', LOCK_FILE, message));
    return undefined;
  }

  const parsed = parseSkillMd(skillMd);
  if ('problem' in parsed) {
    diagnostics.push(error('SCHEMA', LOCK_FILE, `${q(id)}: ${segments.join('/')}/${parsed.problem}`));
    return undefined;
  }

  // The lock records the path of the license file in the source repository; only its name matters here.
  const lockedLicenseFile = entry.licenseFile?.split('/').pop() ?? null;
  const licenseProblem = licensePolicyDiagnostic(
    LOCK_FILE,
    id,
    { license: entry.license, file: lockedLicenseFile },
    LICENSE_UNKNOWN_REMEDY,
  );
  if (licenseProblem) diagnostics.push(licenseProblem);

  let shipped = files;
  let licenseFile: string | null = LICENSE_FILE_NAMES.find((name) => files.some((file) => file.path === name)) ?? null;
  if (licenseFile === null && checkout.rootLicense !== undefined) {
    shipped = [...files, { path: 'LICENSE', bytes: checkout.rootLicense.bytes, executable: false }];
    licenseFile = 'LICENSE';
  }
  if (licenseFile === null) {
    const message = `${q(id)}: no license file in the skill directory or at the repository root, so none is shipped`;
    diagnostics.push(warning('NO-LICENSE-TEXT', LOCK_FILE, message));
  }

  return {
    id,
    description: parsed.description,
    frontmatter: parsed.frontmatter,
    files: shipped,
    origin: { kind: 'third-party', repo: pinned.repo, commit: pinned.commit, path: entry.path },
    license: { spdx: entry.license ?? NO_ASSERTION, file: licenseFile },
  };
}

/**
 * The lock entry for source `name`, or undefined when the lock cannot be used for it: it is missing, or its
 * `repo` or `ref` differs from `sources.yaml`. That is `LOCK-STALE`, reported the first time the source is
 * seen and not again, for the source as a whole, so none of its skills is looked at.
 */
function pinnedSource(ctx: Context, name: string, def: SourceDef): LockedSource | undefined {
  if (ctx.pinned.has(name)) return ctx.pinned.get(name);
  const entry = Object.hasOwn(ctx.lock.sources, name) ? ctx.lock.sources[name] : undefined;
  let stale: string | undefined;
  if (entry === undefined) {
    stale = `source ${q(name)} is not in ronin.lock`;
  } else if (entry.repo !== def.repo || entry.ref !== def.ref) {
    stale =
      `source ${q(name)}: sources.yaml has ${def.repo} at ${def.ref}, ` +
      `but ronin.lock has ${entry.repo} at ${entry.ref}`;
  }
  if (stale !== undefined) ctx.diagnostics.push(lockStale(stale));
  const usable = stale === undefined ? entry : undefined;
  ctx.pinned.set(name, usable);
  return usable;
}

/**
 * Why the lock `entry` for skill `id` no longer matches `sources.yaml`, or undefined if it does: the skill
 * is at another path (the `root` of the source changed), or a license assertion was added, changed or
 * removed. (`licenseFrom` is `asserted` exactly when the skill had an assertion, and then `license` is it.)
 */
function staleSkill(id: string, skill: string, def: SourceDef, entry: LockedSkill): string | undefined {
  const expected = skillSegments(def.root, skill).join('/');
  if (entry.path !== expected) {
    return `${q(id)}: ronin.lock has the skill at ${q(entry.path)}, but sources.yaml puts it at ${q(expected)}`;
  }
  const assertion = Object.hasOwn(def.licenses, skill) ? def.licenses[skill] : undefined;
  if (assertion !== undefined) {
    if (entry.licenseFrom === 'asserted' && entry.license === assertion.spdx) return undefined;
    const locked = `${entry.license ?? 'an unknown license'} (licenseFrom: ${entry.licenseFrom ?? 'none'})`;
    return `${q(id)}: sources.yaml asserts the license ${assertion.spdx}, but ronin.lock has ${locked}`;
  }
  if (entry.licenseFrom === 'asserted') {
    const locked = entry.license ?? 'unknown';
    return `${q(id)}: ronin.lock has an asserted license (${locked}), but sources.yaml no longer asserts one`;
  }
  return undefined;
}

/** The cache of `name` at its locked commit, fetched when missing. At most once per source. */
async function fetchSource(ctx: Context, name: string, def: SourceDef, pinned: LockedSource): Promise<Checkout> {
  const known = ctx.checkouts.get(name);
  if (known !== undefined) return known;
  const dir = await ensureCommit(ctx.project.root, name, def.repo, pinned.commit);
  const [rootLicense] = await readRepoRootLicenseFiles(dir);
  const checkout = { dir, rootLicense };
  ctx.checkouts.set(name, checkout);
  return checkout;
}

/**
 * The frontmatter and description of a `SKILL.md`, or what is wrong with it, starting with the file name
 * (`problem`). The description must be a string that is not blank, as for a first-party skill.
 */
function parseSkillMd(
  skillMd: FileEntry,
): { frontmatter: Record<string, unknown>; description: string } | { problem: string } {
  let data: unknown;
  try {
    data = parseFrontmatter(new TextDecoder().decode(skillMd.bytes)).data;
  } catch (e) {
    if (e instanceof ParseError) return { problem: `SKILL.md: ${e.message}` };
    throw e;
  }
  const description = isRecord(data) ? data['description'] : undefined;
  if (!isRecord(data) || typeof description !== 'string' || description.trim() === '') {
    return { problem: 'SKILL.md needs a "description" in its frontmatter: a string that is not blank' };
  }
  return { frontmatter: data, description };
}
