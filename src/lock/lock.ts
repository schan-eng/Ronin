import { UsageError, error } from '../core/diagnostics.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { readTree } from '../core/files.js';
import { isRecord } from '../core/load-util.js';
import { NAME_RE } from '../core/model.js';
import type { FileEntry, Project, SourceDef } from '../core/model.js';
import { ParseError, parseFrontmatter } from '../core/yaml.js';
import { ensureCommit } from './cache.js';
import {
  invalidReferenceMessage,
  locateSkillDir,
  readRepoRootLicenseFiles,
  skillNotFoundMessage,
  skillSegments,
  symlinkDiagnostic,
  unknownSourceMessage,
} from './checkout.js';
import { resolveRef } from './git.js';
import { hashSkillFiles } from './hash.js';
import { detectLicense, licensePolicyDiagnostic } from './license.js';
import { LOCK_FILE, emptyLock, readLock, writeLock } from './lockfile.js';
import type { Lock, LockedSkill } from './lockfile.js';

/** A third-party skill `<source>/<skill>` and the agents that use it. */
interface SkillRef {
  id: string;
  source: string;
  skill: string;
  /** Agent files, sorted. */
  agents: string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pins every third-party skill that an agent references (spec 7, `lock`) and writes `ronin.lock`.
 *
 * A source's commit is resolved again only when it is new to the lock, its `repo` or `ref` differs from
 * the lock, or it is named in `opts.update`; otherwise the locked commit is kept. Each referenced source is
 * fetched into the cache, and each referenced skill is hashed and has its license detected from the cache on
 * every run. Sources and skills that no agent references are not locked, and nothing is fetched for them.
 *
 * Problems with a skill are diagnostics at `ronin.lock`: `SKILL-UNRESOLVED` (unknown source, or no
 * `SKILL.md` at the locked commit; the skill is left out of the lock), `LICENSE-UNKNOWN` and
 * `LICENSE-DISALLOWED` (the skill is locked with the license that was detected), and `SCHEMA` for a symbolic
 * link in or on the way to a skill (the skill is left out). Any `SCHEMA` error keeps the lock from being
 * written, because it would be missing a skill that cannot be locked. A reference that is not `<name>` or
 * `<source>/<skill>` is a `NAME` error and is skipped; the loader reports these already, so a project from
 * `loadProject` has none.
 *
 * An existing `ronin.lock` that is invalid is treated as empty and not reported: this is the step that
 * regenerates it.
 *
 * Throws `UsageError` if `opts.update` names a source that is not in `sources.yaml`, before anything else
 * happens. A `GitError` from resolving or fetching is not caught; no lock is written then.
 */
export async function runLock(project: Project, opts: { update: string[] }): Promise<Diagnostic[]> {
  const update = new Set(opts.update);
  const unknownNames = [...update].filter((name) => !Object.hasOwn(project.sources, name)).sort(compare);
  if (unknownNames.length > 0) {
    const names = unknownNames.map((name) => JSON.stringify(name)).join(', ');
    throw new UsageError(`--update: unknown source ${names}: it is not in sources.yaml`);
  }

  const diagnostics: Diagnostic[] = [];
  const bySource = new Map<string, SkillRef[]>();
  for (const ref of collectReferences(project, diagnostics)) {
    if (!Object.hasOwn(project.sources, ref.source)) {
      const message = unknownSourceMessage(ref.id, ref.source, ref.agents);
      diagnostics.push(error('SKILL-UNRESOLVED', LOCK_FILE, message));
    } else {
      bySource.set(ref.source, [...(bySource.get(ref.source) ?? []), ref]);
    }
  }

  // An invalid lock is regenerated, not reported (`readLock` gives an empty lock for it).
  const { lock: previous } = await readLock(project.root);
  const lock = emptyLock();
  for (const name of [...bySource.keys()].sort(compare)) {
    const def = project.sources[name]!;
    const commit = await pinCommit(previous, name, def, update.has(name));
    lock.sources[name] = { repo: def.repo, ref: def.ref, commit };
    const checkout = await ensureCommit(project.root, name, def.repo, commit);
    const repoRootFiles = await readRepoRootLicenseFiles(checkout);
    for (const ref of bySource.get(name)!) {
      const locked = await lockSkill({ ref, def, commit, checkout, repoRootFiles }, diagnostics);
      if (locked !== undefined) lock.skills[ref.id] = locked;
    }
  }

  // A symbolic link (the only source of `SCHEMA` here) leaves a skill out of the lock for good, so nothing is written.
  if (!diagnostics.some((d) => d.rule === 'SCHEMA')) await writeLock(project.root, lock);
  return diagnostics;
}

/**
 * The `<source>/<skill>` references of all agents, sorted by id, each with the sorted agent files that use
 * it. Names without `/` are first-party skills and are left out. A malformed reference gets a `NAME`
 * diagnostic and is left out, before anything is built from it.
 */
function collectReferences(project: Project, diagnostics: Diagnostic[]): SkillRef[] {
  const found = new Map<string, SkillRef>();
  for (const pack of project.packs) {
    for (const agent of pack.agents) {
      for (const id of agent.skills) {
        if (!id.includes('/')) continue;
        const parts = id.split('/');
        const [source, skill] = parts;
        if (parts.length !== 2 || !NAME_RE.test(source) || !NAME_RE.test(skill)) {
          diagnostics.push(error('NAME', agent.file, invalidReferenceMessage(id)));
          continue;
        }
        const ref = found.get(id) ?? { id, source, skill, agents: [] };
        if (!ref.agents.includes(agent.file)) ref.agents.push(agent.file);
        found.set(id, ref);
      }
    }
  }
  const refs = [...found.values()].sort((a, b) => compare(a.id, b.id));
  for (const ref of refs) ref.agents.sort(compare);
  return refs;
}

/** The commit for source `name`: the locked one, unless the source is new, changed, or named in `--update`. */
async function pinCommit(previous: Lock, name: string, def: SourceDef, update: boolean): Promise<string> {
  const kept = Object.hasOwn(previous.sources, name) ? previous.sources[name] : undefined;
  if (kept !== undefined && kept.repo === def.repo && kept.ref === def.ref && !update) return kept.commit;
  return resolveRef(def.repo, def.ref);
}

interface SkillContext {
  ref: SkillRef;
  def: SourceDef;
  commit: string;
  checkout: string;
  repoRootFiles: FileEntry[];
}

/**
 * Hashes the skill and detects its license, from the cache. Reports problems into `diagnostics`; returns
 * undefined when the skill cannot be locked (unresolved, or a symbolic link).
 */
async function lockSkill(ctx: SkillContext, diagnostics: Diagnostic[]): Promise<LockedSkill | undefined> {
  const { ref, def, commit, checkout, repoRootFiles } = ctx;
  const segments = skillSegments(def.root, ref.skill);
  const skillPath = segments.join('/');

  const located = await locateSkillDir(checkout, segments);
  if (located.kind === 'symlink') {
    diagnostics.push(symlinkDiagnostic(ref.id, located.path));
    return undefined;
  }
  const tree = located.kind === 'directory' ? await readTree(located.dir) : undefined;
  if (tree !== undefined && tree.symlinks.length > 0) {
    for (const link of tree.symlinks) diagnostics.push(symlinkDiagnostic(ref.id, `${skillPath}/${link}`));
    return undefined;
  }
  const skillMd = tree?.files.find((f) => f.path === 'SKILL.md');
  if (tree === undefined || skillMd === undefined) {
    diagnostics.push(error('SKILL-UNRESOLVED', LOCK_FILE, skillNotFoundMessage(ref.id, commit, ref.agents)));
    return undefined;
  }

  const assertion = Object.hasOwn(def.licenses, ref.skill) ? def.licenses[ref.skill] : undefined;
  const detected = detectLicense({
    assertion,
    frontmatterLicense: frontmatterLicense(skillMd),
    skillFiles: tree.files,
    repoRootFiles,
  });

  const licenseProblem = licensePolicyDiagnostic(
    LOCK_FILE,
    ref.id,
    detected,
    'assert it under licenses in sources.yaml',
  );
  if (licenseProblem) diagnostics.push(licenseProblem);

  const locked: LockedSkill = {
    path: skillPath,
    sha256: hashSkillFiles(tree.files),
    license: detected.license,
    licenseFrom: detected.from,
  };
  if (detected.from === 'skill-file' && detected.file !== null) locked.licenseFile = `${skillPath}/${detected.file}`;
  if (detected.from === 'repo-root' && detected.file !== null) locked.licenseFile = detected.file;
  return locked;
}

/** The `license` in the SKILL.md frontmatter. A file that does not parse has none; checking SKILL.md is for `validate`. */
function frontmatterLicense(skillMd: FileEntry): unknown {
  try {
    const { data } = parseFrontmatter(new TextDecoder().decode(skillMd.bytes));
    return isRecord(data) ? data['license'] : undefined;
  } catch (e) {
    if (e instanceof ParseError) return undefined;
    throw e;
  }
}
