import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProject } from '../../src/core/load.js';
import type { Project } from '../../src/core/model.js';
import { resolveLibrary } from '../../src/core/resolve.js';
import { ensureCommit } from '../../src/lock/cache.js';
import { GitError } from '../../src/lock/git.js';
import { hashSkillFiles } from '../../src/lock/hash.js';
import { runLock } from '../../src/lock/lock.js';
import { emptyLock, readLock } from '../../src/lock/lockfile.js';
import type { Lock, LockedSkill, LockedSource } from '../../src/lock/lockfile.js';
import { enc, makeProject } from '../helpers/fs.js';
import type { ProjectFile } from '../helpers/fs.js';
import { makeUpstream } from '../helpers/git.js';

// `ensureCommit` is wrapped, not replaced, so that the tests can count its calls.
vi.mock('../../src/lock/cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lock/cache.js')>();
  return { ...actual, ensureCommit: vi.fn(actual.ensureCommit) };
});

const MIT_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2026 Someone',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction.',
  '',
].join('\n');
const APACHE_TEXT = '                                 Apache License\n                           Version 2.0, January 2004\n';
const UNKNOWN_TEXT = 'All rights reserved. Do not copy.\n';

const RONIN_YAML = 'marketplace:\n  name: ronin\n  owner:\n    name: t\n  description: A library.\n';
const COMMIT = '1'.repeat(40);
const REPO = 'https://example.com/upstream.git';
const LOCK_STALE_REMEDY = 'run `ronin lock`';

const made: string[] = [];

beforeEach(() => {
  vi.mocked(ensureCommit).mockClear();
});

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A SKILL.md: one `key: value` frontmatter line per field, then the body. */
function skillMd(name: string, fields: Record<string, string> = {}): string {
  const all = { name: JSON.stringify(name), description: `The ${name} skill.`, ...fields };
  const lines = Object.entries(all).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\nUse ${name} well.\n`;
}

function sourcesYaml(
  opts: { repo?: string; ref?: string; root?: string; licenses?: Record<string, string>; name?: string } = {},
): string {
  const lines = ['sources:', `  ${opts.name ?? 'upstream'}:`, `    repo: ${opts.repo ?? REPO}`, `    ref: ${opts.ref ?? 'main'}`];
  lines.push(`    root: ${opts.root ?? 'skills'}`);
  if (opts.licenses) {
    lines.push('    licenses:');
    for (const [skill, spdx] of Object.entries(opts.licenses)) {
      lines.push(`      ${skill}:`, `        spdx: ${spdx}`, '        reason: Stated upstream.');
    }
  }
  return lines.join('\n') + '\n';
}

function packYaml(name: string): string {
  return `name: ${name}\nversion: 1.2.3\ndescription: The ${name} pack.\n`;
}

/** An agent file at `packs/<pack>/agents/<name>.md` referencing `skills`. */
function agent(pack: string, name: string, skills: string[]): Record<string, string> {
  const list = `skills: [${skills.map((s) => JSON.stringify(s)).join(', ')}]\n`;
  return {
    [`packs/${pack}/agents/${name}.md`]: `---\nname: ${name}\ndescription: The ${name} agent.\n${list}---\nYou are ${name}.\n`,
  };
}

/** The files of skill `greeting`, relative to its directory. */
const GREETING: Record<string, string> = { 'SKILL.md': skillMd('greeting'), 'references/hello.md': 'Hello.\n' };

function hashOf(files: Record<string, string>): string {
  return hashSkillFiles(Object.entries(files).map(([p, content]) => ({ path: p, bytes: enc(content), executable: false })));
}

/** A lock entry that matches `files` as the skill directory `skills/greeting`, with the license in the repository root. */
function locked(files: Record<string, string> = GREETING, over: Partial<LockedSkill> = {}): LockedSkill {
  return {
    path: 'skills/greeting',
    sha256: hashOf(files),
    license: 'MIT',
    licenseFrom: 'repo-root',
    licenseFile: 'LICENSE',
    ...over,
  };
}

function lockOf(skills: Record<string, LockedSkill>, source: Partial<LockedSource> = {}): Lock {
  return { lockVersion: 1, sources: { upstream: { repo: REPO, ref: 'main', commit: COMMIT, ...source } }, skills };
}

/** The files of a cached checkout of `upstream` at `COMMIT`: skill `greeting` under `skills/` and `extra`. */
function checkoutFiles(
  extra: Record<string, ProjectFile> = { LICENSE: MIT_TEXT },
  greeting: Record<string, string> = GREETING,
): Record<string, ProjectFile> {
  const files: Record<string, ProjectFile> = { ...extra };
  for (const [rel, content] of Object.entries(greeting)) files[`skills/greeting/${rel}`] = content;
  return files;
}

/** Puts `files` where `ensureCommit` finds the cache of `upstream` at `COMMIT`, so that no git is needed. */
function inCache(files: Record<string, ProjectFile>): Record<string, ProjectFile> {
  return Object.fromEntries(Object.entries(files).map(([rel, spec]) => [`.ronin/cache/upstream/${COMMIT}/${rel}`, spec]));
}

interface Setup {
  lock: Lock;
  /** The checkout files; `null` for a cache that is not there. Default: `checkoutFiles()`. */
  checkout?: Record<string, ProjectFile> | null;
  sources?: string;
  /** Agents of pack `web`, by agent name. Default: one agent that uses `upstream/greeting`. */
  agents?: Record<string, string[]>;
  /** More project files, such as other packs. */
  extra?: Record<string, ProjectFile>;
}

/** Writes a project, requires it to load clean, and resolves it against `lock`. */
async function resolve(setup: Setup) {
  const agents = setup.agents ?? { frontend: ['upstream/greeting'] };
  const files: Record<string, ProjectFile> = {
    'ronin.yaml': RONIN_YAML,
    'sources.yaml': setup.sources ?? sourcesYaml(),
    'packs/web/pack.yaml': packYaml('web'),
    ...Object.assign({}, ...Object.entries(agents).map(([name, skills]) => agent('web', name, skills))),
    ...(setup.checkout === null ? {} : inCache(setup.checkout ?? checkoutFiles())),
    ...setup.extra,
  };
  const root = await makeProject(files);
  made.push(root);
  const loaded = await loadProject(root);
  expect(loaded.diagnostics).toEqual([]);
  const resolved = await resolveLibrary(loaded.project, setup.lock);
  return { root, project: loaded.project, ...resolved };
}

const webSkills = (library: { packs: { name: string; skills: Record<string, unknown> }[] }) =>
  Object.keys(library.packs.find((p) => p.name === 'web')!.skills);

describe('resolveLibrary: third-party skills', () => {
  it('third-party with only a repo-root LICENSE: LICENSE appended to files, hash taken without it', async () => {
    const { library, diagnostics } = await resolve({ lock: lockOf({ 'upstream/greeting': locked() }) });
    expect(diagnostics).toEqual([]);

    const skill = library.packs[0]!.skills['upstream/greeting']!;
    expect(skill.id).toBe('upstream/greeting');
    expect(skill.description).toBe('The greeting skill.');
    expect(skill.frontmatter).toEqual({ name: 'greeting', description: 'The greeting skill.' });
    expect(skill.origin).toEqual({ kind: 'third-party', repo: REPO, commit: COMMIT, path: 'skills/greeting' });
    expect(skill.license).toEqual({ spdx: 'MIT', file: 'LICENSE' });
    expect(skill.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/hello.md', 'LICENSE']);
    expect(skill.files[2]).toEqual({ path: 'LICENSE', bytes: enc(MIT_TEXT), executable: false });
    expect(skill.files[1]).toEqual({ path: 'references/hello.md', bytes: enc('Hello.\n'), executable: false });
  });

  it('the appended LICENSE is the first regular LICENSE_FILE_NAMES file at the root, never executable', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(GREETING, { licenseFile: 'LICENSE.md' }) }),
      checkout: checkoutFiles({
        // A directory named LICENSE is not a license file, and a later name must not win over LICENSE.md.
        'LICENSE/notes.txt': 'A directory.\n',
        'LICENSE.md': { content: MIT_TEXT, executable: true },
        COPYING: APACHE_TEXT,
      }),
    });
    expect(diagnostics).toEqual([]);
    const skill = library.packs[0]!.skills['upstream/greeting']!;
    expect(skill.files.at(-1)).toEqual({ path: 'LICENSE', bytes: enc(MIT_TEXT), executable: false });
    expect(skill.license).toEqual({ spdx: 'MIT', file: 'LICENSE' });
  });

  it('a license file in the skill directory is used as it is: license.file names it and nothing is appended', async () => {
    const files = { ...GREETING, 'LICENSE.txt': MIT_TEXT };
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(files, { licenseFrom: 'skill-file', licenseFile: 'skills/greeting/LICENSE.txt' }) }),
      checkout: checkoutFiles({ LICENSE: APACHE_TEXT }, files),
    });
    expect(diagnostics).toEqual([]);
    const skill = library.packs[0]!.skills['upstream/greeting']!;
    expect(skill.license).toEqual({ spdx: 'MIT', file: 'LICENSE.txt' });
    expect(skill.files.map((f) => f.path)).toEqual(['LICENSE.txt', 'SKILL.md', 'references/hello.md']);
  });

  it('a nested LICENSE in the skill directory does not count as the skill license', async () => {
    const files = { ...GREETING, 'references/LICENSE': APACHE_TEXT };
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(files) }),
      checkout: checkoutFiles({ LICENSE: MIT_TEXT }, files),
    });
    expect(diagnostics).toEqual([]);
    const skill = library.packs[0]!.skills['upstream/greeting']!;
    expect(skill.license).toEqual({ spdx: 'MIT', file: 'LICENSE' });
    expect(skill.files.at(-1)).toEqual({ path: 'LICENSE', bytes: enc(MIT_TEXT), executable: false });
  });

  it('NO-LICENSE-TEXT: frontmatter MIT, no license files anywhere (warning at ronin.lock, skill kept)', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(GREETING, { licenseFrom: 'frontmatter', licenseFile: undefined }) }),
      checkout: checkoutFiles({}),
    });
    expect(diagnostics).toEqual([
      {
        path: 'ronin.lock',
        severity: 'warning',
        rule: 'NO-LICENSE-TEXT',
        message: '"upstream/greeting": no license file in the skill directory or at the repository root, so none is shipped',
      },
    ]);
    const skill = library.packs[0]!.skills['upstream/greeting']!;
    expect(skill.license).toEqual({ spdx: 'MIT', file: null });
    expect(skill.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/hello.md']);
  });

  it('LICENSE-UNKNOWN (lock null) and LICENSE-DISALLOWED (lock "GPL-3.0") keep the skill', async () => {
    const mystery = { 'SKILL.md': skillMd('mystery') };
    const copyleft = { 'SKILL.md': skillMd('copyleft') };
    const { library, diagnostics } = await resolve({
      agents: { frontend: ['upstream/copyleft', 'upstream/mystery'] },
      lock: lockOf({
        'upstream/mystery': locked(mystery, { path: 'skills/mystery', license: null, licenseFrom: 'repo-root' }),
        'upstream/copyleft': locked(copyleft, { path: 'skills/copyleft', license: 'GPL-3.0' }),
      }),
      checkout: {
        LICENSE: UNKNOWN_TEXT,
        'skills/mystery/SKILL.md': mystery['SKILL.md']!,
        'skills/copyleft/SKILL.md': copyleft['SKILL.md']!,
      },
    });
    expect(diagnostics).toEqual([
      {
        path: 'ronin.lock',
        severity: 'error',
        rule: 'LICENSE-DISALLOWED',
        message:
          '"upstream/copyleft": license GPL-3.0 is not on the allowlist ' +
          '(MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, CC0-1.0, CC-BY-4.0)',
      },
      {
        path: 'ronin.lock',
        severity: 'error',
        rule: 'LICENSE-UNKNOWN',
        message:
          '"upstream/mystery": license could not be determined (LICENSE is not a recognized license text); ' +
          'run `ronin lock` after asserting it under licenses in sources.yaml',
      },
    ]);
    const { skills } = library.packs[0]!;
    expect(skills['upstream/mystery']!.license).toEqual({ spdx: 'NOASSERTION', file: 'LICENSE' });
    expect(skills['upstream/copyleft']!.license).toEqual({ spdx: 'GPL-3.0', file: 'LICENSE' });
  });

  it('LICENSE-UNKNOWN with no license text at all names no file', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(GREETING, { license: null, licenseFrom: null, licenseFile: undefined }) }),
      checkout: checkoutFiles({}),
    });
    expect(diagnostics.map((d) => [d.rule, d.severity, d.message])).toEqual([
      [
        'LICENSE-UNKNOWN',
        'error',
        '"upstream/greeting": license could not be determined; ' +
          'run `ronin lock` after asserting it under licenses in sources.yaml',
      ],
      [
        'NO-LICENSE-TEXT',
        'warning',
        '"upstream/greeting": no license file in the skill directory or at the repository root, so none is shipped',
      ],
    ]);
    expect(library.packs[0]!.skills['upstream/greeting']!.license).toEqual({ spdx: 'NOASSERTION', file: null });
  });
});

describe('resolveLibrary: third-party references that cannot be resolved', () => {
  it('unknown source: SKILL-UNRESOLVED at the first agent file in plain string order, naming all of them', async () => {
    // "packs/a-b/..." sorts before "packs/a/..." ("-" is 0x2d, "/" is 0x2f), though pack `a` comes first.
    const { library, diagnostics } = await resolve({
      lock: emptyLock(),
      agents: { frontend: ['nowhere/x'] },
      extra: {
        'packs/a/pack.yaml': packYaml('a'),
        ...agent('a', 'zz', ['nowhere/x']),
        'packs/a-b/pack.yaml': packYaml('a-b'),
        ...agent('a-b', 'aa', ['nowhere/x']),
      },
    });
    expect(diagnostics).toEqual([
      {
        path: 'packs/a-b/agents/aa.md',
        severity: 'error',
        rule: 'SKILL-UNRESOLVED',
        message:
          '"nowhere/x": unknown source "nowhere"; referenced by ' +
          'packs/a-b/agents/aa.md, packs/a/agents/zz.md, packs/web/agents/frontend.md',
      },
    ]);
    expect(library.packs.map((p) => Object.keys(p.skills))).toEqual([[], [], []]);
    expect(ensureCommit).not.toHaveBeenCalled();
  });

  it('unknown source named like an Object.prototype member is still unknown', async () => {
    const { diagnostics } = await resolve({ lock: emptyLock(), agents: { frontend: ['constructor/x'] } });
    expect(diagnostics.map((d) => [d.rule, d.path, d.message])).toEqual([
      [
        'SKILL-UNRESOLVED',
        'packs/web/agents/frontend.md',
        '"constructor/x": unknown source "constructor"; referenced by packs/web/agents/frontend.md',
      ],
    ]);
  });

  it('a malformed reference is a NAME error at the agent file and touches no file system or git', async () => {
    const { project } = await resolve({ lock: lockOf({}), agents: { frontend: ['upstream/greeting'] }, checkout: null });
    const hacked: Project = {
      ...project,
      packs: project.packs.map((pack) => ({
        ...pack,
        agents: pack.agents.map((a) => ({ ...a, skills: ['upstream/../x', 'a/b/c'] })),
      })),
    };
    const { library, diagnostics } = await resolveLibrary(hacked, emptyLock());
    expect(diagnostics.map((d) => [d.rule, d.path, d.message.split(':')[0]])).toEqual([
      ['NAME', 'packs/web/agents/frontend.md', 'invalid skill reference "a/b/c"'],
      ['NAME', 'packs/web/agents/frontend.md', 'invalid skill reference "upstream/../x"'],
    ]);
    expect(library.packs[0]!.skills).toEqual({});
    expect(ensureCommit).not.toHaveBeenCalled();
  });

  it('missing SKILL.md at the locked commit: SKILL-UNRESOLVED at ronin.lock, skill left out', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      agents: { frontend: ['upstream/greeting'], designer: ['upstream/greeting'] },
      checkout: { LICENSE: MIT_TEXT, 'skills/greeting/references/hello.md': 'Hello.\n' },
    });
    expect(diagnostics).toEqual([
      {
        path: 'ronin.lock',
        severity: 'error',
        rule: 'SKILL-UNRESOLVED',
        message: `"upstream/greeting" not found at ${COMMIT}; referenced by packs/web/agents/designer.md, packs/web/agents/frontend.md`,
      },
    ]);
    expect(webSkills(library)).toEqual([]);
  });

  it('a missing skill directory, or one that is a file, is SKILL-UNRESOLVED too', async () => {
    const missing = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      checkout: { LICENSE: MIT_TEXT, 'skills/other/SKILL.md': skillMd('other') },
    });
    expect(missing.diagnostics.map((d) => [d.rule, d.path])).toEqual([['SKILL-UNRESOLVED', 'ronin.lock']]);

    const file = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      checkout: { LICENSE: MIT_TEXT, 'skills/greeting': 'not a directory\n' },
    });
    expect(file.diagnostics.map((d) => [d.rule, d.path])).toEqual([['SKILL-UNRESOLVED', 'ronin.lock']]);
    expect(webSkills(file.library)).toEqual([]);
  });

  it('a symbolic link on the way to the skill is SCHEMA at ronin.lock, and nothing behind it is read', async () => {
    const setup: Setup = {
      lock: lockOf({ 'upstream/greeting': locked() }),
      checkout: { LICENSE: MIT_TEXT, 'real/greeting/SKILL.md': GREETING['SKILL.md']!, 'real/greeting/references/hello.md': 'Hello.\n' },
    };
    // `skills` -> `real`: a component above the skill directory.
    const above = await resolveWithLinks(setup, [['skills', 'real']]);
    expect(above.diagnostics).toEqual([
      {
        path: 'ronin.lock',
        severity: 'error',
        rule: 'SCHEMA',
        message: '"upstream/greeting": symbolic links are not allowed in the source tree: skills',
      },
    ]);
    expect(webSkills(above.library)).toEqual([]);

    // `skills/greeting` -> `../real/greeting`: the skill directory itself.
    const itself = await resolveWithLinks(setup, [['skills/greeting', '../real/greeting']]);
    expect(itself.diagnostics.map((d) => [d.rule, d.path, d.message])).toEqual([
      ['SCHEMA', 'ronin.lock', '"upstream/greeting": symbolic links are not allowed in the source tree: skills/greeting'],
    ]);
    expect(webSkills(itself.library)).toEqual([]);
  });
});

/** Like `resolve`, but also creates symbolic links in the checkout: `[link, target]`, both relative to it. */
async function resolveWithLinks(setup: Setup, links: [string, string][]) {
  const root = await makeProject({
    'ronin.yaml': RONIN_YAML,
    'sources.yaml': sourcesYaml(),
    'packs/web/pack.yaml': packYaml('web'),
    ...agent('web', 'frontend', ['upstream/greeting']),
    ...inCache(setup.checkout ?? {}),
  });
  made.push(root);
  const checkout = path.join(root, '.ronin', 'cache', 'upstream', COMMIT);
  for (const [link, target] of links) {
    await mkdir(path.dirname(path.join(checkout, link)), { recursive: true });
    await symlink(target, path.join(checkout, link));
  }
  const { project } = await loadProject(root);
  return resolveLibrary(project, setup.lock);
}

describe('resolveLibrary: LOCK-STALE', () => {
  const stale = (message: string) => ({ path: 'ronin.lock', severity: 'error', rule: 'LOCK-STALE', message });

  it('the lock lacks the source: one LOCK-STALE per source, whatever skills are used', async () => {
    const { library, diagnostics } = await resolve({
      lock: emptyLock(),
      agents: { frontend: ['upstream/greeting', 'upstream/other'] },
    });
    expect(diagnostics).toEqual([
      stale('source "upstream" is not in ronin.lock; ' + LOCK_STALE_REMEDY),
    ]);
    expect(webSkills(library)).toEqual([]);
  });

  it('the lock lacks the skill: LOCK-STALE for that skill only, the others resolve', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      agents: { frontend: ['upstream/greeting', 'upstream/other'] },
    });
    expect(diagnostics).toEqual([stale('"upstream/other" is not in ronin.lock; ' + LOCK_STALE_REMEDY)]);
    expect(webSkills(library)).toEqual(['upstream/greeting']);
  });

  it('source and skill names that are Object.prototype members are looked up as own keys only', async () => {
    const { diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      sources: sourcesYaml({ name: 'constructor' }),
      agents: { frontend: ['constructor/constructor'] },
    });
    expect(diagnostics).toEqual([stale('source "constructor" is not in ronin.lock; ' + LOCK_STALE_REMEDY)]);

    const skill = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      agents: { frontend: ['upstream/constructor'] },
    });
    expect(skill.diagnostics).toEqual([stale('"upstream/constructor" is not in ronin.lock; ' + LOCK_STALE_REMEDY)]);
  });

  it('ref changed in sources.yaml: one LOCK-STALE for the source, nothing fetched or hashed', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(), 'upstream/other': locked(GREETING, { path: 'skills/other' }) }),
      sources: sourcesYaml({ ref: 'v2' }),
      agents: { frontend: ['upstream/greeting', 'upstream/other'] },
      // No cache: reaching `ensureCommit` would try to fetch from an address that does not exist.
      checkout: null,
    });
    expect(diagnostics).toEqual([
      stale(
        `source "upstream": sources.yaml has ${REPO} at v2, but ronin.lock has ${REPO} at main; ${LOCK_STALE_REMEDY}`,
      ),
    ]);
    expect(webSkills(library)).toEqual([]);
    expect(ensureCommit).not.toHaveBeenCalled();
  });

  it('repo changed in sources.yaml is the same, once per source even across packs', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      sources: sourcesYaml({ repo: 'https://example.com/fork.git' }),
      checkout: null,
      extra: { 'packs/api/pack.yaml': packYaml('api'), ...agent('api', 'backend', ['upstream/greeting']) },
    });
    expect(diagnostics).toEqual([
      stale(
        `source "upstream": sources.yaml has https://example.com/fork.git at main, but ronin.lock has ${REPO} at main; ${LOCK_STALE_REMEDY}`,
      ),
    ]);
    expect(library.packs.map((p) => Object.keys(p.skills))).toEqual([[], []]);
    expect(ensureCommit).not.toHaveBeenCalled();
  });

  it('root changed in sources.yaml: the locked path no longer matches', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      sources: sourcesYaml({ root: 'library/skills' }),
      checkout: null,
    });
    expect(diagnostics).toEqual([
      stale(
        '"upstream/greeting": ronin.lock has the skill at "skills/greeting", but sources.yaml puts it at ' +
          `"library/skills/greeting"; ${LOCK_STALE_REMEDY}`,
      ),
    ]);
    expect(webSkills(library)).toEqual([]);
    expect(ensureCommit).not.toHaveBeenCalled();
  });

  it('root spelled differently but equal after normalization is not stale', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      sources: sourcesYaml({ root: './skills/' }),
    });
    expect(diagnostics).toEqual([]);
    expect(webSkills(library)).toEqual(['upstream/greeting']);
  });

  it('a license assertion that is new or different from the lock is stale', async () => {
    // New: the lock says the license came from the repository root.
    const added = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      sources: sourcesYaml({ licenses: { greeting: 'Apache-2.0' } }),
      checkout: null,
    });
    expect(added.diagnostics).toEqual([
      stale(
        '"upstream/greeting": sources.yaml asserts the license Apache-2.0, but ronin.lock has MIT (licenseFrom: repo-root); ' +
          LOCK_STALE_REMEDY,
      ),
    ]);
    expect(webSkills(added.library)).toEqual([]);

    // Changed: the lock has an assertion with another id.
    const changed = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(GREETING, { licenseFrom: 'asserted', licenseFile: undefined }) }),
      sources: sourcesYaml({ licenses: { greeting: 'Apache-2.0' } }),
      checkout: null,
    });
    expect(changed.diagnostics.map((d) => [d.rule, d.message])).toEqual([
      [
        'LOCK-STALE',
        '"upstream/greeting": sources.yaml asserts the license Apache-2.0, but ronin.lock has MIT (licenseFrom: asserted); ' +
          LOCK_STALE_REMEDY,
      ],
    ]);
    expect(ensureCommit).not.toHaveBeenCalled();
  });

  it('a locked assertion that sources.yaml no longer has is stale', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(GREETING, { licenseFrom: 'asserted', licenseFile: undefined }) }),
      checkout: null,
    });
    expect(diagnostics).toEqual([
      stale(
        '"upstream/greeting": ronin.lock has an asserted license (MIT), but sources.yaml no longer asserts one; ' +
          LOCK_STALE_REMEDY,
      ),
    ]);
    expect(webSkills(library)).toEqual([]);
  });

  it('an assertion that equals the lock is not stale, and the asserted license is used', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(GREETING, { license: 'Apache-2.0', licenseFrom: 'asserted', licenseFile: undefined }) }),
      sources: sourcesYaml({ licenses: { greeting: 'Apache-2.0' } }),
    });
    expect(diagnostics).toEqual([]);
    // The license text is taken from the repository root, whatever it says.
    expect(library.packs[0]!.skills['upstream/greeting']!.license).toEqual({ spdx: 'Apache-2.0', file: 'LICENSE' });
  });
});

describe('resolveLibrary: content checks', () => {
  it('HASH-MISMATCH after editing a cached file: error at ronin.lock, skill left out', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      checkout: checkoutFiles({ LICENSE: MIT_TEXT }, { ...GREETING, 'references/hello.md': 'Hello, tampered.\n' }),
    });
    expect(diagnostics).toEqual([
      {
        path: 'ronin.lock',
        severity: 'error',
        rule: 'HASH-MISMATCH',
        message:
          `"upstream/greeting": the files at ${COMMIT} do not match the sha256 in ronin.lock ` +
          `(locked ${hashOf(GREETING)}, found ${hashOf({ ...GREETING, 'references/hello.md': 'Hello, tampered.\n' })}); ` +
          `delete .ronin/cache/upstream/${COMMIT} to fetch it again; if the mismatch remains, the lock is out of date: run \`ronin lock\``,
      },
    ]);
    expect(webSkills(library)).toEqual([]);
  });

  it('an added or removed file is a HASH-MISMATCH too', async () => {
    const added = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      checkout: checkoutFiles({ LICENSE: MIT_TEXT }, { ...GREETING, 'extra.md': 'More.\n' }),
    });
    expect(added.diagnostics.map((d) => d.rule)).toEqual(['HASH-MISMATCH']);

    const removed = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      checkout: checkoutFiles({ LICENSE: MIT_TEXT }, { 'SKILL.md': GREETING['SKILL.md']! }),
    });
    expect(removed.diagnostics.map((d) => d.rule)).toEqual(['HASH-MISMATCH']);
  });

  it('a HASH-MISMATCH skill raises no license diagnostics', async () => {
    const { diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(GREETING, { license: 'GPL-3.0' }) }),
      checkout: checkoutFiles({ LICENSE: MIT_TEXT }, { ...GREETING, 'references/hello.md': 'Changed.\n' }),
    });
    expect(diagnostics.map((d) => d.rule)).toEqual(['HASH-MISMATCH']);
  });

  it.each([
    ['has no description', skillMd('greeting').replace(/description: .*\n/, '')],
    ['has a blank description', skillMd('greeting', { description: '"   "' })],
    ['has a description that is not a string', skillMd('greeting', { description: '[a, b]' })],
  ])('SKILL.md that %s: SCHEMA at ronin.lock naming the skill, skill left out', async (_what, content) => {
    const files = { ...GREETING, 'SKILL.md': content };
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(files) }),
      checkout: checkoutFiles({ LICENSE: MIT_TEXT }, files),
    });
    expect(diagnostics).toEqual([
      {
        path: 'ronin.lock',
        severity: 'error',
        rule: 'SCHEMA',
        message: '"upstream/greeting": skills/greeting/SKILL.md needs a "description" in its frontmatter: a string that is not blank',
      },
    ]);
    expect(webSkills(library)).toEqual([]);
  });

  it('SKILL.md whose frontmatter does not parse: SCHEMA at ronin.lock with the parser message', async () => {
    const files = { ...GREETING, 'SKILL.md': 'Just text, no frontmatter.\n' };
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(files) }),
      checkout: checkoutFiles({ LICENSE: MIT_TEXT }, files),
    });
    expect(diagnostics).toEqual([
      {
        path: 'ronin.lock',
        severity: 'error',
        rule: 'SCHEMA',
        message:
          '"upstream/greeting": skills/greeting/SKILL.md: missing frontmatter: the file must start with a "---" line',
      },
    ]);
    expect(webSkills(library)).toEqual([]);
  });

  it('a SKILL.md with CRLF line endings and a BOM parses like an LF one', async () => {
    const files = { ...GREETING, 'SKILL.md': '﻿' + skillMd('greeting').replace(/\n/g, '\r\n') };
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked(files) }),
      checkout: checkoutFiles({ LICENSE: MIT_TEXT }, files),
    });
    expect(diagnostics).toEqual([]);
    expect(library.packs[0]!.skills['upstream/greeting']!.description).toBe('The greeting skill.');
  });
});

describe('resolveLibrary: sharing and fetching', () => {
  it('a skill used by several agents and packs is resolved once: one object, one diagnostic, one fetch', async () => {
    const copyleft = { 'SKILL.md': skillMd('copyleft') };
    const { library, diagnostics } = await resolve({
      lock: lockOf({
        'upstream/copyleft': locked(copyleft, { path: 'skills/copyleft', license: 'GPL-3.0' }),
        'upstream/greeting': locked(),
      }),
      agents: { frontend: ['upstream/copyleft', 'upstream/greeting'], designer: ['upstream/copyleft'] },
      extra: {
        'packs/api/pack.yaml': packYaml('api'),
        ...agent('api', 'backend', ['upstream/copyleft', 'upstream/greeting']),
      },
      checkout: { ...checkoutFiles(), 'skills/copyleft/SKILL.md': copyleft['SKILL.md']! },
    });
    expect(diagnostics.map((d) => [d.rule, d.message.split(':')[0]])).toEqual([['LICENSE-DISALLOWED', '"upstream/copyleft"']]);
    const web = library.packs.find((p) => p.name === 'web')!;
    const api = library.packs.find((p) => p.name === 'api')!;
    expect(Object.keys(web.skills).sort()).toEqual(['upstream/copyleft', 'upstream/greeting']);
    expect(api.skills['upstream/copyleft']).toBe(web.skills['upstream/copyleft']);
    expect(api.skills['upstream/greeting']).toBe(web.skills['upstream/greeting']);
    expect(ensureCommit).toHaveBeenCalledTimes(1);
    expect(ensureCommit).toHaveBeenCalledWith(expect.any(String), 'upstream', REPO, COMMIT);
  });

  it('first-party and third-party skills resolve side by side in one pack', async () => {
    const { library, diagnostics } = await resolve({
      lock: lockOf({ 'upstream/greeting': locked() }),
      agents: { frontend: ['react', 'upstream/greeting'] },
      extra: { 'skills/react/SKILL.md': skillMd('react') },
    });
    expect(diagnostics).toEqual([]);
    const { skills } = library.packs[0]!;
    expect(skills['react']!.origin).toEqual({ kind: 'first-party' });
    expect(skills['upstream/greeting']!.origin).toMatchObject({ kind: 'third-party' });
  });

  it('a GitError from fetching propagates', async () => {
    const lock = lockOf({ 'upstream/greeting': locked() }, { repo: 'file:///ronin-test-no-such-repository' });
    await expect(
      resolve({ lock, sources: sourcesYaml({ repo: 'file:///ronin-test-no-such-repository' }), checkout: null }),
    ).rejects.toBeInstanceOf(GitError);
  });

  it('missing cache commit is fetched, and a lock written by runLock verifies (the root LICENSE is not hashed)', async () => {
    const up = await makeUpstream({
      LICENSE: MIT_TEXT,
      'skills/greeting/SKILL.md': GREETING['SKILL.md']!,
      'skills/greeting/references/hello.md': 'Hello.\n',
      'skills/greeting/scripts/run.sh': { content: '#!/bin/sh\n', executable: true },
    });
    made.push(up.dir);
    const root = await makeProject({
      'ronin.yaml': RONIN_YAML,
      'sources.yaml': sourcesYaml({ repo: up.url }),
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['upstream/greeting']),
    });
    made.push(root);
    const { project, diagnostics: loadDiagnostics } = await loadProject(root);
    expect(loadDiagnostics).toEqual([]);

    expect(await runLock(project, { update: [] })).toEqual([]);
    const { lock } = await readLock(root);
    expect(lock.skills['upstream/greeting']).toMatchObject({ license: 'MIT', licenseFrom: 'repo-root' });

    // runLock filled the cache; take it away, so that resolving has to fetch the locked commit again.
    await rm(path.join(root, '.ronin', 'cache'), { recursive: true });
    vi.mocked(ensureCommit).mockClear();

    const { library, diagnostics } = await resolveLibrary(project, lock);
    expect(diagnostics).toEqual([]);
    expect(ensureCommit).toHaveBeenCalledTimes(1);

    const skill = library.packs[0]!.skills['upstream/greeting']!;
    expect(skill.origin).toEqual({ kind: 'third-party', repo: up.url, commit: up.commit, path: 'skills/greeting' });
    expect(skill.license).toEqual({ spdx: 'MIT', file: 'LICENSE' });
    expect(skill.files.map((f) => [f.path, f.executable])).toEqual([
      ['SKILL.md', false],
      ['references/hello.md', false],
      ['scripts/run.sh', true],
      ['LICENSE', false],
    ]);
    expect(skill.files.at(-1)!.bytes).toEqual(enc(MIT_TEXT));

    // A second run finds the cache and does not need the upstream.
    await rm(up.dir, { recursive: true, force: true });
    const again = await resolveLibrary(project, lock);
    expect(again.diagnostics).toEqual([]);
  });
});
