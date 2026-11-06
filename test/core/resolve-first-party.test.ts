import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/load.js';
import { resolveLibrary } from '../../src/core/resolve.js';
import { emptyLock } from '../../src/lock/lockfile.js';
import { enc, makeProject } from '../helpers/fs.js';
import type { ProjectFile } from '../helpers/fs.js';

const RONIN_YAML = 'marketplace:\n  name: ronin\n  owner:\n    name: t\n  description: A library.\n';
const SOURCES_YAML = 'sources:\n  anthropic:\n    repo: https://example.com/anthropic.git\n    ref: main\n';

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
const GPL3_TEXT = 'GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n';
const UNKNOWN_TEXT = 'All rights reserved. Do not copy.\n';

/** A SKILL.md: one `key: value` frontmatter line per field, then the body. */
function skillMd(name: string, extra: Record<string, string> = {}): string {
  // Quoted, so that a name like `9` stays a string in YAML.
  const fields = { name: JSON.stringify(name), description: `The ${name} skill.`, ...extra };
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\nUse ${name} well.\n`;
}

function packYaml(name: string): string {
  return `name: ${name}\nversion: 1.2.3\ndescription: The ${name} pack.\n`;
}

/** An agent file at `packs/<pack>/agents/<name>.md` referencing `skills`. */
function agent(pack: string, name: string, skills: string[]): Record<string, string> {
  // Quoted, so that a reference like `9` stays a string in YAML.
  const list = skills.length === 0 ? '' : `skills: [${skills.map((s) => JSON.stringify(s)).join(', ')}]\n`;
  return {
    [`packs/${pack}/agents/${name}.md`]: `---\nname: ${name}\ndescription: The ${name} agent.\n${list}---\nYou are ${name}.\n`,
  };
}

/** Loads a project from `files` (plus `ronin.yaml`), requires it to load clean, and resolves it with an empty lock. */
async function resolve(files: Record<string, ProjectFile>) {
  const root = await makeProject({ 'ronin.yaml': RONIN_YAML, ...files });
  const { project, diagnostics: loadDiagnostics } = await loadProject(root);
  expect(loadDiagnostics).toEqual([]);
  return { project, ...(await resolveLibrary(project, emptyLock())) };
}

describe('resolveLibrary: first-party and forked skills', () => {
  it('first-party skill: origin first-party, license null, files read', async () => {
    const { library, diagnostics, project } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['react']),
      'skills/react/SKILL.md': skillMd('react', { 'allowed-tools': '[Read]' }),
      'skills/react/references/guide.md': 'A guide.\n',
      'skills/react/scripts/check.sh': { content: '#!/bin/sh\necho ok\n', executable: true },
    });
    expect(diagnostics).toEqual([]);

    expect(library.marketplace).toEqual(project.marketplace);
    expect(library.packs).toHaveLength(1);
    const pack = library.packs[0]!;
    expect(pack).toMatchObject({ name: 'web', version: '1.2.3', description: 'The web pack.' });
    expect(pack.agents).toEqual(project.packs[0]!.agents);

    expect(Object.keys(pack.skills)).toEqual(['react']);
    const skill = pack.skills['react']!;
    expect(skill.id).toBe('react');
    expect(skill.description).toBe('The react skill.');
    expect(skill.frontmatter).toEqual({ name: 'react', description: 'The react skill.', 'allowed-tools': ['Read'] });
    expect(skill.origin).toEqual({ kind: 'first-party' });
    expect(skill.license).toBeNull();
    expect(skill.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/guide.md', 'scripts/check.sh']);
    expect(skill.files.map((f) => f.executable)).toEqual([false, false, true]);
    expect(skill.files[1]!.bytes).toEqual(enc('A guide.\n'));
  });

  it('an agent without skills gives a pack with no skills, and packs keep their project order', async () => {
    const { library, diagnostics, project } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', []),
      'packs/api/pack.yaml': packYaml('api'),
      ...agent('api', 'backend', ['db']),
      'skills/db/SKILL.md': skillMd('db'),
    });
    expect(diagnostics).toEqual([]);
    expect(library.packs.map((p) => p.name)).toEqual(project.packs.map((p) => p.name));
    const byName = Object.fromEntries(library.packs.map((p) => [p.name, p]));
    expect(byName['web']!.skills).toEqual({});
    expect(Object.keys(byName['api']!.skills)).toEqual(['db']);
  });

  it('fork with MIT LICENSE: origin fork, license {spdx: "MIT", file: "LICENSE"}', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['forked']),
      'skills/forked/SKILL.md': skillMd('forked'),
      'skills/forked/LICENSE': MIT_TEXT,
    });
    expect(diagnostics).toEqual([]);
    const skill = library.packs[0]!.skills['forked']!;
    expect(skill.origin).toEqual({ kind: 'fork' });
    expect(skill.license).toEqual({ spdx: 'MIT', file: 'LICENSE' });
    expect(skill.files.map((f) => f.path)).toEqual(['LICENSE', 'SKILL.md']);
  });

  it('license.file is the first license file in LICENSE_FILE_NAMES order', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['a', 'b']),
      'skills/a/SKILL.md': skillMd('a'),
      'skills/a/COPYING': MIT_TEXT,
      'skills/a/LICENSE.txt': MIT_TEXT,
      'skills/b/SKILL.md': skillMd('b'),
      'skills/b/LICENSE.md': MIT_TEXT,
    });
    expect(diagnostics).toEqual([]);
    const { skills } = library.packs[0]!;
    expect(skills['a']!.license).toEqual({ spdx: 'MIT', file: 'LICENSE.txt' });
    expect(skills['b']!.license).toEqual({ spdx: 'MIT', file: 'LICENSE.md' });
  });

  it('a frontmatter license wins for spdx, and license.file is still the license file', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['forked']),
      'skills/forked/SKILL.md': skillMd('forked', { license: 'Apache-2.0' }),
      'skills/forked/LICENSE': MIT_TEXT,
    });
    expect(diagnostics).toEqual([]);
    expect(library.packs[0]!.skills['forked']!.license).toEqual({ spdx: 'Apache-2.0', file: 'LICENSE' });
  });

  it('a frontmatter license alone does not make a fork', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['plain']),
      'skills/plain/SKILL.md': skillMd('plain', { license: 'GPL-3.0' }),
    });
    expect(diagnostics).toEqual([]);
    const skill = library.packs[0]!.skills['plain']!;
    expect(skill.origin).toEqual({ kind: 'first-party' });
    expect(skill.license).toBeNull();
  });

  it('only a top-level regular LICENSE file makes a fork', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['nested', 'lowercase']),
      'skills/nested/SKILL.md': skillMd('nested'),
      'skills/nested/references/LICENSE': GPL3_TEXT,
      'skills/nested/LICENSE/notes.txt': 'A directory named LICENSE.\n',
      'skills/lowercase/SKILL.md': skillMd('lowercase'),
      'skills/lowercase/license': GPL3_TEXT,
    });
    expect(diagnostics).toEqual([]);
    const { skills } = library.packs[0]!;
    expect(skills['nested']!.origin).toEqual({ kind: 'first-party' });
    expect(skills['lowercase']!.origin).toEqual({ kind: 'first-party' });
    expect(skills['nested']!.license).toBeNull();
    expect(skills['lowercase']!.license).toBeNull();
  });

  it('fork with GPL-3 LICENSE: LICENSE-DISALLOWED at skills/x/SKILL.md, skill kept', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['x']),
      'skills/x/SKILL.md': skillMd('x'),
      'skills/x/LICENSE': GPL3_TEXT,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      path: 'skills/x/SKILL.md',
      severity: 'error',
      rule: 'LICENSE-DISALLOWED',
    });
    expect(diagnostics[0]!.message).toBe(
      '"x": license GPL-3.0 is not on the allowlist ' +
        '(MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, CC0-1.0, CC-BY-4.0)',
    );
    expect(library.packs[0]!.skills['x']!.license).toEqual({ spdx: 'GPL-3.0', file: 'LICENSE' });
  });

  it('fork with an unrecognized LICENSE: LICENSE-UNKNOWN at SKILL.md, license NOASSERTION', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['x']),
      'skills/x/SKILL.md': skillMd('x'),
      'skills/x/LICENSE.txt': UNKNOWN_TEXT,
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ path: 'skills/x/SKILL.md', severity: 'error', rule: 'LICENSE-UNKNOWN' });
    expect(diagnostics[0]!.message).toBe(
      '"x": license could not be determined (LICENSE.txt is not a recognized license text); ' +
        'keep the upstream license file unchanged',
    );
    const skill = library.packs[0]!.skills['x']!;
    expect(skill.origin).toEqual({ kind: 'fork' });
    expect(skill.license).toEqual({ spdx: 'NOASSERTION', file: 'LICENSE.txt' });
  });

  it('shared skill appears once in pack.skills, and its files are read once for all packs', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['react', 'forked']),
      ...agent('web', 'designer', ['react']),
      'packs/api/pack.yaml': packYaml('api'),
      ...agent('api', 'backend', ['react', 'forked']),
      'skills/react/SKILL.md': skillMd('react'),
      'skills/forked/SKILL.md': skillMd('forked'),
      'skills/forked/LICENSE': MIT_TEXT,
    });
    expect(diagnostics).toEqual([]);
    const web = library.packs.find((p) => p.name === 'web')!;
    const api = library.packs.find((p) => p.name === 'api')!;
    expect(Object.keys(web.skills)).toEqual(['forked', 'react']);
    expect(Object.keys(api.skills)).toEqual(['forked', 'react']);
    expect(api.skills['react']).toBe(web.skills['react']);
    expect(api.skills['forked']).toBe(web.skills['forked']);
  });

  it('pack.skills is filled in plain-sorted id order, whatever order the agents list them in', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['vue', 'a1', 'react']),
      ...agent('web', 'designer', ['css', 'a-b', '1st']),
      'skills/vue/SKILL.md': skillMd('vue'),
      'skills/a1/SKILL.md': skillMd('a1'),
      'skills/react/SKILL.md': skillMd('react'),
      'skills/css/SKILL.md': skillMd('css'),
      'skills/a-b/SKILL.md': skillMd('a-b'),
      'skills/1st/SKILL.md': skillMd('1st'),
    });
    expect(diagnostics).toEqual([]);
    expect(Object.keys(library.packs[0]!.skills)).toEqual(['1st', 'a-b', 'a1', 'css', 'react', 'vue']);
  });

  it('integer-like skill ids enumerate first in pack.skills, so consumers must sort the keys themselves', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['a', '10', '9']),
      'skills/a/SKILL.md': skillMd('a'),
      'skills/10/SKILL.md': skillMd('10'),
      'skills/9/SKILL.md': skillMd('9'),
    });
    expect(diagnostics).toEqual([]);
    const { skills } = library.packs[0]!;
    // JavaScript enumerates integer-like keys first, in numeric order, whatever order they were added in.
    expect(Object.keys(skills)).toEqual(['9', '10', 'a']);
    // Plain string order, which is what renderers need (the default sort compares UTF-16 code units).
    expect(Object.keys(skills).sort()).toEqual(['10', '9', 'a']);
  });

  it('only the skills a pack references are in its skills', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['react']),
      'skills/react/SKILL.md': skillMd('react'),
      'skills/unused/SKILL.md': skillMd('unused'),
    });
    expect(diagnostics).toEqual([]);
    expect(Object.keys(library.packs[0]!.skills)).toEqual(['react']);
  });

  it('missing first-party skill: SKILL-UNRESOLVED at the agent file, nothing in pack.skills', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['react', 'ghost']),
      'skills/react/SKILL.md': skillMd('react'),
    });
    expect(diagnostics).toEqual([
      {
        path: 'packs/web/agents/frontend.md',
        severity: 'error',
        rule: 'SKILL-UNRESOLVED',
        message: '"ghost" not found at skills/ghost/SKILL.md; referenced by packs/web/agents/frontend.md',
      },
    ]);
    expect(Object.keys(library.packs[0]!.skills)).toEqual(['react']);
  });

  it('a missing skill referenced by two agents is one diagnostic at the first agent file, naming both', async () => {
    // The loader lists packs `a`, `a-b` (by directory name), but the agent files sort the other way round:
    // "packs/a-b/..." < "packs/a/..." because "-" (0x2d) sorts before "/" (0x2f). So only an explicit sort of
    // the agent files puts the `a-b` agent first.
    const { project, library, diagnostics } = await resolve({
      'packs/a/pack.yaml': packYaml('a'),
      ...agent('a', 'zz', ['ghost']),
      'packs/a-b/pack.yaml': packYaml('a-b'),
      ...agent('a-b', 'aa', ['ghost']),
    });
    expect(project.packs.map((p) => p.name)).toEqual(['a', 'a-b']);
    expect(diagnostics).toEqual([
      {
        path: 'packs/a-b/agents/aa.md',
        severity: 'error',
        rule: 'SKILL-UNRESOLVED',
        message:
          '"ghost" not found at skills/ghost/SKILL.md; referenced by ' +
          'packs/a-b/agents/aa.md, packs/a/agents/zz.md',
      },
    ]);
    expect(library.packs.map((p) => Object.keys(p.skills))).toEqual([[], []]);
  });

  it('each missing skill gets its own diagnostic', async () => {
    const { diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['beta', 'alpha']),
    });
    expect(diagnostics.map((d) => [d.rule, d.path, d.message.split(' ')[0]])).toEqual([
      ['SKILL-UNRESOLVED', 'packs/web/agents/frontend.md', '"alpha"'],
      ['SKILL-UNRESOLVED', 'packs/web/agents/frontend.md', '"beta"'],
    ]);
  });

  it('SKILL-COLLISION: first-party skill named like a source, at its SKILL.md, and the skill still resolves', async () => {
    const { library, diagnostics } = await resolve({
      'sources.yaml': SOURCES_YAML,
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['anthropic']),
      'skills/anthropic/SKILL.md': skillMd('anthropic'),
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      path: 'skills/anthropic/SKILL.md',
      severity: 'error',
      rule: 'SKILL-COLLISION',
    });
    expect(diagnostics[0]!.message).toContain('anthropic');
    expect(library.packs[0]!.skills['anthropic']).toMatchObject({ id: 'anthropic', origin: { kind: 'first-party' } });
  });

  it('SKILL-COLLISION fires once, even when no agent references the skill', async () => {
    const { diagnostics } = await resolve({
      'sources.yaml': SOURCES_YAML,
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', []),
      'skills/anthropic/SKILL.md': skillMd('anthropic'),
      'skills/other/SKILL.md': skillMd('other'),
    });
    expect(diagnostics.map((d) => [d.rule, d.path])).toEqual([['SKILL-COLLISION', 'skills/anthropic/SKILL.md']]);
  });

  it('a first-party skill named like an Object.prototype member is not a collision', async () => {
    const { library, diagnostics } = await resolve({
      'sources.yaml': SOURCES_YAML,
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['constructor']),
      'skills/constructor/SKILL.md': skillMd('constructor'),
    });
    expect(diagnostics).toEqual([]);
    expect(Object.keys(library.packs[0]!.skills)).toEqual(['constructor']);
  });

  it('a bare reference that names no first-party skill is unresolved even for Object.prototype names', async () => {
    const { library, diagnostics } = await resolve({
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['constructor']),
    });
    expect(diagnostics.map((d) => [d.rule, d.message.split(' ')[0]])).toEqual([['SKILL-UNRESOLVED', '"constructor"']]);
    expect(Object.keys(library.packs[0]!.skills)).toEqual([]);
  });

  it('references with a slash are skipped here: no diagnostics, nothing in pack.skills', async () => {
    const { library, diagnostics } = await resolve({
      'sources.yaml': SOURCES_YAML,
      'packs/web/pack.yaml': packYaml('web'),
      ...agent('web', 'frontend', ['anthropic/frontend-design', 'react']),
      'skills/react/SKILL.md': skillMd('react'),
    });
    expect(diagnostics).toEqual([]);
    expect(Object.keys(library.packs[0]!.skills)).toEqual(['react']);
  });
});
