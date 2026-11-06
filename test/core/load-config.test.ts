import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/load.js';
import { NAME_RE, NEUTRAL_TOOLS } from '../../src/core/model.js';
import { enc, makeProject } from '../helpers/fs.js';

const RONIN_YAML = 'marketplace:\n  name: ronin\n  owner:\n    name: t\n';
const SOURCES_YAML = 'sources:\n  upstream:\n    repo: https://x/y.git\n    ref: main\n';

describe('model constants', () => {
  it('NAME_RE accepts lowercase kebab names up to 64 characters', () => {
    expect(NAME_RE.test('web')).toBe(true);
    expect(NAME_RE.test('a')).toBe(true);
    expect(NAME_RE.test('0-react-patterns')).toBe(true);
    expect(NAME_RE.test('a'.repeat(64))).toBe(true);
  });

  it('NAME_RE rejects everything else', () => {
    for (const bad of ['', 'Up_Stream', '-a', 'a_b', 'A', 'a b', 'a/b', 'a'.repeat(65), 'a\n']) {
      expect(NAME_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('NEUTRAL_TOOLS is the closed vocabulary', () => {
    expect([...NEUTRAL_TOOLS]).toEqual(['read', 'write', 'edit', 'search', 'shell', 'web-fetch', 'web-search']);
  });
});

describe('loadProject: ronin.yaml and sources.yaml', () => {
  it('loads marketplace and sources with defaults', async () => {
    const root = await makeProject({
      'ronin.yaml': RONIN_YAML,
      'sources.yaml': SOURCES_YAML,
    });
    const { project, diagnostics } = await loadProject(root);
    expect(diagnostics).toEqual([]);
    expect(project.root).toBe(root);
    expect(project.marketplace).toEqual({ name: 'ronin', owner: { name: 't' } });
    expect(project.sources).toEqual({
      upstream: { name: 'upstream', repo: 'https://x/y.git', ref: 'main', root: '.', licenses: {} },
    });
    expect(project.packs).toEqual([]);
    expect(project.firstPartySkills).toEqual({});
  });

  it('passes through the optional marketplace fields and explicit source fields', async () => {
    const root = await makeProject({
      'ronin.yaml': [
        'marketplace:',
        '  name: ronin',
        '  description: Specialist agents.',
        '  owner:',
        '    name: t',
        '    email: t@example.com',
        '    url: https://example.com',
        '',
      ].join('\n'),
      'sources.yaml': [
        'sources:',
        '  anthropic:',
        '    repo: https://github.com/anthropics/skills.git',
        '    ref: main',
        '    root: skills',
        '    licenses:',
        '      some-skill:',
        '        spdx: MIT',
        '        reason: Stated in the upstream README.',
        '',
      ].join('\n'),
    });
    const { project, diagnostics } = await loadProject(root);
    expect(diagnostics).toEqual([]);
    expect(project.marketplace).toEqual({
      name: 'ronin',
      description: 'Specialist agents.',
      owner: { name: 't', email: 't@example.com', url: 'https://example.com' },
    });
    expect(project.sources.anthropic).toEqual({
      name: 'anthropic',
      repo: 'https://github.com/anthropics/skills.git',
      ref: 'main',
      root: 'skills',
      licenses: { 'some-skill': { spdx: 'MIT', reason: 'Stated in the upstream README.' } },
    });
  });

  it('keeps sources in file order', async () => {
    const root = await makeProject({
      'ronin.yaml': RONIN_YAML,
      'sources.yaml': 'sources:\n  zeta:\n    repo: r\n    ref: a\n  alpha:\n    repo: r\n    ref: b\n',
    });
    const { project } = await loadProject(root);
    expect(Object.keys(project.sources)).toEqual(['zeta', 'alpha']);
  });

  it('parses files with a UTF-8 BOM and CRLF line endings', async () => {
    const root = await makeProject({
      'ronin.yaml': { content: enc('﻿' + RONIN_YAML.replace(/\n/g, '\r\n')) },
      'sources.yaml': { content: enc(SOURCES_YAML.replace(/\n/g, '\r\n')) },
    });
    const { project, diagnostics } = await loadProject(root);
    expect(diagnostics).toEqual([]);
    expect(project.marketplace.name).toBe('ronin');
    expect(Object.keys(project.sources)).toEqual(['upstream']);
  });

  describe('missing files', () => {
    it('missing ronin.yaml is a SCHEMA error at ronin.yaml, with a placeholder marketplace', async () => {
      const root = await makeProject({ 'sources.yaml': SOURCES_YAML });
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.yaml', severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.line).toBeUndefined();
      expect(diagnostics[0]!.message).toMatch(/ronin\.yaml/);
      expect(project.marketplace).toEqual({ name: '', owner: { name: '' } });
      expect(Object.keys(project.sources)).toEqual(['upstream']);
    });

    it('missing sources.yaml means no sources', async () => {
      const root = await makeProject({ 'ronin.yaml': RONIN_YAML });
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics).toEqual([]);
      expect(project.sources).toEqual({});
    });
  });

  describe('ronin.yaml errors', () => {
    it('unknown key under marketplace is a SCHEMA error at that key', async () => {
      const root = await makeProject({
        'ronin.yaml': 'marketplace:\n  name: ronin\n  owner:\n    name: t\n  extra: 1\n',
      });
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.yaml', line: 5, severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('extra');
      expect(project.marketplace).toEqual({ name: '', owner: { name: '' } });
    });

    it('unknown top-level key is a SCHEMA error at that key', async () => {
      const root = await makeProject({ 'ronin.yaml': RONIN_YAML + 'plugins: []\n' });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.yaml', line: 5, rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('plugins');
    });

    it('reports every unknown key, each at its own line', async () => {
      const root = await makeProject({
        'ronin.yaml': 'marketplace:\n  name: ronin\n  owner:\n    name: t\n  one: 1\n  two: 2\n',
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics.map((d) => [d.line, d.rule])).toEqual([
        [5, 'SCHEMA'],
        [6, 'SCHEMA'],
      ]);
      expect(diagnostics[0]!.message).toContain('one');
      expect(diagnostics[1]!.message).toContain('two');
    });

    it('a missing nested field is reported at the enclosing key', async () => {
      const root = await makeProject({ 'ronin.yaml': 'marketplace:\n  name: ronin\n' });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.yaml', line: 1, rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('marketplace.owner');
    });

    it('a wrong type is reported at the offending key', async () => {
      const root = await makeProject({
        'ronin.yaml': 'marketplace:\n  name: 42\n  owner:\n    name: t\n',
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.yaml', line: 2, rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('marketplace.name');
    });

    it('an empty marketplace name is a SCHEMA error', async () => {
      const root = await makeProject({
        'ronin.yaml': 'marketplace:\n  name: ""\n  owner:\n    name: t\n',
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.yaml', line: 2, rule: 'SCHEMA' });
    });

    it('an empty file is a SCHEMA error without a line', async () => {
      const root = await makeProject({ 'ronin.yaml': '' });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.yaml', rule: 'SCHEMA' });
      expect(diagnostics[0]!.line).toBeUndefined();
    });

    it('malformed YAML is a SCHEMA error at the parse error line', async () => {
      const root = await makeProject({
        'ronin.yaml': 'marketplace:\n  name: ronin\n  owner: {name: t\n',
      });
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'ronin.yaml', line: 4, severity: 'error', rule: 'SCHEMA' });
      expect(project.marketplace).toEqual({ name: '', owner: { name: '' } });
    });
  });

  describe('sources.yaml errors', () => {
    it('an empty license reason is a SCHEMA error at the reason', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': [
          'sources:',
          '  upstream:',
          '    repo: https://x/y.git',
          '    ref: main',
          '    licenses:',
          '      some-skill:',
          '        spdx: MIT',
          '        reason: ""',
          '',
        ].join('\n'),
      });
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 8, severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('reason');
      expect(project.sources).toEqual({});
    });

    it('a whitespace-only license reason is a SCHEMA error too', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': [
          'sources:',
          '  upstream:',
          '    repo: https://x/y.git',
          '    ref: main',
          '    licenses:',
          '      some-skill: { spdx: MIT, reason: "   " }',
          '',
        ].join('\n'),
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 6, rule: 'SCHEMA' });
    });

    it('a missing license reason is a SCHEMA error at the license entry', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': [
          'sources:',
          '  upstream:',
          '    repo: https://x/y.git',
          '    ref: main',
          '    licenses:',
          '      some-skill:',
          '        spdx: MIT',
          '',
        ].join('\n'),
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 6, rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('reason');
    });

    it('an unknown key in a source is a SCHEMA error at that key', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': SOURCES_YAML + '    branch: dev\n',
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 5, rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('branch');
    });

    it('a missing repo is a SCHEMA error at the source', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': 'sources:\n  upstream:\n    ref: main\n',
      });
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 2, rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('repo');
      expect(project.sources).toEqual({});
    });

    it('a ref that YAML reads as a number is a SCHEMA error', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': 'sources:\n  upstream:\n    repo: https://x/y.git\n    ref: 1.0\n',
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 4, rule: 'SCHEMA' });
    });

    it('an unknown top-level key is a SCHEMA error at that key', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': SOURCES_YAML + 'extra: 1\n',
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 5, rule: 'SCHEMA' });
    });

    it('a sources.yaml without a sources key is a SCHEMA error', async () => {
      const root = await makeProject({ 'ronin.yaml': RONIN_YAML, 'sources.yaml': '{}\n' });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('sources');
    });

    it('duplicate source names are a SCHEMA error from the YAML parser', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': SOURCES_YAML + '  upstream:\n    repo: https://x/z.git\n    ref: main\n',
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 5, rule: 'SCHEMA' });
    });

    it('malformed YAML is a SCHEMA error at the parse error line', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': 'sources:\n\tupstream: {}\n',
      });
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 2, rule: 'SCHEMA' });
      expect(project.sources).toEqual({});
    });

    it('bad source name "Up_Stream" is a NAME error, and that source is dropped', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': [
          'sources:',
          '  Up_Stream:',
          '    repo: https://x/y.git',
          '    ref: main',
          '  good:',
          '    repo: https://x/z.git',
          '    ref: main',
          '',
        ].join('\n'),
      });
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 2, severity: 'error', rule: 'NAME' });
      expect(diagnostics[0]!.message).toContain('Up_Stream');
      expect(Object.keys(project.sources)).toEqual(['good']);
    });

    it('a bad source name is still reported when the file also has schema errors', async () => {
      const root = await makeProject({
        'ronin.yaml': RONIN_YAML,
        'sources.yaml': 'sources:\n  Up_Stream:\n    repo: https://x/y.git\n    ref: main\n  other:\n    ref: main\n',
      });
      const { diagnostics } = await loadProject(root);
      expect(diagnostics.map((d) => [d.rule, d.line])).toEqual([
        ['NAME', 2],
        ['SCHEMA', 5],
      ]);
    });
  });

  describe('sources.yaml root stays inside the source repository', () => {
    const withRoot = (root: string) => ({
      'ronin.yaml': RONIN_YAML,
      'sources.yaml': `sources:\n  upstream:\n    repo: https://x/y.git\n    ref: main\n    root: ${root}\n`,
    });

    it('root: ../x is a SCHEMA error at the root line, and the source is dropped', async () => {
      const { project, diagnostics } = await loadProject(await makeProject(withRoot('../x')));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 5, severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('root');
      expect(project.sources).toEqual({});
    });

    it('root: /etc is a SCHEMA error at the root line, and the source is dropped', async () => {
      const { project, diagnostics } = await loadProject(await makeProject(withRoot('/etc')));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'sources.yaml', line: 5, severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('root');
      expect(project.sources).toEqual({});
    });

    it('a .. segment anywhere, a backslash form, or a drive letter is rejected too', async () => {
      for (const root of ['..', 'skills/../..', 'a/../b', 'a\\..\\b', '\\etc', 'C:\\x', 'C:/x']) {
        const { diagnostics } = await loadProject(await makeProject(withRoot(JSON.stringify(root))));
        expect(diagnostics, root).toHaveLength(1);
        expect(diagnostics[0], root).toMatchObject({ path: 'sources.yaml', line: 5, rule: 'SCHEMA' });
      }
    });

    it('a root that is not a string is a plain SCHEMA error', async () => {
      for (const root of ['5', 'null', '[a]']) {
        const { diagnostics } = await loadProject(await makeProject(withRoot(root)));
        expect(diagnostics, root).toHaveLength(1);
        expect(diagnostics[0], root).toMatchObject({ path: 'sources.yaml', line: 5, rule: 'SCHEMA' });
      }
    });

    it('root: skills/sub is accepted', async () => {
      const { project, diagnostics } = await loadProject(await makeProject(withRoot('skills/sub')));
      expect(diagnostics).toEqual([]);
      expect(project.sources['upstream']!.root).toBe('skills/sub');
    });

    it('names that merely contain dots are accepted', async () => {
      for (const root of ['.', './skills', '..skills', 'skills..', 'a/..b/c']) {
        const { project, diagnostics } = await loadProject(await makeProject(withRoot(JSON.stringify(root))));
        expect(diagnostics, root).toEqual([]);
        expect(project.sources['upstream']!.root).toBe(root);
      }
    });
  });

  it('reports problems in both files in one run', async () => {
    const root = await makeProject({
      'ronin.yaml': 'marketplace:\n  name: ronin\n',
      'sources.yaml': 'sources:\n  upstream:\n    ref: main\n',
    });
    const { diagnostics } = await loadProject(root);
    expect(diagnostics.map((d) => d.path).sort()).toEqual(['ronin.yaml', 'sources.yaml']);
    expect(diagnostics.every((d) => d.severity === 'error' && d.rule === 'SCHEMA')).toBe(true);
  });
});
