import path from 'node:path';
import { ALLOWLIST, LICENSE_FILE_NAMES, detectLicense, isAllowed } from '../lock/license.js';
import type { Lock } from '../lock/lockfile.js';
import { error } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { readTree } from './files.js';
import type { PackDef, Project, ResolvedLibrary, ResolvedPack, ResolvedSkill } from './model.js';

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
 * A `<source>/<skill>` reference is not resolved yet: it is skipped, with no diagnostic, and `lock` is not read.
 *
 * `pack.skills` is filled in plain string order of skill id, and keeps `project.packs` order. A skill that
 * several packs use is read once and is the same object in each.
 */
export async function resolveLibrary(
  project: Project,
  lock: Lock,
): Promise<{ library: ResolvedLibrary; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = collisionDiagnostics(project);
  const agentFiles = agentFilesByRef(project);

  // By skill id. A skill that failed to resolve is undefined, so it is reported only once.
  const resolved = new Map<string, ResolvedSkill | undefined>();
  const packs: ResolvedPack[] = [];
  for (const pack of project.packs) {
    const skills: Record<string, ResolvedSkill> = {};
    for (const ref of referencesOf(pack)) {
      if (!resolved.has(ref)) resolved.set(ref, await resolveRef(project, ref, agentFiles, diagnostics));
      const skill = resolved.get(ref);
      if (skill) skills[ref] = skill;
    }
    packs.push({ ...pack, skills });
  }
  return { library: { marketplace: project.marketplace, packs }, diagnostics };
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

/** Resolves one reference, or returns undefined after reporting why not (or, for now, for a source reference). */
async function resolveRef(
  project: Project,
  ref: string,
  agentFiles: Map<string, string[]>,
  diagnostics: Diagnostic[],
): Promise<ResolvedSkill | undefined> {
  if (ref.includes('/')) return undefined;
  return resolveFirstParty(project, ref, agentFiles.get(ref) ?? [], diagnostics);
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
  const { files } = await readTree(path.join(project.root, ...skill.dir.split('/')));
  const resolved = { id: skill.name, description: skill.description, frontmatter: skill.frontmatter, files };

  const licenseFile = LICENSE_FILE_NAMES.find((fileName) => files.some((file) => file.path === fileName));
  if (licenseFile === undefined) return { ...resolved, origin: { kind: 'first-party' }, license: null };

  const detected = detectLicense({
    frontmatterLicense: skill.frontmatter['license'],
    skillFiles: files,
    repoRootFiles: [],
  });
  const skillMd = `${skill.dir}/SKILL.md`;
  if (detected.license === null) {
    const message = `${JSON.stringify(skill.name)}: license could not be determined (${licenseFile} is not a recognized license text); keep the upstream license file unchanged`;
    diagnostics.push(error('LICENSE-UNKNOWN', skillMd, message));
  } else if (!isAllowed(detected.license)) {
    const message = `${JSON.stringify(skill.name)}: license ${detected.license} is not on the allowlist (${ALLOWLIST.join(', ')})`;
    diagnostics.push(error('LICENSE-DISALLOWED', skillMd, message));
  }
  return {
    ...resolved,
    origin: { kind: 'fork' },
    license: { spdx: detected.license ?? NO_ASSERTION, file: licenseFile },
  };
}
