import { readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachePath, ensureCommit } from '../../src/lock/cache.js';
import { GitError, git, resolveRef } from '../../src/lock/git.js';
import { makeProject } from '../helpers/fs.js';
import type { ProjectFile } from '../helpers/fs.js';
import { commitUpstream, makeUpstream, runGit } from '../helpers/git.js';

const SKILL_V1 = '---\nname: demo\ndescription: first\n---\nOne\n';
const SKILL_V2 = '---\nname: demo\ndescription: second\n---\nTwo\n';
const UNKNOWN_SHA = 'f'.repeat(40);

const made: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function upstream(files: Record<string, ProjectFile>) {
  const result = await makeUpstream(files);
  made.push(result.dir);
  return result;
}

async function project(files: Record<string, ProjectFile> = {}): Promise<string> {
  const dir = await makeProject(files);
  made.push(dir);
  return dir;
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

describe('git', () => {
  it('returns stdout', async () => {
    expect(await git(['--version'])).toMatch(/^git version /);
  });

  it('runs in the given cwd', async () => {
    const up = await upstream({ 'a.txt': 'a' });
    expect((await git(['rev-parse', 'HEAD'], up.dir)).trim()).toBe(up.commit);
  });

  it('throws GitError carrying stderr on failure', async () => {
    const err = await git(['definitely-not-a-command']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).name).toBe('GitError');
    expect((err as GitError).message).toContain('definitely-not-a-command');
    expect((err as GitError).stderr).toContain('not a git command');
  });

  it('runs every command with protocol.ext.allow=never', async () => {
    expect((await git(['config', '--get', 'protocol.ext.allow'], os.tmpdir())).trim()).toBe('never');
  });

  it('sets GIT_TERMINAL_PROMPT=0 and inherits the rest of the environment', async () => {
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
    vi.stubEnv('RONIN_TEST_PASSTHROUGH', 'kept');
    const out = await git(
      ['-c', 'alias.ronin-env=!printf "%s|%s" "$GIT_TERMINAL_PROMPT" "$RONIN_TEST_PASSTHROUGH"', 'ronin-env'],
      os.tmpdir(),
    );
    expect(out).toBe('0|kept');
  });
});

// R13: when ronin runs inside a git hook, git exports variables that say which repository to use.
// Passed on, they would make the init/fetch/checkout in the cache temp dir act on the user's repository.
describe('repository-locating environment (R13)', () => {
  const LOCAL_ENV_VARS = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_GRAFT_FILE',
    'GIT_NO_REPLACE_OBJECTS',
    'GIT_REPLACE_REF_BASE',
    'GIT_PREFIX',
    'GIT_SHALLOW_FILE',
    'GIT_CONFIG',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
  ];

  it.skipIf(process.platform === 'win32')(
    'removes each repository-local variable and keeps the other GIT_* ones',
    async () => {
      const bin = await project({ git: { content: '#!/bin/sh\nenv >> "$RONIN_TEST_LOG"\n', executable: true } });
      const log = path.join(await project(), 'env.log');
      vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
      vi.stubEnv('RONIN_TEST_LOG', log);
      for (const name of LOCAL_ENV_VARS) vi.stubEnv(name, 'leaked');
      vi.stubEnv('GIT_SSH_COMMAND', 'ssh -i key');
      vi.stubEnv('GIT_ASKPASS', 'askpass-helper');

      await git(['status']);

      const seen = new Map(
        (await readFile(log, 'utf8'))
          .split('\n')
          .filter((line) => line.startsWith('GIT_'))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
      );
      for (const name of LOCAL_ENV_VARS) expect(seen.has(name), name).toBe(false);
      expect(seen.get('GIT_SSH_COMMAND')).toBe('ssh -i key');
      expect(seen.get('GIT_ASKPASS')).toBe('askpass-helper');
      expect(seen.get('GIT_TERMINAL_PROMPT')).toBe('0');
    },
  );

  it('ensureCommit fills the cache and leaves the repository named by GIT_DIR/GIT_WORK_TREE alone', async () => {
    const decoy = await upstream({ 'decoy.txt': 'decoy' });
    const up = await upstream({ 'SKILL.md': SKILL_V1 });
    const root = await project();
    expect(decoy.commit).not.toBe(up.commit);

    vi.stubEnv('GIT_DIR', path.join(decoy.dir, '.git'));
    vi.stubEnv('GIT_WORK_TREE', decoy.dir);
    vi.stubEnv('GIT_INDEX_FILE', path.join(decoy.dir, '.git', 'index'));
    let dir: string;
    try {
      dir = await ensureCommit(root, 'up', up.url, up.commit);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(dir).toBe(cachePath(root, 'up', up.commit));
    expect(await readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(SKILL_V1);
    expect(await exists(path.join(dir, 'decoy.txt'))).toBe(false);
    expect(await runGit(dir, ['rev-parse', 'HEAD'])).toBe(up.commit);

    expect(await runGit(decoy.dir, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await runGit(decoy.dir, ['rev-parse', 'HEAD'])).toBe(decoy.commit);
    expect(await runGit(decoy.dir, ['status', '--porcelain'])).toBe('');
    expect(await runGit(decoy.dir, ['ls-files'])).toBe('decoy.txt');
    expect(await exists(path.join(decoy.dir, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(await exists(path.join(decoy.dir, 'SKILL.md'))).toBe(false);
  });
});

describe('resolveRef', () => {
  it('main resolves to the head commit', async () => {
    const up = await upstream({ 'a.txt': 'a' });
    const second = await commitUpstream(up.dir, { 'a.txt': 'b' });
    expect(await resolveRef(up.url, 'main')).toBe(second);
  });

  it('an annotated tag resolves to the peeled commit', async () => {
    const up = await upstream({ 'a.txt': 'a' });
    await commitUpstream(up.dir, { 'a.txt': 'b' });
    await runGit(up.dir, ['tag', '-a', 'v1', '-m', 'release', up.commit]);
    expect(await runGit(up.dir, ['rev-parse', 'v1'])).not.toBe(up.commit); // the tag object, not the commit
    expect(await resolveRef(up.url, 'v1')).toBe(up.commit);
  });

  it('a lightweight tag resolves to its commit', async () => {
    const up = await upstream({ 'a.txt': 'a' });
    await commitUpstream(up.dir, { 'a.txt': 'b' });
    await runGit(up.dir, ['tag', 'light', up.commit]);
    expect(await resolveRef(up.url, 'light')).toBe(up.commit);
  });

  it('a branch wins over a tag of the same name', async () => {
    const up = await upstream({ 'a.txt': 'a' });
    const second = await commitUpstream(up.dir, { 'a.txt': 'b' });
    await runGit(up.dir, ['branch', 'dup', second]);
    await runGit(up.dir, ['tag', 'dup', up.commit]);
    expect(await resolveRef(up.url, 'dup')).toBe(second);
  });

  it('matches the ref exactly, not a refs/heads/*/<ref> suffix', async () => {
    const up = await upstream({ 'a.txt': 'a' });
    const second = await commitUpstream(up.dir, { 'a.txt': 'b' });
    await runGit(up.dir, ['branch', 'feature/main', up.commit]);
    await runGit(up.dir, ['branch', 'feature/only', up.commit]);
    expect(await resolveRef(up.url, 'main')).toBe(second);
    await expect(resolveRef(up.url, 'only')).rejects.toThrow(GitError);
  });

  it('returns a 40-hex ref unchanged without contacting the repository', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(await resolveRef('file:///nonexistent/ronin-test-repo', sha)).toBe(sha);
  });

  it('an unknown ref is a GitError', async () => {
    const up = await upstream({ 'a.txt': 'a' });
    await expect(resolveRef(up.url, 'no-such-ref')).rejects.toThrow(GitError);
  });

  it('an unreachable repository is a GitError', async () => {
    await expect(resolveRef('file:///nonexistent/ronin-test-repo', 'main')).rejects.toThrow(GitError);
  });
});

describe('cachePath', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  it('is <root>/.ronin/cache/<source>/<commit>', () => {
    expect(cachePath('/work/proj', 'anthropic', sha)).toBe(
      path.join('/work/proj', '.ronin', 'cache', 'anthropic', sha),
    );
  });

  it.each([
    '../../x',
    '',
    'abc',
    'a'.repeat(39),
    'a'.repeat(41),
    'A'.repeat(40),
    `${'a'.repeat(39)}/`,
    `${'a'.repeat(40)}\n`,
    `../${'a'.repeat(37)}`,
  ])('rejects the commit %j', (commit) => {
    expect(() => cachePath('/work/proj', 'anthropic', commit)).toThrow(GitError);
  });

  it.each(['..', '.', '', '../x', 'a/b', 'A', '-x', 'a'.repeat(65)])('rejects the source %j', (source) => {
    expect(() => cachePath('/work/proj', source, sha)).toThrow(GitError);
  });
});

describe('ensureCommit', () => {
  it('fetches into cachePath and checks out the commit', async () => {
    const up = await upstream({ 'skills/demo/SKILL.md': SKILL_V1, 'skills/demo/old.txt': 'old' });
    await commitUpstream(up.dir, { 'skills/demo/SKILL.md': SKILL_V2, 'skills/demo/old.txt': null });
    const root = await project();

    const dir = await ensureCommit(root, 'up', up.url, up.commit);

    expect(dir).toBe(cachePath(root, 'up', up.commit));
    expect(await readFile(path.join(dir, 'skills/demo/SKILL.md'), 'utf8')).toBe(SKILL_V1);
    expect(await readFile(path.join(dir, 'skills/demo/old.txt'), 'utf8')).toBe('old');
    expect((await git(['rev-parse', 'HEAD'], dir)).trim()).toBe(up.commit);
    expect((await git(['rev-parse', '--is-shallow-repository'], dir)).trim()).toBe('true');
    expect(await entries(path.dirname(dir))).toEqual([up.commit]);
  });

  it('reuses an existing cache dir', async () => {
    const up = await upstream({ 'SKILL.md': SKILL_V1 });
    const root = await project();
    const first = await ensureCommit(root, 'up', up.url, up.commit);

    await rm(up.dir, { recursive: true, force: true });
    const second = await ensureCommit(root, 'up', up.url, up.commit);

    expect(second).toBe(first);
    expect(await readFile(path.join(second, 'SKILL.md'), 'utf8')).toBe(SKILL_V1);
  });

  it('bad URL: GitError and no cache or temp dir left', async () => {
    const root = await project();
    const missing = 'file:///nonexistent/ronin-test-repo';
    await expect(ensureCommit(root, 'up', missing, UNKNOWN_SHA)).rejects.toThrow(GitError);
    expect(await entries(path.join(root, '.ronin', 'cache', 'up'))).toEqual([]);
  });

  it('a commit the upstream does not have: GitError and nothing left', async () => {
    const up = await upstream({ 'SKILL.md': SKILL_V1 });
    const root = await project();
    await expect(ensureCommit(root, 'up', up.url, UNKNOWN_SHA)).rejects.toThrow(GitError);
    expect(await entries(path.join(root, '.ronin', 'cache', 'up'))).toEqual([]);
  });

  it('concurrent runs filling the same cache dir both succeed and leave no temp dir', async () => {
    const up = await upstream({ 'SKILL.md': SKILL_V1 });
    const root = await project();

    const results = await Promise.all([1, 2, 3].map(() => ensureCommit(root, 'up', up.url, up.commit)));

    expect(new Set(results)).toEqual(new Set([cachePath(root, 'up', up.commit)]));
    expect(await readFile(path.join(results[0] as string, 'SKILL.md'), 'utf8')).toBe(SKILL_V1);
    expect(await entries(path.join(root, '.ronin', 'cache', 'up'))).toEqual([up.commit]);
  });

  it('rejects a path-shaped commit before touching the file system', async () => {
    const up = await upstream({ 'SKILL.md': SKILL_V1 });
    const root = await project();
    await expect(ensureCommit(root, 'up', up.url, '../../x')).rejects.toThrow(GitError);
    expect(await exists(path.join(root, '.ronin'))).toBe(false);
  });

  it('rejects a source that is not a name', async () => {
    const up = await upstream({ 'SKILL.md': SKILL_V1 });
    const root = await project();
    await expect(ensureCommit(root, '../evil', up.url, up.commit)).rejects.toThrow(GitError);
    expect(await exists(path.join(root, '.ronin'))).toBe(false);
  });
});

describe('option injection (R12)', () => {
  it('a repo beginning with - is rejected and git never runs', async () => {
    const marker = path.join(await project(), 'marker');
    const evil = `--upload-pack=touch ${marker}`;
    const root = await project();

    await expect(resolveRef(evil, 'main')).rejects.toThrow(GitError);
    await expect(ensureCommit(root, 'up', evil, UNKNOWN_SHA)).rejects.toThrow(GitError);
    await expect(resolveRef('-x', UNKNOWN_SHA)).rejects.toThrow(GitError);

    expect(await exists(marker)).toBe(false);
    expect(await exists(path.join(root, '.ronin'))).toBe(false);
  });

  it('a ref beginning with - is rejected', async () => {
    const up = await upstream({ 'a.txt': 'a' });
    await expect(resolveRef(up.url, '--upload-pack=x')).rejects.toThrow(GitError);
    await expect(resolveRef(up.url, '-h')).rejects.toThrow(GitError);
  });

  // The repository is attacker-controlled data, so it is passed after `--`, and every command runs with
  // the ext transport off and prompts disabled. A stand-in `git` on PATH records what it is given.
  it.skipIf(process.platform === 'win32')('passes -- before the repository and runs hardened', async () => {
    // One line per call: the value of GIT_TERMINAL_PROMPT, then each argument, all tab-terminated.
    const script = [
      '#!/bin/sh',
      'printf "%s\\t" "$GIT_TERMINAL_PROMPT" "$@" >> "$RONIN_TEST_LOG"',
      'printf "\\n" >> "$RONIN_TEST_LOG"',
      '',
    ].join('\n');
    const bin = await project({ git: { content: script, executable: true } });
    const logDir = await project();
    const log = path.join(logDir, 'calls.log');
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('RONIN_TEST_LOG', log);
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
    const repo = 'https://example.invalid/repo.git';
    const commit = 'a'.repeat(40);

    await expect(resolveRef(repo, 'main')).rejects.toThrow(GitError); // the stand-in lists no refs
    const root = await project();
    await ensureCommit(root, 'up', repo, commit);

    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.replace(/\t$/, '').split('\t'));
    const [prompt0, ...lsRemote] = calls[0] as string[];
    expect(prompt0).toBe('0');
    expect(lsRemote).toEqual([
      '-c',
      'protocol.ext.allow=never',
      'ls-remote',
      '--',
      repo,
      'refs/heads/main',
      'refs/tags/main',
      'refs/tags/main^{}',
    ]);

    expect(calls.map((c) => c[3])).toEqual(['ls-remote', 'init', 'fetch', 'checkout']);
    for (const call of calls) {
      expect(call.slice(0, 3)).toEqual(['0', '-c', 'protocol.ext.allow=never']);
    }
    const fetchArgs = (calls[2] as string[]).slice(4);
    const dashes = fetchArgs.indexOf('--');
    expect(dashes).toBeGreaterThan(-1);
    expect(fetchArgs.slice(dashes)).toEqual(['--', repo, commit]);
    expect(fetchArgs.slice(0, dashes)).toEqual(expect.arrayContaining(['--depth', '1']));
  });
});
