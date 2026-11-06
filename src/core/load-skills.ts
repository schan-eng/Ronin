import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { error } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import {
  SYMLINK_MESSAGE,
  checkName,
  isNotFound,
  isRecord,
  lineAt,
  readDir,
  readFrontmatterFile,
  validate,
} from './load-util.js';
import type { FirstPartySkill } from './model.js';
import { SkillFrontmatterSchema } from './schemas.js';

/**
 * Loads every first-party skill, `skills/<dir>/SKILL.md` (spec 5.5), keyed by name. A missing `skills/`
 * folder means no first-party skills, and a directory without a `SKILL.md` is not a skill, so it is
 * ignored. A skill that fails `SCHEMA` or `NAME` is left out. The rest of a skill directory (scripts,
 * references, license files) is not read here.
 */
export async function loadFirstPartySkills(
  root: string,
  diagnostics: Diagnostic[],
): Promise<Record<string, FirstPartySkill>> {
  const skills: Record<string, FirstPartySkill> = {};
  for (const entry of await readDir(root, 'skills', diagnostics)) {
    if (!entry.isDirectory()) continue;
    const skill = await loadSkill(root, entry.name, diagnostics);
    if (skill) skills[skill.name] = skill;
  }
  return skills;
}

async function loadSkill(root: string, dir: string, diagnostics: Diagnostic[]): Promise<FirstPartySkill | undefined> {
  const rel = `skills/${dir}/SKILL.md`;
  if (!(await hasSkillFile(root, rel, diagnostics))) return undefined;
  const parsed = await readFrontmatterFile(root, rel, diagnostics, { required: false });
  if (!parsed) return undefined;

  const frontmatter = validate(rel, parsed, SkillFrontmatterSchema, diagnostics);
  // Checked on the raw value, so a wrong name is reported even when the file also has schema errors.
  const rawName = isRecord(parsed.data) ? parsed.data['name'] : undefined;
  const nameProblem =
    typeof rawName === 'string' &&
    checkName(rel, lineAt(parsed, ['name']), diagnostics, {
      kind: 'skill',
      name: rawName,
      expected: dir,
      source: 'directory name',
    });
  if (!frontmatter || nameProblem) return undefined;
  return { name: frontmatter.name, dir: `skills/${dir}`, description: frontmatter.description, frontmatter };
}

/**
 * Whether `rel` is a regular file. A symbolic link is reported as a `SCHEMA` error and does not count:
 * reading it would pull in a file from outside the skill directory.
 */
async function hasSkillFile(root: string, rel: string, diagnostics: Diagnostic[]): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path.join(root, ...rel.split('/')));
  } catch (e) {
    if (!isNotFound(e)) throw e;
    return false;
  }
  if (stats.isSymbolicLink()) {
    diagnostics.push(error('SCHEMA', rel, SYMLINK_MESSAGE));
    return false;
  }
  return stats.isFile();
}
