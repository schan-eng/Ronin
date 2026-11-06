import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/load.js';
import { makeProject } from '../helpers/fs.js';
import type { ProjectFile } from '../helpers/fs.js';

const RONIN_YAML = 'marketplace:\n  name: ronin\n  owner:\n    name: t\n';
const REACT_SKILL = 'skills/react/SKILL.md';

/** A SKILL.md: one `key: value` frontmatter line per field, then the body. */
function skillMd(fields: Record<string, string>, body = 'Use React well.\n'): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** Loads a project with `ronin.yaml` plus `files`. */
async function load(files: Record<string, ProjectFile>) {
  return loadProject(await makeProject({ 'ronin.yaml': RONIN_YAML, ...files }));
}

describe('loadProject: first-party skills', () => {
  it('loads skills/react/SKILL.md with passthrough frontmatter', async () => {
    const { project, diagnostics } = await load({
      [REACT_SKILL]: skillMd({ name: 'react', description: 'React patterns.', license: 'MIT' }),
    });
    expect(diagnostics).toEqual([]);
    expect(project.firstPartySkills).toEqual({
      react: {
        name: 'react',
        dir: 'skills/react',
        description: 'React patterns.',
        frontmatter: { name: 'react', description: 'React patterns.', license: 'MIT' },
      },
    });
  });

  it('keeps unknown frontmatter values verbatim, nested ones included', async () => {
    const { project, diagnostics } = await load({
      [REACT_SKILL]: [
        '---',
        'name: react',
        'description: React patterns.',
        'allowed-tools: [Read, Grep]',
        'metadata:',
        '  author: someone',
        '  tags: [ui, web]',
        '---',
        'Body.',
        '',
      ].join('\n'),
    });
    expect(diagnostics).toEqual([]);
    expect(project.firstPartySkills['react']!.frontmatter).toEqual({
      name: 'react',
      description: 'React patterns.',
      'allowed-tools': ['Read', 'Grep'],
      metadata: { author: 'someone', tags: ['ui', 'web'] },
    });
  });

  it('loads every skill directory, in name order, ignoring supporting files', async () => {
    const { project, diagnostics } = await load({
      'skills/vue/SKILL.md': skillMd({ name: 'vue', description: 'Vue.' }),
      'skills/vue/references/guide.md': 'A guide.\n',
      [REACT_SKILL]: skillMd({ name: 'react', description: 'React.' }),
      'skills/README.md': 'Not a skill.\n',
    });
    expect(diagnostics).toEqual([]);
    expect(Object.keys(project.firstPartySkills)).toEqual(['react', 'vue']);
    expect(project.firstPartySkills['vue']!.dir).toBe('skills/vue');
  });

  it('a skill directory without SKILL.md is ignored silently', async () => {
    const { project, diagnostics } = await load({
      'skills/notes/README.md': 'Just notes.\n',
      'skills/empty/sub/file.txt': 'x\n',
      [REACT_SKILL]: skillMd({ name: 'react', description: 'React.' }),
    });
    expect(diagnostics).toEqual([]);
    expect(Object.keys(project.firstPartySkills)).toEqual(['react']);
  });

  it('missing skills/ means no first-party skills', async () => {
    const { project, diagnostics } = await load({});
    expect(diagnostics).toEqual([]);
    expect(project.firstPartySkills).toEqual({});
  });

  it('parses a SKILL.md with CRLF line endings and a BOM like an LF one', async () => {
    const text = skillMd({ name: 'react', description: 'React.', license: 'MIT' }).replace(/\n/g, '\r\n');
    const { project, diagnostics } = await load({ [REACT_SKILL]: `﻿${text}` });
    expect(diagnostics).toEqual([]);
    expect(project.firstPartySkills['react']!.description).toBe('React.');
  });

  it('a skill named like an Object.prototype member is an own entry, and absent ones are not', async () => {
    const { project, diagnostics } = await load({
      'skills/constructor/SKILL.md': skillMd({ name: 'constructor', description: 'Odd name.' }),
    });
    expect(diagnostics).toEqual([]);
    expect(Object.hasOwn(project.firstPartySkills, 'constructor')).toBe(true);
    expect(Object.hasOwn(project.firstPartySkills, 'toString')).toBe(false);
  });

  describe('NAME', () => {
    it('name that differs from the directory is a NAME error, and the skill is left out', async () => {
      const { project, diagnostics } = await load({
        [REACT_SKILL]: skillMd({ name: 'preact', description: 'React.' }),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: REACT_SKILL, line: 2, severity: 'error', rule: 'NAME' });
      expect(diagnostics[0]!.message).toContain('"preact"');
      expect(diagnostics[0]!.message).toContain('"react"');
      expect(project.firstPartySkills).toEqual({});
    });

    it('a directory and name that are both invalid report one NAME error, and the skill is left out', async () => {
      const { project, diagnostics } = await load({
        'skills/React/SKILL.md': skillMd({ name: 'React', description: 'React.' }),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'skills/React/SKILL.md', line: 2, severity: 'error', rule: 'NAME' });
      expect(project.firstPartySkills).toEqual({});
    });

    it('a name mismatch is still reported when the skill also has a schema error', async () => {
      const { project, diagnostics } = await load({ [REACT_SKILL]: skillMd({ name: 'preact' }) });
      expect(diagnostics.map((d) => [d.rule, d.path])).toEqual([
        ['SCHEMA', REACT_SKILL],
        ['NAME', REACT_SKILL],
      ]);
      expect(project.firstPartySkills).toEqual({});
    });

    it('one bad skill does not stop the others from loading', async () => {
      const { project, diagnostics } = await load({
        [REACT_SKILL]: skillMd({ name: 'preact', description: 'React.' }),
        'skills/vue/SKILL.md': skillMd({ name: 'vue', description: 'Vue.' }),
      });
      expect(diagnostics.map((d) => d.rule)).toEqual(['NAME']);
      expect(Object.keys(project.firstPartySkills)).toEqual(['vue']);
    });
  });

  describe('SCHEMA', () => {
    it('missing description is a SCHEMA error, and the skill is left out', async () => {
      const { project, diagnostics } = await load({ [REACT_SKILL]: skillMd({ name: 'react', license: 'MIT' }) });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: REACT_SKILL, severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('description');
      expect(project.firstPartySkills).toEqual({});
    });

    it('a blank or non-string description is a SCHEMA error at its line', async () => {
      for (const description of ['""', '"   "', '[a, b]', '42']) {
        const { project, diagnostics } = await load({ [REACT_SKILL]: skillMd({ name: 'react', description }) });
        expect(diagnostics, description).toHaveLength(1);
        expect(diagnostics[0], description).toMatchObject({ path: REACT_SKILL, line: 3, rule: 'SCHEMA' });
        expect(project.firstPartySkills, description).toEqual({});
      }
    });

    it('missing name is a SCHEMA error, and the skill is left out', async () => {
      const { project, diagnostics } = await load({ [REACT_SKILL]: skillMd({ description: 'React.' }) });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: REACT_SKILL, severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('name');
      expect(project.firstPartySkills).toEqual({});
    });

    it('a non-string name is a SCHEMA error, with no NAME error as well', async () => {
      const { project, diagnostics } = await load({ [REACT_SKILL]: skillMd({ name: '42', description: 'React.' }) });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: REACT_SKILL, line: 2, rule: 'SCHEMA' });
      expect(project.firstPartySkills).toEqual({});
    });

    it('a SKILL.md without frontmatter is a SCHEMA error at line 1', async () => {
      const { project, diagnostics } = await load({ [REACT_SKILL]: '# React\n\nNo frontmatter here.\n' });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: REACT_SKILL, line: 1, severity: 'error', rule: 'SCHEMA' });
      expect(project.firstPartySkills).toEqual({});
    });

    it('malformed frontmatter YAML is a SCHEMA error, and the skill is left out', async () => {
      const { project, diagnostics } = await load({
        [REACT_SKILL]: '---\nname: react\ndescription: [unclosed\n---\nBody.\n',
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: REACT_SKILL, severity: 'error', rule: 'SCHEMA' });
      expect(project.firstPartySkills).toEqual({});
    });

    it('a symbolic link under skills/ is rejected, not followed', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        [REACT_SKILL]: skillMd({ name: 'react', description: 'React.' }),
        'elsewhere/SKILL.md': skillMd({ name: 'linked', description: 'Outside.' }),
      });
      await symlink(path.join(root, 'elsewhere'), path.join(root, 'skills/linked'));
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics.map((d) => [d.path, d.rule])).toEqual([['skills/linked', 'SCHEMA']]);
      expect(diagnostics[0]!.message).toMatch(/symbolic link/);
      expect(Object.keys(project.firstPartySkills)).toEqual(['react']);
    });

    it('a SKILL.md that is a symbolic link is rejected, not read', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'skills/vue/references/guide.md': 'A guide.\n',
        'elsewhere/outside.md': skillMd({ name: 'vue', description: 'Outside.' }),
      });
      await symlink(path.join(root, 'elsewhere/outside.md'), path.join(root, 'skills/vue/SKILL.md'));
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'skills/vue/SKILL.md', severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toMatch(/symbolic link/);
      expect(project.firstPartySkills).toEqual({});
    });
  });
});
