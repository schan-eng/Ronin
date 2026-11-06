import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gitEnv } from '../../src/lock/git.js';
import { makeProject, writeFiles } from './fs.js';
import type { ProjectFile } from './fs.js';

const execFileAsync = promisify(execFile);

/**
 * Identity and dates are pinned so equal content always gives an equal commit hash. The user's global and
 * system git configuration (signing, hooks, templates) is ignored.
 */
const PINNED_ENV = {
  GIT_AUTHOR_NAME: 'ronin-test',
  GIT_COMMITTER_NAME: 'ronin-test',
  GIT_AUTHOR_EMAIL: 'test@ronin.invalid',
  GIT_COMMITTER_EMAIL: 'test@ronin.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};

export interface Upstream {
  /** The working directory of the upstream repository, under `os.tmpdir()`. */
  dir: string;
  /** `file://<dir>`: what goes in `sources.yaml` for this upstream. */
  url: string;
  /** The initial commit; `HEAD` of the branch `main`. */
  commit: string;
}

/**
 * Runs `git <args>` in `dir` with the pinned identity and dates, and returns trimmed stdout. Like production
 * git, it does not pass on the variables that locate a repository (see `gitEnv`), so a test run started
 * from a git hook cannot make it act on the caller's repository. For test
 * set-up that is not covered by `makeUpstream` and `commitUpstream` (tags, branches). Rejects with the
 * stderr in the message if git fails.
 */
export async function runGit(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir, env: { ...gitEnv(), ...PINNED_ENV } });
  return stdout.trim();
}

/**
 * Creates a git repository in a fresh directory under `os.tmpdir()` with the default branch `main`, writes
 * `files` (same shape as for `makeProject`) and commits them as one commit.
 */
export async function makeUpstream(files: Record<string, ProjectFile>): Promise<Upstream> {
  const dir = await makeProject(files);
  await runGit(dir, ['init', '--quiet', '--initial-branch=main']);
  return { dir, url: `file://${dir}`, commit: await commitAll(dir) };
}

/**
 * Adds or overwrites `files` in the upstream at `dir` and commits the result on top of `HEAD`; a `null` value
 * deletes that file. Returns the new commit. A commit is made even when nothing changed.
 */
export async function commitUpstream(dir: string, files: Record<string, ProjectFile | null>): Promise<string> {
  const written: Record<string, ProjectFile> = {};
  for (const [rel, spec] of Object.entries(files)) {
    if (spec === null) {
      await rm(path.join(dir, ...rel.split('/')), { force: true });
    } else {
      written[rel] = spec;
    }
  }
  await writeFiles(dir, written);
  return commitAll(dir);
}

async function commitAll(dir: string): Promise<string> {
  await runGit(dir, ['add', '--all']);
  await runGit(dir, ['commit', '--quiet', '--allow-empty', '--message', 'ronin-test']);
  return runGit(dir, ['rev-parse', 'HEAD']);
}
