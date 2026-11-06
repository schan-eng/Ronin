import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageError } from '../../src/core/diagnostics.js';
import { readTree } from '../../src/core/files.js';
import { loadProject } from '../../src/core/load.js';
import { SYMLINK_MESSAGE } from '../../src/core/load-util.js';
import type { Project } from '../../src/core/model.js';
import { hashSkillFiles } from '../../src/lock/hash.js';
import { GitError } from '../../src/lock/git.js';
import { readLock } from '../../src/lock/lockfile.js';
import { runLock } from '../../src/lock/lock.js';
import { makeProject } from '../helpers/fs.js';
import type { ProjectFile } from '../helpers/fs.js';
import { commitUpstream, makeUpstream, runGit } from '../helpers/git.js';
import type { Upstream } from '../helpers/git.js';

// The real MIT / GPL license starts, as the detector recognizes them.
const MIT = `MIT License

Copyright (c) 2024 Example Author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.
`;
const APACHE = `                                 Apache License
                           Version 2.0, January 2004
`;
const GPL3 = `                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007
`;
const UNRECOGNIZED = 'Do whatever you want, but do not blame me.\n';

const RONIN_YAML = 'marketplace:\n  name: ronin\n  owner:\n    name: t\n';
const PACK_YAML = 'name: web\nversion: 0.1.0\ndescription: Web.\n';

const skillMd = (name: string, extra = ''): string => `---\nname: ${name}\ndescription: A skill.\n${extra}---\nBody.\n`;

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function upstream(files: Record<string, ProjectFile>): Promise<Upstream> {
  const up = await makeUpstream(files);
  made.push(up.dir);
  return up;
}

/** An upstream laid out as spec 5.7 describes: `root: skills`, a repo-root MIT license, and these skills. */
function upstreamWith(...skills: string[]): Promise<Upstream> {
  const files: Record<string, ProjectFile> = { LICENSE: MIT };
  for (const name of skills) files[`skills/${name}/SKILL.md`] = skillMd(name);
  return upstream(files);
}

function sourcesYaml(
  sources: Record<string, { repo: string; ref?: string; root?: string; licenses?: Record<string, string> }>,
): string {
  const lines = ['sources:'];
  for (const [name, s] of Object.entries(sources)) {
    lines.push(`  ${name}:`, `    repo: ${s.repo}`, `    ref: ${s.ref ?? 'main'}`);
    if (s.root !== undefined) lines.push(`    root: ${s.root}`);
    if (s.licenses) {
      lines.push('    licenses:');
      for (const [skill, spdx] of Object.entries(s.licenses)) {
        lines.push(`      ${skill}:`, `        spdx: ${spdx}`, '        reason: Stated upstream.');
      }
    }
  }
  return lines.join('\n') + '\n';
}

/** `{ api: ['upstream/greeting'] }` becomes `packs/web/agents/api.md` with those skills. */
function agentFiles(agents: Record<string, string[]>): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, skills] of Object.entries(agents)) {
    files[`packs/web/agents/${name}.md`] =
      `---\nname: ${name}\ndescription: Does ${name}.\nskills: [${skills.join(', ')}]\n---\nYou are ${name}.\n`;
  }
  return files;
}

const AGENTS = { api: ['upstream/greeting'], frontend: ['upstream/greeting'] };

/** Writes a project and loads it; the loader must find nothing wrong with it. */
async function setup(
  sources: string,
  agents: Record<string, string[]> = AGENTS,
  extra: Record<string, ProjectFile> = {},
): Promise<{ root: string; project: Project }> {
  const root = await makeProject({
    'ronin.yaml': RONIN_YAML,
    'packs/web/pack.yaml': PACK_YAML,
    'sources.yaml': sources,
    ...agentFiles(agents),
    ...extra,
  });
  made.push(root);
  return { root, project: await reload(root) };
}

async function reload(root: string): Promise<Project> {
  const { project, diagnostics } = await loadProject(root);
  expect(diagnostics).toEqual([]);
  return project;
}

const NONE = { update: [] as string[] };
const NO_SOURCES = 'sources: {}\n';

/** The sources.yaml of the usual case: one source `upstream` at `up`, root `skills`. */
function simple(up: Upstream, more: { licenses?: Record<string, string>; ref?: string } = {}): string {
  return sourcesYaml({ upstream: { repo: up.url, root: 'skills', ...more } });
}

async function lockOf(root: string) {
  const { lock, diagnostics } = await readLock(root);
  expect(diagnostics).toEqual([]);
  return lock;
}

async function lockText(root: string): Promise<string | null> {
  return readFile(path.join(root, 'ronin.lock'), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
}

function cacheDir(root: string, source: string, commit: string): string {
  return path.join(root, '.ronin', 'cache', source, commit);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

describe('runLock', () => {
  it('pins main to its commit and records hash + license', async () => {
    const up = await upstreamWith('greeting');
    const { root, project } = await setup(simple(up));

    expect(await runLock(project, NONE)).toEqual([]);

    const lock = await lockOf(root);
    expect(lock.sources).toEqual({ upstream: { repo: up.url, ref: 'main', commit: up.commit } });
    const cached = await readTree(path.join(cacheDir(root, 'upstream', up.commit), 'skills', 'greeting'));
    expect(lock.skills).toEqual({
      'upstream/greeting': {
        path: 'skills/greeting',
        sha256: hashSkillFiles(cached.files),
        license: 'MIT',
        licenseFrom: 'repo-root',
        licenseFile: 'LICENSE',
      },
    });
  });

  it('writes the lock deterministically: a second run leaves it byte for byte unchanged', async () => {
    const up = await upstreamWith('greeting', 'farewell');
    const { root, project } = await setup(simple(up), { api: ['upstream/greeting', 'upstream/farewell'] });
    await runLock(project, NONE);
    const first = await lockText(root);
    await runLock(project, NONE);
    expect(await lockText(root)).toBe(first);
    expect(first).toMatch(/^lockVersion: 1\n/);
  });

  describe('which commit is used', () => {
    it('is sticky, and update re-resolves', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up));
      await runLock(project, NONE);

      const next = await commitUpstream(up.dir, { 'skills/greeting/extra.md': 'more\n' });
      await runLock(project, NONE);
      expect((await lockOf(root)).sources['upstream']?.commit).toBe(up.commit);

      await runLock(project, { update: ['upstream'] });
      const lock = await lockOf(root);
      expect(lock.sources['upstream']?.commit).toBe(next);
      // The skill is re-hashed from the new commit.
      const cached = await readTree(path.join(cacheDir(root, 'upstream', next), 'skills', 'greeting'));
      expect(lock.skills['upstream/greeting']?.sha256).toBe(hashSkillFiles(cached.files));
    });

    it('re-resolves without update when the ref in sources.yaml changed', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up));
      await runLock(project, NONE);

      const next = await commitUpstream(up.dir, { 'skills/greeting/extra.md': 'more\n' });
      await runGit(up.dir, ['branch', 'dev']);
      await writeFile(path.join(root, 'sources.yaml'), simple(up, { ref: 'dev' }));
      await runLock(await reload(root), NONE);

      expect((await lockOf(root)).sources['upstream']).toEqual({ repo: up.url, ref: 'dev', commit: next });
    });

    it('re-resolves without update when the repo in sources.yaml changed', async () => {
      const up = await upstreamWith('greeting');
      const other = await upstream({ LICENSE: MIT, 'skills/greeting/SKILL.md': skillMd('greeting', '# other\n') });
      const { root, project } = await setup(simple(up));
      await runLock(project, NONE);

      await writeFile(path.join(root, 'sources.yaml'), simple(other));
      await runLock(await reload(root), NONE);

      expect((await lockOf(root)).sources['upstream']).toEqual({ repo: other.url, ref: 'main', commit: other.commit });
    });

    it('takes a 40-hex ref as it is', async () => {
      const up = await upstreamWith('greeting');
      await commitUpstream(up.dir, { 'skills/greeting/extra.md': 'more\n' });
      const { root, project } = await setup(simple(up, { ref: up.commit }));
      await runLock(project, NONE);
      expect((await lockOf(root)).sources['upstream']).toEqual({ repo: up.url, ref: up.commit, commit: up.commit });
    });

    it('update naming a source no agent references does nothing', async () => {
      const up = await upstreamWith('greeting');
      const sources = sourcesYaml({
        upstream: { repo: up.url, root: 'skills' },
        // Fetching this one would fail, so passing means it was never touched.
        spare: { repo: 'file:///ronin-test-does-not-exist', root: 'skills' },
      });
      const { root, project } = await setup(sources);
      await runLock(project, { update: ['spare'] });
      expect(Object.keys((await lockOf(root)).sources)).toEqual(['upstream']);
    });
  });

  describe('what is locked', () => {
    it('only locks referenced skills', async () => {
      const up = await upstreamWith('greeting', 'farewell');
      const { root, project } = await setup(simple(up)); // both agents use only greeting
      await runLock(project, NONE);
      expect(Object.keys((await lockOf(root)).skills)).toEqual(['upstream/greeting']);
    });

    it('only locks and fetches referenced sources', async () => {
      const up = await upstreamWith('greeting');
      const sources = sourcesYaml({
        upstream: { repo: up.url, root: 'skills' },
        spare: { repo: 'file:///ronin-test-does-not-exist', root: 'skills' },
      });
      const { root, project } = await setup(sources);
      expect(await runLock(project, NONE)).toEqual([]);
      expect(Object.keys((await lockOf(root)).sources)).toEqual(['upstream']);
      expect(await exists(path.join(root, '.ronin', 'cache', 'spare'))).toBe(false);
    });

    it('ignores first-party skill references, and still writes an (empty) lock', async () => {
      const { root, project } = await setup(NO_SOURCES, { api: ['react'] });
      expect(await runLock(project, NONE)).toEqual([]);
      expect(await lockOf(root)).toEqual({ lockVersion: 1, sources: {}, skills: {} });
    });

    it('locks a skill under root "." at its bare name', async () => {
      const up = await upstream({ LICENSE: MIT, 'greeting/SKILL.md': skillMd('greeting') });
      const { root, project } = await setup(sourcesYaml({ upstream: { repo: up.url, root: '.' } }));
      await runLock(project, NONE);
      expect((await lockOf(root)).skills['upstream/greeting']).toMatchObject({
        path: 'greeting',
        licenseFile: 'LICENSE',
      });
    });

    it('normalizes a root written with a leading ./ or a trailing /', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(sourcesYaml({ upstream: { repo: up.url, root: './skills/' } }));
      await runLock(project, NONE);
      expect((await lockOf(root)).skills['upstream/greeting']?.path).toBe('skills/greeting');
    });

    it('hashes the whole skill directory', async () => {
      const up = await upstream({
        LICENSE: MIT,
        'skills/greeting/SKILL.md': skillMd('greeting'),
        'skills/greeting/scripts/run.sh': { content: '#!/bin/sh\n', executable: true },
      });
      const { root, project } = await setup(simple(up));
      await runLock(project, NONE);
      const cached = await readTree(path.join(cacheDir(root, 'upstream', up.commit), 'skills', 'greeting'));
      expect(cached.files.map((f) => f.path)).toEqual(['SKILL.md', 'scripts/run.sh']);
      expect((await lockOf(root)).skills['upstream/greeting']?.sha256).toBe(hashSkillFiles(cached.files));
    });
  });

  describe('licenses', () => {
    it('an assertion in sources.yaml wins, and has no license file', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up, { licenses: { greeting: 'Apache-2.0' } }));
      expect(await runLock(project, NONE)).toEqual([]);
      expect((await lockOf(root)).skills['upstream/greeting']).toEqual({
        path: 'skills/greeting',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        license: 'Apache-2.0',
        licenseFrom: 'asserted',
      });
    });

    it('picks up a changed assertion on the next run without update', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up));
      await runLock(project, NONE);
      expect((await lockOf(root)).skills['upstream/greeting']?.licenseFrom).toBe('repo-root');

      await writeFile(path.join(root, 'sources.yaml'), simple(up, { licenses: { greeting: 'ISC' } }));
      await runLock(await reload(root), NONE);
      expect((await lockOf(root)).skills['upstream/greeting']).toMatchObject({ license: 'ISC', licenseFrom: 'asserted' });
    });

    it('reads an allowlisted license from the SKILL.md frontmatter', async () => {
      const up = await upstream({ 'skills/greeting/SKILL.md': skillMd('greeting', 'license: Apache-2.0\n') });
      const { root, project } = await setup(simple(up));
      expect(await runLock(project, NONE)).toEqual([]);
      const skill = (await lockOf(root)).skills['upstream/greeting'];
      expect(skill).toMatchObject({ license: 'Apache-2.0', licenseFrom: 'frontmatter' });
      expect(skill).not.toHaveProperty('licenseFile');
    });

    it('treats a SKILL.md whose frontmatter does not parse as having no frontmatter license', async () => {
      const up = await upstream({ LICENSE: MIT, 'skills/greeting/SKILL.md': 'no frontmatter here\n' });
      const { root, project } = await setup(simple(up));
      expect(await runLock(project, NONE)).toEqual([]);
      expect((await lockOf(root)).skills['upstream/greeting']).toMatchObject({ license: 'MIT', licenseFrom: 'repo-root' });
    });

    it('uses a license file in the skill directory, recorded by its path in the upstream repo', async () => {
      const up = await upstream({
        LICENSE: MIT,
        'skills/greeting/SKILL.md': skillMd('greeting'),
        'skills/greeting/LICENSE.txt': APACHE,
      });
      const { root, project } = await setup(simple(up));
      await runLock(project, NONE);
      expect((await lockOf(root)).skills['upstream/greeting']).toMatchObject({
        license: 'Apache-2.0',
        licenseFrom: 'skill-file',
        licenseFile: 'skills/greeting/LICENSE.txt',
      });
    });

    it('does not read a repo-root license that is a symbolic link', async () => {
      const up = await upstream({ 'skills/greeting/SKILL.md': skillMd('greeting'), 'real-license': MIT });
      await symlink('real-license', path.join(up.dir, 'LICENSE'));
      const commit = await commitUpstream(up.dir, {});
      const { root, project } = await setup(simple(up, { ref: commit }));
      const diagnostics = await runLock(project, NONE);
      expect(diagnostics.map((d) => d.rule)).toEqual(['LICENSE-UNKNOWN']);
      expect((await lockOf(root)).skills['upstream/greeting']).toMatchObject({ license: null, licenseFrom: null });
    });

    it('unknown license: lock written with license null, and LICENSE-UNKNOWN', async () => {
      const up = await upstream({ 'skills/greeting/SKILL.md': skillMd('greeting') });
      const { root, project } = await setup(simple(up));

      const diagnostics = await runLock(project, NONE);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.lock', severity: 'error', rule: 'LICENSE-UNKNOWN' });
      expect(diagnostics[0]?.message).toContain('"upstream/greeting"');
      const skill = (await lockOf(root)).skills['upstream/greeting'];
      expect(skill).toMatchObject({ license: null, licenseFrom: null });
      expect(skill).not.toHaveProperty('licenseFile');
    });

    it('an unrecognized license file is LICENSE-UNKNOWN, and the file is still recorded', async () => {
      const up = await upstream({ LICENSE: UNRECOGNIZED, 'skills/greeting/SKILL.md': skillMd('greeting') });
      const { root, project } = await setup(simple(up));
      const diagnostics = await runLock(project, NONE);
      expect(diagnostics.map((d) => d.rule)).toEqual(['LICENSE-UNKNOWN']);
      expect((await lockOf(root)).skills['upstream/greeting']).toMatchObject({
        license: null,
        licenseFrom: 'repo-root',
        licenseFile: 'LICENSE',
      });
    });

    it('a license outside the allowlist: LICENSE-DISALLOWED, and the lock is still written', async () => {
      const up = await upstream({ LICENSE: GPL3, 'skills/greeting/SKILL.md': skillMd('greeting') });
      const { root, project } = await setup(simple(up));

      const diagnostics = await runLock(project, NONE);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.lock', severity: 'error', rule: 'LICENSE-DISALLOWED' });
      expect(diagnostics[0]?.message).toContain('GPL-3.0');
      expect((await lockOf(root)).skills['upstream/greeting']).toMatchObject({
        license: 'GPL-3.0',
        licenseFrom: 'repo-root',
        licenseFile: 'LICENSE',
      });
    });

    it('an asserted license outside the allowlist is LICENSE-DISALLOWED too', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up, { licenses: { greeting: 'GPL-3.0' } }));
      const diagnostics = await runLock(project, NONE);
      expect(diagnostics.map((d) => d.rule)).toEqual(['LICENSE-DISALLOWED']);
      expect((await lockOf(root)).skills['upstream/greeting']).toMatchObject({ license: 'GPL-3.0', licenseFrom: 'asserted' });
    });

    it('looks assertions up by own property only', async () => {
      const up = await upstream({ LICENSE: MIT, 'skills/constructor/SKILL.md': skillMd('constructor') });
      const { root, project } = await setup(simple(up), { api: ['upstream/constructor'] });
      expect(await runLock(project, NONE)).toEqual([]);
      expect((await lockOf(root)).skills['upstream/constructor']).toMatchObject({ license: 'MIT', licenseFrom: 'repo-root' });
    });
  });

  describe('SKILL-UNRESOLVED', () => {
    it('skill deleted upstream after update: names both agents, and the skill is left out', async () => {
      const up = await upstream({
        LICENSE: MIT,
        'skills/greeting/SKILL.md': skillMd('greeting'),
        'skills/greeting/notes.md': 'notes\n',
        'skills/farewell/SKILL.md': skillMd('farewell'),
      });
      const { root, project } = await setup(simple(up), {
        // Listed in this order, but reported sorted.
        frontend: ['upstream/greeting', 'upstream/farewell'],
        api: ['upstream/greeting'],
      });
      await runLock(project, NONE);
      expect(Object.keys((await lockOf(root)).skills)).toEqual(['upstream/farewell', 'upstream/greeting']);

      // The directory stays, without its SKILL.md.
      const next = await commitUpstream(up.dir, { 'skills/greeting/SKILL.md': null });
      const diagnostics = await runLock(project, { update: ['upstream'] });

      expect(diagnostics).toEqual([
        {
          path: 'ronin.lock',
          severity: 'error',
          rule: 'SKILL-UNRESOLVED',
          message: `"upstream/greeting" not found at ${next}; referenced by packs/web/agents/api.md, packs/web/agents/frontend.md`,
        },
      ]);
      const lock = await lockOf(root);
      expect(Object.keys(lock.skills)).toEqual(['upstream/farewell']);
      expect(lock.sources['upstream']?.commit).toBe(next);
    });

    it('a skill directory that is gone altogether is unresolved too', async () => {
      const up = await upstreamWith('greeting', 'farewell');
      await commitUpstream(up.dir, { 'skills/greeting/SKILL.md': null });
      const { root, project } = await setup(simple(up));
      const diagnostics = await runLock(project, NONE);
      expect(diagnostics.map((d) => d.rule)).toEqual(['SKILL-UNRESOLVED']);
      expect((await lockOf(root)).skills).toEqual({});
    });

    it('a missing root directory is unresolved', async () => {
      const up = await upstream({ LICENSE: MIT, 'other/greeting/SKILL.md': skillMd('greeting') });
      const { root, project } = await setup(simple(up));
      const diagnostics = await runLock(project, NONE);
      expect(diagnostics.map((d) => d.rule)).toEqual(['SKILL-UNRESOLVED']);
      expect((await lockOf(root)).skills).toEqual({});
    });

    it('a file where the skill directory should be is unresolved', async () => {
      const up = await upstream({ LICENSE: MIT, 'skills/greeting': 'not a directory\n' });
      const { project } = await setup(simple(up));
      expect((await runLock(project, NONE)).map((d) => d.rule)).toEqual(['SKILL-UNRESOLVED']);
    });

    it('a directory where SKILL.md should be is unresolved', async () => {
      const up = await upstream({ LICENSE: MIT, 'skills/greeting/SKILL.md/inner.md': 'x\n' });
      const { project } = await setup(simple(up));
      expect((await runLock(project, NONE)).map((d) => d.rule)).toEqual(['SKILL-UNRESOLVED']);
    });

    it('an unresolved skill does not stop the others from being locked', async () => {
      const up = await upstreamWith('farewell');
      const { root, project } = await setup(simple(up), { api: ['upstream/greeting', 'upstream/farewell'] });
      const diagnostics = await runLock(project, NONE);
      expect(diagnostics.map((d) => d.rule)).toEqual(['SKILL-UNRESOLVED']);
      expect(Object.keys((await lockOf(root)).skills)).toEqual(['upstream/farewell']);
    });

    it('unknown source: reported at ronin.lock, naming both agents; the rest is still locked', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up), {
        frontend: ['upstream/greeting', 'ghost/thing'],
        api: ['ghost/thing'],
      });

      const diagnostics = await runLock(project, NONE);

      expect(diagnostics).toEqual([
        {
          path: 'ronin.lock',
          severity: 'error',
          rule: 'SKILL-UNRESOLVED',
          message:
            '"ghost/thing": unknown source "ghost"; referenced by packs/web/agents/api.md, packs/web/agents/frontend.md',
        },
      ]);
      const lock = await lockOf(root);
      expect(Object.keys(lock.sources)).toEqual(['upstream']);
      expect(Object.keys(lock.skills)).toEqual(['upstream/greeting']);
    });

    it('looks sources up by own property only', async () => {
      const { root, project } = await setup(NO_SOURCES, { api: ['constructor/thing'] });
      const diagnostics = await runLock(project, NONE);
      expect(diagnostics.map((d) => [d.rule, d.message])).toEqual([
        [
          'SKILL-UNRESOLVED',
          '"constructor/thing": unknown source "constructor"; referenced by packs/web/agents/api.md',
        ],
      ]);
      expect((await lockOf(root)).sources).toEqual({});
    });
  });

  describe('symbolic links', () => {
    it('a symlink inside a skill: SCHEMA naming the skill and the link; the skill is left out; no lock written', async () => {
      const up = await upstreamWith('greeting', 'farewell');
      await symlink('../../LICENSE', path.join(up.dir, 'skills', 'greeting', 'link.md'));
      const commit = await commitUpstream(up.dir, {});
      const { root, project } = await setup(simple(up, { ref: commit }), {
        api: ['upstream/greeting', 'upstream/farewell'],
      });

      const diagnostics = await runLock(project, NONE);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.lock', severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]?.message).toContain(SYMLINK_MESSAGE);
      expect(diagnostics[0]?.message).toContain('upstream/greeting');
      expect(diagnostics[0]?.message).toContain('skills/greeting/link.md');
      expect(await lockText(root)).toBeNull();
    });

    it('an existing lock is left as it was when a symlink blocks the write', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up));
      await runLock(project, NONE);
      const before = await lockText(root);

      await symlink('../../LICENSE', path.join(up.dir, 'skills', 'greeting', 'link.md'));
      await commitUpstream(up.dir, {});
      const diagnostics = await runLock(project, { update: ['upstream'] });

      expect(diagnostics.map((d) => d.rule)).toEqual(['SCHEMA']);
      expect(await lockText(root)).toBe(before);
    });

    it('a symlink nested deeper in the skill is found and named by its path', async () => {
      const up = await upstream({ LICENSE: MIT, 'skills/greeting/SKILL.md': skillMd('greeting') });
      await mkdir(path.join(up.dir, 'skills', 'greeting', 'assets'));
      await symlink('../../../outside', path.join(up.dir, 'skills', 'greeting', 'assets', 'host'));
      const commit = await commitUpstream(up.dir, {});
      const { root, project } = await setup(simple(up, { ref: commit }));
      const diagnostics = await runLock(project, NONE);
      expect(diagnostics.map((d) => d.rule)).toEqual(['SCHEMA']);
      expect(diagnostics[0]?.message).toContain('skills/greeting/assets/host');
      expect(await lockText(root)).toBeNull();
    });

    it('a skill directory that is itself a symlink: SCHEMA, no lock written', async () => {
      const up = await upstream({ LICENSE: MIT, 'elsewhere/SKILL.md': skillMd('greeting') });
      await mkdir(path.join(up.dir, 'skills'));
      await symlink('../elsewhere', path.join(up.dir, 'skills', 'greeting'));
      const commit = await commitUpstream(up.dir, {});
      const { root, project } = await setup(simple(up, { ref: commit }));

      const diagnostics = await runLock(project, NONE);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.lock', severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]?.message).toContain(SYMLINK_MESSAGE);
      expect(diagnostics[0]?.message).toContain('upstream/greeting');
      expect(diagnostics[0]?.message).toContain('skills/greeting');
      expect(await lockText(root)).toBeNull();
    });

    it('a symlinked directory in the source root: SCHEMA, no lock written', async () => {
      const up = await upstream({ LICENSE: MIT, 'real/greeting/SKILL.md': skillMd('greeting') });
      await symlink('real', path.join(up.dir, 'skills'));
      const commit = await commitUpstream(up.dir, {});
      const { root, project } = await setup(simple(up, { ref: commit }));

      const diagnostics = await runLock(project, NONE);

      expect(diagnostics.map((d) => d.rule)).toEqual(['SCHEMA']);
      expect(diagnostics[0]?.message).toContain(SYMLINK_MESSAGE);
      expect(diagnostics[0]?.message).toContain('upstream/greeting');
      expect(await lockText(root)).toBeNull();
    });
  });

  describe('failures', () => {
    it('update naming a source that is not in sources.yaml: UsageError, before any git work', async () => {
      // `upstream`'s repo does not exist, so any git work would throw a GitError instead.
      const { root, project } = await setup(sourcesYaml({ upstream: { repo: 'file:///ronin-test-does-not-exist' } }));
      const err = await runLock(project, { update: ['upstream', 'nope'] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toContain('"nope"');
      expect(await exists(path.join(root, '.ronin'))).toBe(false);
      expect(await lockText(root)).toBeNull();
    });

    it('update checks names by own property only', async () => {
      const { project } = await setup(NO_SOURCES);
      await expect(runLock(project, { update: ['constructor'] })).rejects.toBeInstanceOf(UsageError);
    });

    it('a git failure propagates, and no lock is written', async () => {
      const up = await upstreamWith('greeting');
      const sources = sourcesYaml({
        // Sorted before `upstream`, so this one is the first to be fetched.
        aaa: { repo: 'file:///ronin-test-does-not-exist', root: 'skills' },
        upstream: { repo: up.url, root: 'skills' },
      });
      const { root, project } = await setup(sources, { api: ['aaa/x', 'upstream/greeting'] });
      await expect(runLock(project, NONE)).rejects.toBeInstanceOf(GitError);
      expect(await lockText(root)).toBeNull();
    });

    it('an unresolvable ref propagates as a GitError', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up, { ref: 'no-such-branch' }));
      await expect(runLock(project, NONE)).rejects.toBeInstanceOf(GitError);
      expect(await lockText(root)).toBeNull();
    });

    it('treats an invalid existing lock as empty, regenerates it, and reports nothing about it', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up), AGENTS, { 'ronin.lock': 'lockVersion: 7\nsources: nope\n' });
      expect((await readLock(root)).diagnostics.length).toBeGreaterThan(0);

      expect(await runLock(project, NONE)).toEqual([]);

      expect((await lockOf(root)).sources['upstream']?.commit).toBe(up.commit);
    });

    it('re-resolves a source whose entry was in an invalid lock, rather than keeping its commit', async () => {
      const up = await upstreamWith('greeting');
      const stale = 'a'.repeat(40);
      // Valid except for `licenseFrom`, which makes the whole lock unusable.
      const lock = `lockVersion: 1
sources:
  upstream:
    repo: ${up.url}
    ref: main
    commit: ${stale}
skills:
  upstream/greeting:
    path: skills/greeting
    sha256: ${'0'.repeat(64)}
    license: MIT
    licenseFrom: bogus
`;
      const { root, project } = await setup(simple(up), AGENTS, { 'ronin.lock': lock });
      await runLock(project, NONE);
      expect((await lockOf(root)).sources['upstream']?.commit).toBe(up.commit);
    });

    it('keeps the locked commit of a valid lock without contacting the repository', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up));
      await runLock(project, NONE);
      // The repository is gone; the commit is sticky and the checkout is cached.
      await rm(up.dir, { recursive: true, force: true });
      expect(await runLock(project, NONE)).toEqual([]);
      expect((await lockOf(root)).sources['upstream']?.commit).toBe(up.commit);
    });
  });

  describe('malformed references in a hand-built project', () => {
    it('is a NAME error and never reaches git or the file system', async () => {
      const up = await upstreamWith('greeting');
      const { root, project } = await setup(simple(up), { api: ['upstream/greeting'] });
      project.packs[0]!.agents[0]!.skills = ['upstream/../../x', 'a/b/c', '/x'];

      const diagnostics = await runLock(project, NONE);

      expect(diagnostics.map((d) => [d.rule, d.path])).toEqual([
        ['NAME', 'packs/web/agents/api.md'],
        ['NAME', 'packs/web/agents/api.md'],
        ['NAME', 'packs/web/agents/api.md'],
      ]);
      expect(diagnostics[0]?.message).toContain('upstream/../../x');
      expect(await exists(path.join(root, '.ronin'))).toBe(false);
    });
  });
});
