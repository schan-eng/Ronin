import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyLock, readLock, serializeLock, writeLock } from '../../src/lock/lockfile.js';
import type { Lock } from '../../src/lock/lockfile.js';
import { makeProject } from '../helpers/fs.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const COMMIT_2 = 'fedcba9876543210fedcba9876543210fedcba98';
const SHA = '9f2c0000000000000000000000000000000000000000000000000000000000ab';
const SHA_2 = '1111111111111111111111111111111111111111111111111111111111111111';

// The example of spec 5.8, with a complete hash.
const BASE = `lockVersion: 1
sources:
  anthropic:
    repo: https://github.com/anthropics/skills.git
    ref: main
    commit: ${COMMIT}
skills:
  anthropic/frontend-design:
    path: skills/frontend-design
    sha256: ${SHA}
    license: Apache-2.0
    licenseFrom: skill-file
    licenseFile: skills/frontend-design/LICENSE.txt
`;

function sampleLock(): Lock {
  return {
    lockVersion: 1,
    sources: {
      zeta: { repo: 'https://example.com/zeta.git', ref: 'v1', commit: COMMIT_2 },
      anthropic: { repo: 'https://github.com/anthropics/skills.git', ref: 'main', commit: COMMIT },
    },
    skills: {
      'zeta/b-skill': { path: 'b', sha256: SHA_2, license: null, licenseFrom: null },
      'anthropic/frontend-design': {
        path: 'skills/frontend-design',
        sha256: SHA,
        license: 'Apache-2.0',
        licenseFrom: 'skill-file',
        licenseFile: 'skills/frontend-design/LICENSE.txt',
      },
      'anthropic/algorithmic-art': {
        path: 'skills/algorithmic-art',
        sha256: SHA_2,
        license: 'MIT',
        licenseFrom: 'repo-root',
        licenseFile: 'LICENSE',
      },
    },
  };
}

/** The 1-based number of the first line of `text` that contains `needle`. */
function lineOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((l) => l.includes(needle));
  if (index < 0) throw new Error(`no line contains ${JSON.stringify(needle)}`);
  return index + 1;
}

async function readText(text: string): ReturnType<typeof readLock> {
  const root = await makeProject({ 'ronin.lock': text });
  return readLock(root);
}

/** Reads `text` and expects the all-or-nothing outcome: an empty lock and only SCHEMA errors at `ronin.lock`. */
async function readInvalid(text: string) {
  const { lock, diagnostics } = await readText(text);
  expect(lock).toEqual(emptyLock());
  expect(diagnostics.length).toBeGreaterThan(0);
  for (const d of diagnostics) {
    expect(d).toMatchObject({ path: 'ronin.lock', severity: 'error', rule: 'SCHEMA' });
  }
  return diagnostics;
}

describe('emptyLock', () => {
  it('has no sources and no skills', () => {
    expect(emptyLock()).toEqual({ lockVersion: 1, sources: {}, skills: {} });
  });

  it('returns a fresh object each time', () => {
    const a = emptyLock();
    a.sources['x'] = { repo: 'r', ref: 'main', commit: COMMIT };
    expect(emptyLock().sources).toEqual({});
  });
});

describe('readLock', () => {
  it('missing ronin.lock → empty lock, no diagnostics', async () => {
    const root = await makeProject({});
    expect(await readLock(root)).toEqual({ lock: emptyLock(), diagnostics: [] });
  });

  it('reads the example of spec 5.8', async () => {
    const { lock, diagnostics } = await readText(BASE);
    expect(diagnostics).toEqual([]);
    expect(lock).toEqual({
      lockVersion: 1,
      sources: {
        anthropic: { repo: 'https://github.com/anthropics/skills.git', ref: 'main', commit: COMMIT },
      },
      skills: {
        'anthropic/frontend-design': {
          path: 'skills/frontend-design',
          sha256: SHA,
          license: 'Apache-2.0',
          licenseFrom: 'skill-file',
          licenseFile: 'skills/frontend-design/LICENSE.txt',
        },
      },
    });
  });

  it('reads a skill whose license is unknown and that has no licenseFile', async () => {
    const text = BASE.replace('license: Apache-2.0', 'license: null')
      .replace('licenseFrom: skill-file', 'licenseFrom: null')
      .replace(/ {4}licenseFile: .*\n/, '');
    const { lock, diagnostics } = await readText(text);
    expect(diagnostics).toEqual([]);
    expect(lock.skills['anthropic/frontend-design']).toEqual({
      path: 'skills/frontend-design',
      sha256: SHA,
      license: null,
      licenseFrom: null,
    });
  });

  it('reads an empty lock', async () => {
    const { lock, diagnostics } = await readText('lockVersion: 1\nsources: {}\nskills: {}\n');
    expect(diagnostics).toEqual([]);
    expect(lock).toEqual(emptyLock());
  });

  it('reads a file with CRLF line endings and a UTF-8 BOM like an LF file', async () => {
    const text = `\uFEFF${BASE.replace(/\n/g, '\r\n')}`;
    expect(await readText(text)).toEqual(await readText(BASE));
  });

  it('invalid ronin.lock → SCHEMA at ronin.lock', async () => {
    const diagnostics = await readInvalid(BASE.replace('lockVersion: 1', 'lockVersion: 2'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.line).toBe(1);
    expect(diagnostics[0]!.message).toContain('lockVersion');
  });

  it('reports malformed YAML at the line the parser gives', async () => {
    const diagnostics = await readInvalid('lockVersion: 1\nsources: [unclosed\n');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.line).toBeGreaterThan(0);
  });

  it('rejects a file that is not a mapping, with no line', async () => {
    for (const text of ['', '- a\n- b\n', 'just text\n']) {
      const diagnostics = await readInvalid(text);
      expect(diagnostics[0]!.line).toBeUndefined();
    }
  });

  it('is all-or-nothing: a bad entry empties the lock even when other entries are good', async () => {
    const text = `${BASE}  anthropic/other:
    path: ../x
    sha256: ${SHA}
    license: MIT
    licenseFrom: repo-root
`;
    await readInvalid(text);
  });

  it('reports every problem, each at its own line', async () => {
    const text = BASE.replace(COMMIT, 'nothex').replace(SHA, 'abc');
    const diagnostics = await readInvalid(text);
    expect(diagnostics.map((d) => d.line).sort()).toEqual([lineOf(text, 'commit:'), lineOf(text, 'sha256:')].sort());
  });

  it('reports key problems together with field errors, each at its own line', async () => {
    const text = `lockVersion: 1
sources:
  anthropic:
    repo: r
    ref: main
    commit: nothex
  Bad_Name:
    repo: r
    ref: main
    commit: ${COMMIT}
skills:
  missing/x:
    path: ../x
    sha256: ${SHA}
    license: MIT
    licenseFrom: repo-root
  a/b/c:
    path: x
    sha256: ${SHA}
    license: MIT
    licenseFrom: repo-root
`;
    const diagnostics = await readInvalid(text);
    expect(diagnostics.map((d) => d.line).sort((a, b) => a! - b!)).toEqual(
      [
        lineOf(text, 'commit: nothex'),
        lineOf(text, 'Bad_Name:'),
        lineOf(text, 'missing/x:'),
        lineOf(text, 'path: ../x'),
        lineOf(text, 'a/b/c:'),
      ].sort((a, b) => a - b),
    );
  });

  it('does not blame a skill for a source whose entry is malformed', async () => {
    const text = BASE.replace('    ref: main\n', '    ref: main\n    root: .\n');
    const diagnostics = await readInvalid(text);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.line).toBe(lineOf(text, 'root:'));
  });

  describe('strict validation', () => {
    it.each([
      ['a short commit', COMMIT.slice(0, 39)],
      ['a long commit', `${COMMIT}0`],
      ['an uppercase commit', COMMIT.toUpperCase()],
      ['a branch name as commit', 'main'],
      ['a non-hex commit', 'g'.repeat(40)],
    ])('rejects %s', async (_name, commit) => {
      const text = BASE.replace(COMMIT, commit);
      const diagnostics = await readInvalid(text);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.line).toBe(lineOf(text, 'commit:'));
      expect(diagnostics[0]!.message).toContain('sources.anthropic.commit');
    });

    it.each([
      ['a short sha256', SHA.slice(0, 63)],
      ['a long sha256', `${SHA}0`],
      ['an uppercase sha256', SHA.toUpperCase()],
      ['a non-hex sha256', 'z'.repeat(64)],
    ])('rejects %s', async (_name, sha) => {
      const text = BASE.replace(SHA, sha);
      const diagnostics = await readInvalid(text);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.line).toBe(lineOf(text, 'sha256:'));
    });

    it.each([
      ['a ".." segment', '../x'],
      ['an embedded ".." segment', 'skills/../../x'],
      ['a trailing ".." segment', 'skills/..'],
      ['an absolute path', '/etc/passwd'],
      ['a Windows drive path', 'C:/Windows'],
      ['a backslash', 'skills\\frontend-design'],
      ['a backslash-rooted path', '\\skills'],
      ['a "." segment', './skills'],
      ['an embedded "." segment', 'skills/./x'],
      ['an empty segment', 'skills//x'],
      ['a trailing slash', 'skills/'],
      ['an empty path', '""'],
    ])('rejects a skill path with %s', async (_name, value) => {
      const text = BASE.replace('path: skills/frontend-design', `path: ${value}`);
      const diagnostics = await readInvalid(text);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.line).toBe(lineOf(text, 'path:'));
      expect(diagnostics[0]!.message).toContain('path');
    });

    it.each(['../LICENSE', '/LICENSE', 'a\\LICENSE', './LICENSE', 'a//LICENSE'])(
      'rejects the licenseFile %s',
      async (value) => {
        const text = BASE.replace('licenseFile: skills/frontend-design/LICENSE.txt', `licenseFile: ${value}`);
        const diagnostics = await readInvalid(text);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.line).toBe(lineOf(text, 'licenseFile:'));
      },
    );

    it('rejects a skill whose source is not in sources', async () => {
      const text = BASE.replace('anthropic/frontend-design:', 'missing/frontend-design:');
      const diagnostics = await readInvalid(text);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.line).toBe(lineOf(text, 'missing/frontend-design:'));
      expect(diagnostics[0]!.message).toContain('missing');
    });

    it('does not take a name inherited by every object for a source', async () => {
      const text = BASE.replace('anthropic/frontend-design:', 'constructor/frontend-design:');
      const diagnostics = await readInvalid(text);
      expect(diagnostics[0]!.line).toBe(lineOf(text, 'constructor/frontend-design:'));
    });

    it.each([
      ['a skill key with no source part', 'frontend-design'],
      ['a skill key with a nested path', 'anthropic/a/b'],
      ['a skill key with an empty skill part', 'anthropic/'],
      ['a skill key with an uppercase skill part', 'anthropic/Frontend'],
      ['a skill key with a ".." skill part', 'anthropic/..'],
    ])('rejects %s', async (_name, key) => {
      const text = BASE.replace('anthropic/frontend-design:', `${key}:`);
      const diagnostics = await readInvalid(text);
      expect(diagnostics[0]!.line).toBe(lineOf(text, `${key}:`));
    });

    it.each(['Anthropic', 'a_b', '-a', 'a.b', '..', '__proto__', 'a'.repeat(65)])(
      'rejects the source name %s',
      async (name) => {
        const text = BASE.replace('  anthropic:\n', `  ${name}:\n`);
        const diagnostics = await readInvalid(text);
        expect(diagnostics.some((d) => d.line === lineOf(text, `  ${name}:`))).toBe(true);
      },
    );

    it('rejects an unknown top-level key at its line', async () => {
      const text = `${BASE}extra: true\n`;
      const diagnostics = await readInvalid(text);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.line).toBe(lineOf(text, 'extra:'));
      expect(diagnostics[0]!.message).toContain('extra');
    });

    it('rejects an unknown key in a source', async () => {
      const text = BASE.replace('    ref: main\n', '    ref: main\n    root: .\n');
      const diagnostics = await readInvalid(text);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.line).toBe(lineOf(text, 'root:'));
    });

    it('rejects an unknown key in a skill', async () => {
      const text = `${BASE}    note: hi\n`;
      const diagnostics = await readInvalid(text);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.line).toBe(lineOf(text, 'note:'));
    });

    it.each([
      ['licenseFrom is not one of the four values', BASE.replace('licenseFrom: skill-file', 'licenseFrom: guessed'), 'licenseFrom:'],
      ['license is not a string or null', BASE.replace('license: Apache-2.0', 'license: 12'), 'license:'],
      ['repo is empty', BASE.replace('repo: https://github.com/anthropics/skills.git', 'repo: ""'), 'repo:'],
      ['ref is empty', BASE.replace('ref: main', 'ref: ""'), 'ref:'],
      ['lockVersion is a string', BASE.replace('lockVersion: 1', 'lockVersion: "1"'), 'lockVersion:'],
    ])('rejects a lock where %s', async (_name, text, needle) => {
      const diagnostics = await readInvalid(text);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.line).toBe(lineOf(text, needle));
    });

    it.each([
      ['lockVersion', /^lockVersion: 1\n/],
      ['sources', /^sources:\n( {2}.*\n)+/m],
      ['skills', /^skills:\n( {2,}.*\n)+/m],
    ])('rejects a lock with no %s', async (_name, pattern) => {
      await readInvalid(BASE.replace(pattern, ''));
    });

    it.each(['license', 'licenseFrom', 'path', 'sha256'])('rejects a skill with no %s', async (key) => {
      const text = BASE.replace(new RegExp(`^ {4}${key}: .*\\n`, 'm'), '');
      await readInvalid(text);
    });

    it.each(['repo', 'ref', 'commit'])('rejects a source with no %s', async (key) => {
      const text = BASE.replace(new RegExp(`^ {4}${key}: .*\\n`, 'm'), '');
      await readInvalid(text);
    });
  });
});

describe('serializeLock', () => {
  it('sorts sources and skills by plain string comparison', () => {
    const lock: Lock = {
      lockVersion: 1,
      sources: {
        a: { repo: 'r', ref: 'main', commit: COMMIT },
        '9': { repo: 'r', ref: 'main', commit: COMMIT },
        '10': { repo: 'r', ref: 'main', commit: COMMIT },
        'a-b': { repo: 'r', ref: 'main', commit: COMMIT },
      },
      skills: {
        'a/b': { path: 'b', sha256: SHA, license: null, licenseFrom: null },
        'a-b/c': { path: 'c', sha256: SHA, license: null, licenseFrom: null },
        'a/a': { path: 'a', sha256: SHA, license: null, licenseFrom: null },
        '9/x': { path: 'x', sha256: SHA, license: null, licenseFrom: null },
        '10/x': { path: 'x', sha256: SHA, license: null, licenseFrom: null },
      },
    };
    const keys = serializeLock(lock)
      .split('\n')
      .filter((l) => /^ {2}\S/.test(l))
      .map((l) => l.trim().replace(/:$/, '').replace(/^"(.*)"$/, '$1'));
    // JavaScript would list the integer-like keys of a plain object first, in numeric order.
    expect(keys).toEqual(['10', '9', 'a', 'a-b', '10/x', '9/x', 'a-b/c', 'a/a', 'a/b']);
  });

  it('compares code units, not locale rules', () => {
    // Not valid names, but the order must not depend on a locale where "a" sorts before "B".
    const lock = emptyLock();
    for (const name of ['a', 'B', 'b', 'A']) lock.sources[name] = { repo: 'r', ref: 'main', commit: COMMIT };
    const keys = serializeLock(lock)
      .split('\n')
      .filter((l) => /^ {2}\S/.test(l))
      .map((l) => l.trim());
    expect(keys).toEqual(['A:', 'B:', 'a:', 'b:']);
  });

  it('does not depend on the order of the input', () => {
    const lock = sampleLock();
    const reversed: Lock = {
      lockVersion: 1,
      sources: Object.fromEntries(Object.entries(lock.sources).reverse()),
      skills: Object.fromEntries(Object.entries(lock.skills).reverse()),
    };
    expect(serializeLock(reversed)).toBe(serializeLock(lock));
  });

  it('matches the example of spec 5.8', () => {
    const lock: Lock = {
      lockVersion: 1,
      sources: {
        anthropic: { repo: 'https://github.com/anthropics/skills.git', ref: 'main', commit: COMMIT },
      },
      skills: {
        'anthropic/frontend-design': {
          path: 'skills/frontend-design',
          sha256: SHA,
          license: 'Apache-2.0',
          licenseFrom: 'skill-file',
          licenseFile: 'skills/frontend-design/LICENSE.txt',
        },
      },
    };
    expect(serializeLock(lock)).toBe(BASE);
  });

  it('field order matches §5.8', () => {
    const text = serializeLock(sampleLock());
    const lines = text.split('\n');
    const start = lines.indexOf('  anthropic/frontend-design:');
    expect(lines.slice(start + 1, start + 6).map((l) => l.trim().split(':')[0])).toEqual([
      'path',
      'sha256',
      'license',
      'licenseFrom',
      'licenseFile',
    ]);
    const source = lines.indexOf('  zeta:');
    expect(lines.slice(source + 1, source + 4).map((l) => l.trim().split(':')[0])).toEqual([
      'repo',
      'ref',
      'commit',
    ]);
    expect(lines.filter((l) => /^\S/.test(l) && l !== '')).toEqual(['lockVersion: 1', 'sources:', 'skills:']);
  });

  it('writes null license and licenseFrom explicitly and leaves out an undefined licenseFile', () => {
    const text = serializeLock(sampleLock());
    expect(text).toMatch(/^ {2}zeta\/b-skill:\n {4}path: b\n {4}sha256: .*\n {4}license: null\n {4}licenseFrom: null\n$/m);
    const tail = text.slice(text.indexOf('  zeta/b-skill:'));
    expect(tail).not.toContain('licenseFile');
  });

  it('leaves out a licenseFile that is explicitly undefined', () => {
    const lock = emptyLock();
    lock.sources['s'] = { repo: 'r', ref: 'main', commit: COMMIT };
    lock.skills['s/k'] = { path: 'k', sha256: SHA, license: 'MIT', licenseFrom: 'asserted', licenseFile: undefined };
    expect(serializeLock(lock)).not.toContain('licenseFile');
  });

  it('serializes the empty lock', () => {
    expect(serializeLock(emptyLock())).toBe('lockVersion: 1\nsources: {}\nskills: {}\n');
  });

  it('uses LF line endings, a trailing newline and 2-space indentation', () => {
    const text = serializeLock(sampleLock());
    expect(text).not.toContain('\r');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    for (const line of text.split('\n')) {
      expect(line).toMatch(/^( {2})*(?! )/);
    }
  });

  it('keeps long values on one line', () => {
    const repo = `https://example.com/${'very-long-organisation-name/'.repeat(8)}skills.git`;
    const ref = `release/${'segment-'.repeat(30)}end`;
    const license = `Custom ${'words '.repeat(60)}license`;
    const lockPath = `skills/${'deeply-nested/'.repeat(12)}skill`;
    const lock = emptyLock();
    lock.sources['s'] = { repo, ref, commit: COMMIT };
    lock.skills['s/k'] = { path: lockPath, sha256: SHA, license, licenseFrom: 'asserted', licenseFile: `${lockPath}/LICENSE` };
    const text = serializeLock(lock);
    expect(text).toContain(`    repo: ${repo}\n`);
    expect(text).toContain(`    ref: ${ref}\n`);
    expect(text).toContain(`    license: ${license}\n`);
    expect(text).toContain(`    path: ${lockPath}\n`);
    expect(text).toContain(`    licenseFile: ${lockPath}/LICENSE\n`);
  });

  it('is byte-identical when serialized twice', () => {
    expect(serializeLock(sampleLock())).toBe(serializeLock(sampleLock()));
  });

  it('round-trips through readLock', async () => {
    const lock = sampleLock();
    const { lock: read, diagnostics } = await readText(serializeLock(lock));
    expect(diagnostics).toEqual([]);
    expect(read).toEqual(lock);
    expect(serializeLock(read)).toBe(serializeLock(lock));
  });

  it('serialize sorts sources and skills and round-trips through readLock', async () => {
    const root = await makeProject({});
    await writeLock(root, sampleLock());
    const text = await readFile(path.join(root, 'ronin.lock'), 'utf8');
    expect(text.indexOf('  anthropic:')).toBeLessThan(text.indexOf('  zeta:'));
    expect(text.indexOf('  anthropic/algorithmic-art:')).toBeLessThan(text.indexOf('  anthropic/frontend-design:'));
    expect(text.indexOf('  anthropic/frontend-design:')).toBeLessThan(text.indexOf('  zeta/b-skill:'));
    const { lock, diagnostics } = await readLock(root);
    expect(diagnostics).toEqual([]);
    expect(lock).toEqual(sampleLock());
  });

  it.each([
    '1.0',
    '0123',
    '1',
    '1e3',
    '0x1F',
    '.5',
    '-1',
    '+1',
    '.inf',
    '.nan',
    'true',
    'false',
    'True',
    'null',
    'Null',
    '~',
    '2024-01-01',
    '12:30:45',
    'yes',
    'no',
    'on',
    'off',
    'v1.0',
  ])('round-trips the ref %s as a string', async (ref) => {
    const lock = emptyLock();
    lock.sources['s'] = { repo: 'https://example.com/r.git', ref, commit: COMMIT };
    lock.skills['s/k'] = { path: 'k', sha256: SHA, license: '1.0', licenseFrom: 'asserted' };
    const { lock: read, diagnostics } = await readText(serializeLock(lock));
    expect(diagnostics).toEqual([]);
    expect(read.sources['s']!.ref).toBe(ref);
    expect(read.skills['s/k']!.license).toBe('1.0');
    expect(read).toEqual(lock);
  });

  it('round-trips numeric-looking source names and values with YAML-significant text', async () => {
    const lock = emptyLock();
    lock.sources['123'] = { repo: 'https://example.com/a b.git', ref: 'a: b # c', commit: COMMIT };
    lock.sources['0123'] = { repo: "it's \"quoted\"", ref: ' padded ', commit: COMMIT_2 };
    lock.skills['123/k'] = { path: 'k', sha256: SHA, license: 'LicenseRef: x', licenseFrom: 'frontmatter' };
    const { lock: read, diagnostics } = await readText(serializeLock(lock));
    expect(diagnostics).toEqual([]);
    expect(Object.keys(read.sources).sort()).toEqual(['0123', '123']);
    expect(read.sources['123']).toEqual(lock.sources['123']);
    expect(read.sources['0123']).toEqual(lock.sources['0123']);
    expect(read.skills['123/k']).toEqual(lock.skills['123/k']);
  });
});

describe('writeLock', () => {
  it('writes ronin.lock with the serialized content', async () => {
    const root = await makeProject({});
    await writeLock(root, sampleLock());
    expect(await readFile(path.join(root, 'ronin.lock'), 'utf8')).toBe(serializeLock(sampleLock()));
  });

  it('replaces an existing ronin.lock', async () => {
    const root = await makeProject({ 'ronin.lock': BASE });
    await writeLock(root, emptyLock());
    expect(await readFile(path.join(root, 'ronin.lock'), 'utf8')).toBe(serializeLock(emptyLock()));
    expect(await readLock(root)).toEqual({ lock: emptyLock(), diagnostics: [] });
  });

  it('replaces an invalid ronin.lock', async () => {
    const root = await makeProject({ 'ronin.lock': 'not: [valid' });
    await writeLock(root, sampleLock());
    expect(await readLock(root)).toEqual({ lock: sampleLock(), diagnostics: [] });
  });

  it('leaves no temporary file behind', async () => {
    const root = await makeProject({ 'sources.yaml': 'sources: {}\n' });
    await writeLock(root, sampleLock());
    await writeLock(root, sampleLock());
    expect((await readdir(root)).sort()).toEqual(['ronin.lock', 'sources.yaml']);
  });

  it('gives the file mode 0644', async () => {
    const root = await makeProject({});
    await writeLock(root, sampleLock());
    expect((await stat(path.join(root, 'ronin.lock'))).mode & 0o777).toBe(0o644);
  });

  it('keeps the previous content and leaves no temporary file when the rename fails', async () => {
    const root = await makeProject({});
    // A directory called ronin.lock makes the final rename fail, after the temporary file is written.
    await writeFile(path.join(root, 'marker'), '');
    await mkdir(path.join(root, 'ronin.lock'));
    await writeFile(path.join(root, 'ronin.lock', 'keep'), 'x');
    await expect(writeLock(root, sampleLock())).rejects.toThrow();
    expect((await readdir(root)).sort()).toEqual(['marker', 'ronin.lock']);
    expect(await readFile(path.join(root, 'ronin.lock', 'keep'), 'utf8')).toBe('x');
  });
});
