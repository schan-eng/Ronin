import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../src/core/load.js';
import { enc, makeProject } from '../helpers/fs.js';
import type { ProjectFile } from '../helpers/fs.js';

const RONIN_YAML = 'marketplace:\n  name: ronin\n  owner:\n    name: t\n';
const PACK_YAML = 'name: web\nversion: 0.1.0\ndescription: Web.\n';
const AGENT_FILE = 'packs/web/agents/frontend.md';

const BASE_FIELDS: Record<string, string> = {
  name: 'frontend',
  description: 'UI work.',
  skills: '[react]',
  tools: '[read, shell]',
  model: 'strong',
};

/** An agent file: one `key: value` frontmatter line per field, then the body. */
function agentMd(fields: Record<string, string> = BASE_FIELDS, body = 'You build UI.\n'): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

const base: Record<string, ProjectFile> = {
  'ronin.yaml': RONIN_YAML,
  'packs/web/pack.yaml': PACK_YAML,
  [AGENT_FILE]: agentMd(),
};

/** Loads the base project with `changes` applied; a `null` value removes that file. */
async function load(changes: Record<string, ProjectFile | null> = {}) {
  const files: Record<string, ProjectFile> = { ...base };
  for (const [rel, spec] of Object.entries(changes)) {
    if (spec === null) delete files[rel];
    else files[rel] = spec;
  }
  return loadProject(await makeProject(files));
}

/** Loads the base project with one agent field replaced, added (`value`), or removed (`null`). */
function loadWithField(key: string, value: string | null, body?: string) {
  const fields = { ...BASE_FIELDS };
  if (value === null) delete fields[key];
  else fields[key] = value;
  return load({ [AGENT_FILE]: agentMd(fields, body) });
}

describe('loadProject: packs and agents', () => {
  it('valid pack loads clean', async () => {
    const { project, diagnostics } = await load();
    expect(diagnostics).toEqual([]);
    expect(project.packs).toEqual([
      {
        name: 'web',
        version: '0.1.0',
        description: 'Web.',
        agents: [
          {
            pack: 'web',
            name: 'frontend',
            file: 'packs/web/agents/frontend.md',
            description: 'UI work.',
            skills: ['react'],
            tools: ['read', 'shell'],
            model: 'strong',
            targets: {},
            body: 'You build UI.\n',
          },
        ],
      },
    ]);
  });

  it('optional agent fields default: no skills, no targets, tools and model left unset', async () => {
    const { project, diagnostics } = await load({
      [AGENT_FILE]: agentMd({ name: 'frontend', description: 'UI work.' }),
    });
    expect(diagnostics).toEqual([]);
    const agent = project.packs[0]!.agents[0]!;
    expect(agent.skills).toEqual([]);
    expect(agent.targets).toEqual({});
    expect(Object.hasOwn(agent, 'tools')).toBe(false);
    expect(Object.hasOwn(agent, 'model')).toBe(false);
  });

  it('keeps targets as written and an explicit empty tools list', async () => {
    const { project, diagnostics } = await load({
      [AGENT_FILE]: [
        '---',
        'name: frontend',
        'description: UI work.',
        'tools: []',
        'targets:',
        '  claude-code: { isolation: worktree }',
        '  other: {}',
        '---',
        'Body.',
        '',
      ].join('\n'),
    });
    expect(diagnostics).toEqual([]);
    const agent = project.packs[0]!.agents[0]!;
    expect(agent.tools).toEqual([]);
    expect(agent.targets).toEqual({ 'claude-code': { isolation: 'worktree' }, other: {} });
  });

  it('accepts every neutral tool and source-qualified skill references', async () => {
    const { project, diagnostics } = await load({
      [AGENT_FILE]: agentMd({
        name: 'frontend',
        description: 'UI work.',
        skills: '[react, anthropic/frontend-design]',
        tools: '[read, write, edit, search, shell, web-fetch, web-search]',
        model: 'fast',
      }),
    });
    expect(diagnostics).toEqual([]);
    const agent = project.packs[0]!.agents[0]!;
    expect(agent.skills).toEqual(['react', 'anthropic/frontend-design']);
    expect(agent.tools).toEqual(['read', 'write', 'edit', 'search', 'shell', 'web-fetch', 'web-search']);
    expect(agent.model).toBe('fast');
  });

  it('accepts the other model tiers', async () => {
    for (const model of ['fast', 'balanced', 'strong']) {
      const { project, diagnostics } = await loadWithField('model', model);
      expect(diagnostics, model).toEqual([]);
      expect(project.packs[0]!.agents[0]!.model).toBe(model);
    }
  });

  it('missing packs/ means no packs', async () => {
    const { project, diagnostics } = await load({ 'packs/web/pack.yaml': null, [AGENT_FILE]: null });
    expect(diagnostics).toEqual([]);
    expect(project.packs).toEqual([]);
  });

  it('a pack with no agents folder has no agents', async () => {
    const { project, diagnostics } = await load({ [AGENT_FILE]: null });
    expect(diagnostics).toEqual([]);
    expect(project.packs).toEqual([{ name: 'web', version: '0.1.0', description: 'Web.', agents: [] }]);
  });

  it('lists packs and agents in plain string order, whatever order they were written', async () => {
    const { project, diagnostics } = await load({
      'packs/zeta/pack.yaml': 'name: zeta\nversion: 1.2.3\ndescription: Z.\n',
      'packs/zeta/agents/b.md': agentMd({ name: 'b', description: 'B.' }),
      'packs/zeta/agents/a.md': agentMd({ name: 'a', description: 'A.' }),
      'packs/alpha/pack.yaml': 'name: alpha\nversion: 1.2.3\ndescription: A.\n',
      'packs/alpha/agents/z.md': agentMd({ name: 'z', description: 'Z.' }),
    });
    expect(diagnostics).toEqual([]);
    expect(project.packs.map((p) => p.name)).toEqual(['alpha', 'web', 'zeta']);
    expect(project.packs[2]!.agents.map((a) => a.name)).toEqual(['a', 'b']);
  });

  it('only *.md files directly inside agents/ are agents', async () => {
    const { project, diagnostics } = await load({
      'packs/web/agents/notes.txt': 'not an agent',
      'packs/web/agents/nested/deep.md': agentMd({ name: 'deep', description: 'Deep.' }),
      'packs/web/README.md': 'readme',
      'packs/README.md': 'a stray file among the packs',
      'packs/.DS_Store': 'junk',
    });
    expect(diagnostics).toEqual([]);
    expect(project.packs.map((p) => p.agents.map((a) => a.name))).toEqual([['frontend']]);
  });

  it('parses agent files with a UTF-8 BOM and CRLF line endings, with correct lines', async () => {
    const crlf = '﻿' + agentMd({ ...BASE_FIELDS, colour: 'red' }).replace(/\n/g, '\r\n');
    const { project, diagnostics } = await load({ [AGENT_FILE]: { content: enc(crlf) } });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ rule: 'SCHEMA', line: 7 });
    expect(project.packs[0]!.agents).toEqual([]);

    const ok = await load({ [AGENT_FILE]: { content: enc('﻿' + agentMd().replace(/\n/g, '\r\n')) } });
    expect(ok.diagnostics).toEqual([]);
    expect(ok.project.packs[0]!.agents[0]!.name).toBe('frontend');
  });

  it('names that match Object.prototype members are ordinary names', async () => {
    const { project, diagnostics } = await load({
      'packs/constructor/pack.yaml': 'name: constructor\nversion: 0.1.0\ndescription: C.\n',
      'packs/constructor/agents/constructor.md': agentMd({
        name: 'constructor',
        description: 'C.',
        skills: '[constructor, constructor/constructor]',
        targets: '{ constructor: {} }',
      }),
    });
    expect(diagnostics).toEqual([]);
    const pack = project.packs.find((p) => p.name === 'constructor')!;
    expect(pack.agents[0]!.skills).toEqual(['constructor', 'constructor/constructor']);
  });

  describe('SCHEMA', () => {
    it('unknown agent key is a SCHEMA error at that key, and the agent is left out', async () => {
      const { project, diagnostics } = await load({
        [AGENT_FILE]: agentMd({ name: 'frontend', description: 'UI work.', colour: 'red' }),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: AGENT_FILE, line: 4, severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('colour');
      expect(project.packs[0]!.agents).toEqual([]);
    });

    it('a missing agent name or description is a SCHEMA error', async () => {
      for (const field of ['name', 'description']) {
        const { project, diagnostics } = await loadWithField(field, null);
        expect(diagnostics, field).toHaveLength(1);
        expect(diagnostics[0], field).toMatchObject({ path: AGENT_FILE, rule: 'SCHEMA' });
        expect(diagnostics[0]!.message).toContain(field);
        expect(project.packs[0]!.agents, field).toEqual([]);
      }
    });

    it('model: huge is a SCHEMA error at the model line', async () => {
      const { project, diagnostics } = await loadWithField('model', 'huge');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: AGENT_FILE, line: 6, severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.message).toContain('model');
      expect(project.packs[0]!.agents).toEqual([]);
    });

    it('targets must be a map of objects', async () => {
      const cases: [string, number][] = [
        ['[claude-code]', 7],
        ['just-text', 7],
        ['{ claude-code: 3 }', 7],
        ['{ claude-code: [a] }', 7],
        ['{ claude-code: null }', 7],
      ];
      for (const [value, line] of cases) {
        const { project, diagnostics } = await loadWithField('targets', value);
        expect(diagnostics, value).toHaveLength(1);
        expect(diagnostics[0], value).toMatchObject({ path: AGENT_FILE, line, severity: 'error', rule: 'SCHEMA' });
        expect(diagnostics[0]!.message).toContain('targets');
        expect(project.packs[0]!.agents, value).toEqual([]);
      }
    });

    it('non-string entries in skills or tools are SCHEMA errors at the entry', async () => {
      const skills = await loadWithField('skills', '\n  - react\n  - 5');
      expect(skills.diagnostics).toHaveLength(1);
      expect(skills.diagnostics[0]).toMatchObject({ path: AGENT_FILE, line: 6, rule: 'SCHEMA' });
      expect(skills.project.packs[0]!.agents).toEqual([]);

      const tools = await loadWithField('tools', 'read');
      expect(tools.diagnostics).toHaveLength(1);
      expect(tools.diagnostics[0]).toMatchObject({ path: AGENT_FILE, line: 5, rule: 'SCHEMA' });
    });

    it('TOOL is still reported when the agent also has a SCHEMA error', async () => {
      const { diagnostics } = await load({
        [AGENT_FILE]: agentMd({ name: 'frontend', description: 'UI.', tools: '[fly]', colour: 'red' }),
      });
      expect(diagnostics.map((d) => [d.rule, d.line])).toEqual(
        expect.arrayContaining([
          ['SCHEMA', 5],
          ['TOOL', 4],
        ]),
      );
      expect(diagnostics).toHaveLength(2);
    });

    it('an empty or whitespace-only body is a SCHEMA error, and the agent is left out', async () => {
      for (const body of ['', '\n', '  \n\n\t\n']) {
        const { project, diagnostics } = await loadWithField('model', 'strong', body);
        expect(diagnostics, JSON.stringify(body)).toHaveLength(1);
        expect(diagnostics[0], JSON.stringify(body)).toMatchObject({ path: AGENT_FILE, severity: 'error', rule: 'SCHEMA' });
        expect(diagnostics[0]!.message).toContain('body');
        expect(project.packs[0]!.agents).toEqual([]);
      }
    });

    it('a file without frontmatter is a SCHEMA error at line 1', async () => {
      const { project, diagnostics } = await load({ [AGENT_FILE]: 'You build UI.\n' });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: AGENT_FILE, line: 1, severity: 'error', rule: 'SCHEMA' });
      expect(project.packs[0]!.agents).toEqual([]);
    });

    it('malformed frontmatter YAML is a SCHEMA error at the parse error line', async () => {
      const { diagnostics } = await load({ [AGENT_FILE]: '---\nname: frontend\ntools: [read\n---\nBody.\n' });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: AGENT_FILE, severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.line).toBeGreaterThanOrEqual(2);
    });

    it('pack.yaml: version "1.0" and a numeric 1.0 are SCHEMA errors at the version line', async () => {
      for (const version of ['1.0', '"1.0"', '1.0.0.0', 'v1.0.0', '"1.0.0-beta"', '""']) {
        const { project, diagnostics } = await load({
          'packs/web/pack.yaml': `name: web\nversion: ${version}\ndescription: Web.\n`,
        });
        expect(diagnostics, version).toHaveLength(1);
        expect(diagnostics[0], version).toMatchObject({ path: 'packs/web/pack.yaml', line: 2, severity: 'error', rule: 'SCHEMA' });
        expect(diagnostics[0]!.message).toContain('version');
        expect(project.packs, version).toEqual([]);
      }
    });

    it('pack.yaml: missing description, blank description, and unknown keys are SCHEMA errors', async () => {
      const missing = await load({ 'packs/web/pack.yaml': 'name: web\nversion: 0.1.0\n' });
      expect(missing.diagnostics).toHaveLength(1);
      expect(missing.diagnostics[0]).toMatchObject({ path: 'packs/web/pack.yaml', rule: 'SCHEMA' });
      expect(missing.diagnostics[0]!.message).toContain('description');
      expect(missing.project.packs).toEqual([]);

      const blank = await load({ 'packs/web/pack.yaml': 'name: web\nversion: 0.1.0\ndescription: "  "\n' });
      expect(blank.diagnostics).toHaveLength(1);
      expect(blank.diagnostics[0]).toMatchObject({ path: 'packs/web/pack.yaml', line: 3, rule: 'SCHEMA' });

      const extra = await load({ 'packs/web/pack.yaml': PACK_YAML + 'agents: [frontend]\n' });
      expect(extra.diagnostics).toHaveLength(1);
      expect(extra.diagnostics[0]).toMatchObject({ path: 'packs/web/pack.yaml', line: 4, rule: 'SCHEMA' });
      expect(extra.diagnostics[0]!.message).toContain('agents');
      expect(extra.project.packs).toEqual([]);
    });

    it('a pack directory without pack.yaml is a SCHEMA error, and its agents are still checked', async () => {
      const { project, diagnostics } = await load({
        'packs/web/pack.yaml': null,
        [AGENT_FILE]: agentMd({ name: 'frontend', description: 'UI.', colour: 'red' }),
      });
      expect(diagnostics.map((d) => [d.path, d.rule])).toEqual([
        ['packs/web/pack.yaml', 'SCHEMA'],
        [AGENT_FILE, 'SCHEMA'],
      ]);
      expect(project.packs).toEqual([]);
    });

    it('malformed pack.yaml is a SCHEMA error at the parse error line', async () => {
      const { project, diagnostics } = await load({ 'packs/web/pack.yaml': 'name: web\nversion: [0.1.0\n' });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'packs/web/pack.yaml', severity: 'error', rule: 'SCHEMA' });
      expect(diagnostics[0]!.line).toBeDefined();
      expect(project.packs).toEqual([]);
    });

    it('symbolic links under packs/ or agents/ are rejected, not followed', async () => {
      const root = await makeProject({
        ...base,
        'elsewhere/outside.md': agentMd({ name: 'outside', description: 'Outside.' }),
      });
      await symlink(path.join(root, 'elsewhere/outside.md'), path.join(root, 'packs/web/agents/outside.md'));
      await symlink(path.join(root, 'elsewhere'), path.join(root, 'packs/linked'));
      const { project, diagnostics } = await loadProject(root);
      expect(diagnostics.map((d) => [d.path, d.rule]).sort()).toEqual([
        ['packs/linked', 'SCHEMA'],
        ['packs/web/agents/outside.md', 'SCHEMA'],
      ]);
      expect(diagnostics.every((d) => /symbolic link/.test(d.message))).toBe(true);
      expect(project.packs.map((p) => [p.name, p.agents.map((a) => a.name)])).toEqual([['web', ['frontend']]]);
    });
  });

  describe('NAME', () => {
    it('a file named Frontend.md is a NAME error, and the agent is left out', async () => {
      const { project, diagnostics } = await load({
        [AGENT_FILE]: null,
        'packs/web/agents/Frontend.md': agentMd({ name: 'Frontend', description: 'UI.' }),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        path: 'packs/web/agents/Frontend.md',
        line: 2,
        severity: 'error',
        rule: 'NAME',
      });
      expect(diagnostics[0]!.message).toContain('Frontend');
      expect(project.packs[0]!.agents).toEqual([]);
    });

    it('an agent name that differs from the file name is a NAME error at the name line', async () => {
      const { project, diagnostics } = await loadWithField('name', 'backend');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: AGENT_FILE, line: 2, severity: 'error', rule: 'NAME' });
      expect(diagnostics[0]!.message).toContain('backend');
      expect(diagnostics[0]!.message).toContain('frontend');
      expect(project.packs[0]!.agents).toEqual([]);
    });

    it('a valid-looking name in an invalid file name is still a NAME error', async () => {
      const { diagnostics } = await load({
        [AGENT_FILE]: null,
        'packs/web/agents/Frontend.md': agentMd({ name: 'frontend', description: 'UI.' }),
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'packs/web/agents/Frontend.md', line: 2, rule: 'NAME' });
    });

    it('pack.yaml name that differs from the directory is a NAME error at the name line, and the pack is left out', async () => {
      const { project, diagnostics } = await load({ 'packs/web/pack.yaml': 'name: other\nversion: 0.1.0\ndescription: Web.\n' });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'packs/web/pack.yaml', line: 1, severity: 'error', rule: 'NAME' });
      expect(diagnostics[0]!.message).toContain('other');
      expect(diagnostics[0]!.message).toContain('web');
      expect(project.packs).toEqual([]);
    });

    it('a pack directory with an invalid name is a NAME error', async () => {
      const { project, diagnostics } = await load({
        'packs/Web_Pack/pack.yaml': 'name: Web_Pack\nversion: 0.1.0\ndescription: W.\n',
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: 'packs/Web_Pack/pack.yaml', line: 1, rule: 'NAME' });
      expect(project.packs.map((p) => p.name)).toEqual(['web']);
    });

    it('a NAME error does not hide the pack agents', async () => {
      const { project, diagnostics } = await load({
        'packs/web/pack.yaml': 'name: other\nversion: 0.1.0\ndescription: Web.\n',
        [AGENT_FILE]: agentMd({ name: 'frontend', description: '""' }),
      });
      expect(diagnostics.map((d) => [d.path, d.rule])).toEqual([
        ['packs/web/pack.yaml', 'NAME'],
        [AGENT_FILE, 'DESCRIPTION'],
      ]);
      expect(project.packs).toEqual([]);
    });

    it('Review Focus 5: traversal skill references are NAME errors, one per reference', async () => {
      const { project, diagnostics } = await loadWithField(
        'skills',
        '\n  - upstream/../x\n  - ../x\n  - a/b/c',
      );
      expect(diagnostics.map((d) => [d.rule, d.line])).toEqual([
        ['NAME', 5],
        ['NAME', 6],
        ['NAME', 7],
      ]);
      expect(diagnostics.every((d) => d.path === AGENT_FILE && d.severity === 'error')).toBe(true);
      expect(diagnostics[0]!.message).toContain('upstream/../x');
      expect(diagnostics[1]!.message).toContain('../x');
      expect(diagnostics[2]!.message).toContain('a/b/c');
      expect(project.packs[0]!.agents).toEqual([]);
    });

    it('other malformed skill references are NAME errors too', async () => {
      const refs = ['/abs', 'a/', '/', 'Up/x', 'a/B', 'a b', '.', '..', 'a\\b', '-a', 'a/b ', ''];
      for (const ref of refs) {
        // JSON strings are valid YAML flow scalars, so quoting with it keeps odd characters intact.
        const { diagnostics } = await loadWithField('skills', `[${JSON.stringify(ref)}]`);
        expect(diagnostics, JSON.stringify(ref)).toHaveLength(1);
        expect(diagnostics[0], JSON.stringify(ref)).toMatchObject({ path: AGENT_FILE, line: 4, rule: 'NAME' });
      }
    });
  });

  describe('rules that report without excluding the agent', () => {
    it('DUPLICATE skill reference is reported at the repeat', async () => {
      const { project, diagnostics } = await loadWithField('skills', '\n  - react\n  - up/x\n  - react');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: AGENT_FILE, line: 7, severity: 'error', rule: 'DUPLICATE' });
      expect(diagnostics[0]!.message).toContain('react');
      expect(project.packs[0]!.agents.map((a) => a.name)).toEqual(['frontend']);
    });

    it('DUPLICATE: react and up/react are different references', async () => {
      const { diagnostics } = await loadWithField('skills', '[react, up/react]');
      expect(diagnostics).toEqual([]);
    });

    it('DESCRIPTION: empty and 301 characters are errors, 1 and 300 are fine', async () => {
      for (const bad of ['""', "'  '", `"${'x'.repeat(301)}"`]) {
        const { project, diagnostics } = await loadWithField('description', bad);
        expect(diagnostics, bad).toHaveLength(1);
        expect(diagnostics[0], bad).toMatchObject({ path: AGENT_FILE, line: 3, severity: 'error', rule: 'DESCRIPTION' });
        expect(project.packs[0]!.agents.map((a) => a.name), bad).toEqual(['frontend']);
      }
      for (const good of ['x', 'x'.repeat(300)]) {
        const { project, diagnostics } = await loadWithField('description', good);
        expect(diagnostics, String(good.length)).toEqual([]);
        expect(project.packs[0]!.agents[0]!.description).toBe(good);
      }
    });

    it('DESCRIPTION counts characters, not UTF-16 code units', async () => {
      const ok = await loadWithField('description', '😀'.repeat(300));
      expect(ok.diagnostics).toEqual([]);
      const tooLong = await loadWithField('description', '😀'.repeat(301));
      expect(tooLong.diagnostics.map((d) => d.rule)).toEqual(['DESCRIPTION']);
    });

    it('TOOL: an unknown tool is an error naming it, at its own line', async () => {
      const { project, diagnostics } = await loadWithField('tools', '\n  - read\n  - fly\n  - Bash');
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]).toMatchObject({ path: AGENT_FILE, line: 7, severity: 'error', rule: 'TOOL' });
      expect(diagnostics[0]!.message).toContain('fly');
      expect(diagnostics[1]).toMatchObject({ line: 8, rule: 'TOOL' });
      expect(diagnostics[1]!.message).toContain('Bash');
      expect(project.packs[0]!.agents.map((a) => a.name)).toEqual(['frontend']);
      expect(project.packs[0]!.agents[0]!.tools).toEqual(['read']);
    });

    it('TOOL: the message for [read, fly] mentions "fly"', async () => {
      const { diagnostics } = await loadWithField('tools', '[read, fly]');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ rule: 'TOOL', line: 5 });
      expect(diagnostics[0]!.message).toContain('fly');
    });

    it('TOOL: names that match Object.prototype members are unknown tools', async () => {
      const { diagnostics } = await loadWithField('tools', '[constructor, toString, __proto__]');
      expect(diagnostics.map((d) => d.rule)).toEqual(['TOOL', 'TOOL', 'TOOL']);
    });

    it('HARNESS-SYNTAX: ${CLAUDE_ in the body is an error, and the agent stays', async () => {
      const { project, diagnostics } = await loadWithField('model', 'strong', 'Run ${CLAUDE_PLUGIN_ROOT}/x\n');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ path: AGENT_FILE, severity: 'error', rule: 'HARNESS-SYNTAX' });
      expect(diagnostics[0]!.message).toContain('${CLAUDE_');
      expect(project.packs[0]!.agents.map((a) => a.name)).toEqual(['frontend']);
    });

    it('HARNESS-SYNTAX does not fire on other ${...} text or a bare CLAUDE_', async () => {
      const { diagnostics } = await loadWithField('model', 'strong', 'Use ${HOME} and CLAUDE_X and $CLAUDE_Y.\n');
      expect(diagnostics).toEqual([]);
    });

    it('reports every problem of one agent in one run', async () => {
      const { project, diagnostics } = await load({
        [AGENT_FILE]: agentMd(
          { name: 'frontend', description: '""', skills: '[a, a]', tools: '[fly]' },
          'Use ${CLAUDE_PLUGIN_ROOT}.\n',
        ),
      });
      expect(diagnostics.map((d) => d.rule).sort()).toEqual(['DESCRIPTION', 'DUPLICATE', 'HARNESS-SYNTAX', 'TOOL']);
      expect(project.packs[0]!.agents).toHaveLength(1);
    });
  });
});
