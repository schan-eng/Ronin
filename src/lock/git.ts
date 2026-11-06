import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A full commit id: 40 lowercase hex digits. */
export const COMMIT_RE = /^[0-9a-f]{40}$/;

/** `ls-remote` prints one line per ref; a big repository can have many. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * The variables git sets for its hooks to say which repository to work on: the set `git rev-parse
 * --local-env-vars` prints, plus `GIT_ALLOW_PROTOCOL`, which would override `-c protocol.ext.allow=never`.
 * They are not passed on, so a git process started by ronin acts on the directory it is given (`cwd`, or
 * the remote it is told to fetch) and never on the repository ronin itself was started from.
 */
const SCRUBBED_ENV = [
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
  'GIT_ALLOW_PROTOCOL',
] as const;

/**
 * The environment every git process of ronin runs with: a copy of `process.env` without `SCRUBBED_ENV`, and
 * with `GIT_TERMINAL_PROMPT=0`. Exported for the test helpers, which must not touch the caller's repository
 * either.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const name of SCRUBBED_ENV) delete env[name];
  return env;
}

/** A failed git invocation, or an input that is refused before git runs. */
export class GitError extends Error {
  /** Trimmed stderr of the failed command; empty when git did not run or printed nothing. */
  readonly stderr: string;

  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.stderr = stderr;
  }
}

/**
 * Runs `git <args>` (never through a shell) and returns its stdout, unmodified. Rejects with a `GitError`
 * that carries stderr when git cannot be started or exits non-zero.
 *
 * `sources.yaml` and `ronin.lock` can come from a contributor's pull request, so every call runs with the
 * `ext::` transport disabled (it runs arbitrary commands) and with `GIT_TERMINAL_PROMPT=0` (a CI job must
 * fail, not wait for a password). `process.env` is inherited except for what `gitEnv` removes (the
 * variables that locate a repository, and `GIT_ALLOW_PROTOCOL`); other `GIT_*` variables such as
 * `GIT_SSH_COMMAND` and `GIT_ASKPASS` pass through.
 */
export async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'protocol.ext.allow=never', ...args], {
      cwd,
      env: gitEnv(),
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return stdout;
  } catch (err) {
    const failure = err as { stderr?: unknown; code?: unknown; signal?: unknown };
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
    // Neither the arguments nor execFile's own message ("Command failed: git <args>") go in the message: a
    // repository URL can carry credentials.
    throw new GitError(`git ${subcommand(args)} failed: ${stderr !== '' ? stderr : describe(failure)}`, stderr);
  }
}

/** The git subcommand in `args`, skipping leading `-c <name>=<value>` pairs. */
function subcommand(args: string[]): string {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args[i] ?? '';
}

/** What is known about a failure that printed nothing to stderr, without repeating the command line. */
function describe(failure: { code?: unknown; signal?: unknown }): string {
  if (typeof failure.code === 'number') return `exit code ${failure.code}`;
  if (typeof failure.signal === 'string') return `killed by ${failure.signal}`;
  if (typeof failure.code === 'string') return `error ${failure.code}`;
  return 'unknown error';
}

/**
 * Throws a `GitError` when `value` begins with `-`. A repository or ref like that would be read by git as an
 * option (for example `--upload-pack=<command>`), so it is refused before any git process starts.
 */
export function rejectOptionLike(what: string, value: string): void {
  if (value.startsWith('-')) {
    throw new GitError(`${what} must not start with "-": ${JSON.stringify(value)}`);
  }
}

/**
 * Resolves `ref` in the remote repository `repo` to a commit id (spec 5.7). A 40-hex `ref` is returned
 * unchanged, without contacting the repository. Otherwise `git ls-remote` is asked for the three names
 * below, and the first that exists is taken: the branch `refs/heads/<ref>`, the commit an annotated tag
 * points to (`refs/tags/<ref>^{}`), then the tag itself (`refs/tags/<ref>`). Names that only end in one
 * of these (such as `refs/heads/feature/<ref>`) are ignored.
 * Throws `GitError` if nothing matches, if git fails, or if `repo` or `ref` begins with `-`.
 */
export async function resolveRef(repo: string, ref: string): Promise<string> {
  rejectOptionLike('repository', repo);
  rejectOptionLike('ref', ref);
  if (COMMIT_RE.test(ref)) return ref;

  // With patterns, `ls-remote` omits the peeled `^{}` line of an annotated tag unless a pattern names it.
  const listing = await git([
    'ls-remote',
    '--',
    repo,
    `refs/heads/${ref}`,
    `refs/tags/${ref}`,
    `refs/tags/${ref}^{}`,
  ]);
  const commits = new Map<string, string>();
  for (const line of listing.split('\n')) {
    if (line === '') continue;
    const [id, name] = line.split('\t');
    if (id === undefined || name === undefined || !COMMIT_RE.test(id)) {
      throw new GitError(`unexpected output from git ls-remote: ${JSON.stringify(line)}`);
    }
    commits.set(name, id);
  }

  const commit =
    commits.get(`refs/heads/${ref}`) ?? commits.get(`refs/tags/${ref}^{}`) ?? commits.get(`refs/tags/${ref}`);
  if (commit === undefined) {
    throw new GitError(`ref ${JSON.stringify(ref)} not found in the remote repository`);
  }
  return commit;
}
