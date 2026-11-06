import { execFileSync } from 'node:child_process';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTree } from '../../src/core/files.js';
import { enc, makeProject } from '../helpers/fs.js';

const isWindows = process.platform === 'win32';

describe('readTree', () => {
  it('returns every file with its bytes, sorted by path, with "/" separators for nested paths', async () => {
    const dir = await makeProject({
      'b.txt': 'b',
      'sub/deep/c.md': 'c',
      'SKILL.md': 'skill',
      'sub/a.md': 'a',
    });
    const { files, symlinks } = await readTree(dir);
    expect(files).toEqual([
      { path: 'SKILL.md', bytes: enc('skill'), executable: false },
      { path: 'b.txt', bytes: enc('b'), executable: false },
      { path: 'sub/a.md', bytes: enc('a'), executable: false },
      { path: 'sub/deep/c.md', bytes: enc('c'), executable: false },
    ]);
    expect(symlinks).toEqual([]);
  });

  it('sorts by plain string comparison of the whole path', async () => {
    // Walking directories in name order would give 'a/x' before 'a-b/x'; the full paths sort the other way
    // because '-' (45) is below '/' (47). Uppercase sorts before lowercase, which a locale sort would not do.
    const dir = await makeProject({ 'a/x': '1', 'a-b/x': '2', 'a.txt': '3', B: '4', c: '5' });
    const { files } = await readTree(dir);
    expect(files.map((f) => f.path)).toEqual(['B', 'a-b/x', 'a.txt', 'a/x', 'c']);
  });

  it('returns the exact bytes of binary files', async () => {
    const bytes = new Uint8Array([0, 255, 10, 13, 128, 0xef, 0xbb, 0xbf]);
    const dir = await makeProject({ 'bin/data.bin': { content: bytes } });
    const { files } = await readTree(dir);
    expect(files).toHaveLength(1);
    expect(files[0]!.bytes).toEqual(bytes);
  });

  it.skipIf(isWindows)('sets executable when any execute bit is set', async () => {
    const dir = await makeProject({
      'plain.txt': 'p',
      'run.sh': { content: '#!/bin/sh\n', executable: true },
      'owner-only.sh': 'o',
      'other-only.sh': 'x',
    });
    await chmod(path.join(dir, 'owner-only.sh'), 0o700);
    await chmod(path.join(dir, 'other-only.sh'), 0o601);
    const { files } = await readTree(dir);
    expect(files.map((f) => [f.path, f.executable])).toEqual([
      ['other-only.sh', true],
      ['owner-only.sh', true],
      ['plain.txt', false],
      ['run.sh', true],
    ]);
  });

  it('skips .git at the top and in subdirectories', async () => {
    const dir = await makeProject({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/objects/ab/cd': 'x',
      'SKILL.md': 's',
      'vendor/.git': 'gitdir: ../elsewhere\n',
      'vendor/.git-keep': 'kept',
      'vendor/lib.md': 'l',
    });
    const { files, symlinks } = await readTree(dir);
    expect(files.map((f) => f.path)).toEqual(['SKILL.md', 'vendor/.git-keep', 'vendor/lib.md']);
    expect(symlinks).toEqual([]);
  });

  it('returns nothing for an empty directory', async () => {
    const dir = await makeProject({});
    expect(await readTree(dir)).toEqual({ files: [], symlinks: [] });
  });

  it('ignores empty subdirectories', async () => {
    const dir = await makeProject({ 'a.md': 'a' });
    await mkdir(path.join(dir, 'empty'));
    const { files } = await readTree(dir);
    expect(files.map((f) => f.path)).toEqual(['a.md']);
  });

  it('rejects when the directory does not exist', async () => {
    const dir = await makeProject({});
    await expect(readTree(path.join(dir, 'missing'))).rejects.toThrow(/ENOENT/);
  });

  describe('symbolic links (Review Focus 1)', () => {
    it('lists a symlink to a file, and does not follow it', async () => {
      const dir = await makeProject({ 'SKILL.md': 's' });
      await symlink('/etc/hosts', path.join(dir, 'evil'));
      const { files, symlinks } = await readTree(dir);
      expect(symlinks).toEqual(['evil']);
      expect(files.map((f) => f.path)).toEqual(['SKILL.md']);
    });

    it('lists a symlink to a directory without recursing into it', async () => {
      const outside = await makeProject({ 'secret.txt': 'secret', 'nested/more.txt': 'more' });
      const dir = await makeProject({ 'SKILL.md': 's' });
      await symlink(outside, path.join(dir, 'linked-dir'));
      const { files, symlinks } = await readTree(dir);
      expect(symlinks).toEqual(['linked-dir']);
      expect(files.map((f) => f.path)).toEqual(['SKILL.md']);
    });

    it('lists a symlink in a subdirectory by its path relative to the root', async () => {
      const dir = await makeProject({ 'SKILL.md': 's', 'refs/ok.md': 'ok' });
      await symlink('../SKILL.md', path.join(dir, 'refs', 'alias.md'));
      const { files, symlinks } = await readTree(dir);
      expect(symlinks).toEqual(['refs/alias.md']);
      expect(files.map((f) => f.path)).toEqual(['SKILL.md', 'refs/ok.md']);
    });

    it('lists a dangling symlink', async () => {
      const dir = await makeProject({ 'SKILL.md': 's' });
      await symlink('does-not-exist', path.join(dir, 'dangling'));
      const { files, symlinks } = await readTree(dir);
      expect(symlinks).toEqual(['dangling']);
      expect(files.map((f) => f.path)).toEqual(['SKILL.md']);
    });

    it('lists several symlinks, sorted by path', async () => {
      const dir = await makeProject({ 'z/keep.md': 'k' });
      await symlink('/etc/hosts', path.join(dir, 'z', 'b'));
      await symlink('/etc/hosts', path.join(dir, 'z', 'a'));
      await symlink('/etc/hosts', path.join(dir, 'top'));
      const { symlinks } = await readTree(dir);
      expect(symlinks).toEqual(['top', 'z/a', 'z/b']);
    });

    it('does not hide a symlink named .git', async () => {
      const dir = await makeProject({ 'SKILL.md': 's' });
      await symlink('/etc', path.join(dir, '.git'));
      const { files, symlinks } = await readTree(dir);
      expect(symlinks).toEqual(['.git']);
      expect(files.map((f) => f.path)).toEqual(['SKILL.md']);
    });
  });

  describe('other special files', () => {
    it.skipIf(isWindows)('skips a FIFO: neither a file nor a symlink', async () => {
      const dir = await makeProject({ 'SKILL.md': 's' });
      execFileSync('mkfifo', [path.join(dir, 'pipe')]);
      await writeFile(path.join(dir, 'after.md'), enc('a'));
      const { files, symlinks } = await readTree(dir);
      expect(files.map((f) => f.path)).toEqual(['SKILL.md', 'after.md']);
      expect(symlinks).toEqual([]);
    });
  });
});
