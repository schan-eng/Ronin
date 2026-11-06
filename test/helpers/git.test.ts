import { readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitUpstream, makeUpstream, runGit } from './git.js';

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function upstream(files: Parameters<typeof makeUpstream>[0]) {
  const result = await makeUpstream(files);
  made.push(result.dir);
  return result;
}

describe('makeUpstream', () => {
  it('commits the files on main in a fresh tmpdir', async () => {
    const up = await upstream({ 'a/b.txt': 'x', 'run.sh': { content: '#!/bin/sh', executable: true } });
    expect(path.resolve(up.dir).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(up.url).toBe(`file://${up.dir}`);
    expect(up.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await runGit(up.dir, ['rev-parse', 'HEAD'])).toBe(up.commit);
    expect(await runGit(up.dir, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await readFile(path.join(up.dir, 'a/b.txt'), 'utf8')).toBe('x');
    const tree = await runGit(up.dir, ['ls-files', '-s']);
    expect(tree).toMatch(/^100755 \S+ 0\trun\.sh$/m);
    expect(tree).toMatch(/^100644 \S+ 0\ta\/b\.txt$/m);
  });

  it('pins author, committer and dates, so equal content gives an equal commit', async () => {
    const a = await upstream({ 'f.txt': 'same' });
    const b = await upstream({ 'f.txt': 'same' });
    expect(a.commit).toBe(b.commit);
    expect(await runGit(a.dir, ['log', '-1', '--format=%an <%ae> %aI|%cn <%ce> %cI'])).toBe(
      'ronin-test <test@ronin.invalid> 2026-01-01T00:00:00Z|ronin-test <test@ronin.invalid> 2026-01-01T00:00:00Z',
    );
  });

  it('accepts an empty file set', async () => {
    const up = await upstream({});
    expect(up.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns a fresh directory each call', async () => {
    const a = await upstream({ f: '1' });
    const b = await upstream({ f: '2' });
    expect(a.dir).not.toBe(b.dir);
  });
});

describe('commitUpstream', () => {
  it('adds, overwrites and deletes files in a new commit on top of the old one', async () => {
    const up = await upstream({ 'keep.txt': 'keep', 'change.txt': 'old', 'gone.txt': 'bye' });
    const next = await commitUpstream(up.dir, { 'change.txt': 'new', 'sub/added.txt': 'hi', 'gone.txt': null });

    expect(next).toMatch(/^[0-9a-f]{40}$/);
    expect(next).not.toBe(up.commit);
    expect(await runGit(up.dir, ['rev-parse', 'HEAD'])).toBe(next);
    expect(await runGit(up.dir, ['rev-parse', 'HEAD^'])).toBe(up.commit);
    expect(await runGit(up.dir, ['ls-files'])).toBe('change.txt\nkeep.txt\nsub/added.txt');
    expect(await readFile(path.join(up.dir, 'change.txt'), 'utf8')).toBe('new');
    expect(await stat(path.join(up.dir, 'gone.txt')).catch(() => null)).toBeNull();
  });

  it('succeeds when nothing changes', async () => {
    const up = await upstream({ 'f.txt': 'x' });
    const next = await commitUpstream(up.dir, {});
    expect(next).not.toBe(up.commit);
  });
});
