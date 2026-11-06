import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NAME_RE } from '../core/model.js';
import { COMMIT_RE, GitError, git, rejectOptionLike } from './git.js';

/** Temporary directories start with `.`, so they never collide with a commit directory. */
const TEMP_PREFIX = '.tmp-';

/**
 * Written to `.git/info/attributes` of the temporary repository, where it takes precedence over the
 * `.gitattributes` files in the fetched tree. Together with `CHECKOUT_ARGS` it makes the files on disk the
 * exact bytes of the committed blobs, whatever the user's git configuration says (`core.autocrlf`,
 * `core.eol`, clean/smudge filters such as git-lfs, `working-tree-encoding`, `$Id$` expansion).
 */
const VERBATIM_ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n';

/** `core.symlinks=false` would check a symbolic link out as a plain file and hide it from the symlink check. */
const CHECKOUT_ARGS = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.eol=lf',
  '-c',
  'core.symlinks=true',
  'checkout',
  '--quiet',
  '--detach',
  'FETCH_HEAD',
];

/**
 * Where the content of `source` at `commit` is cached: `<root>/.ronin/cache/<source>/<commit>` (spec 4).
 * Both parts become path segments, so a `source` that is not a valid name or a `commit` that is not 40
 * lowercase hex digits throws a `GitError`.
 */
export function cachePath(root: string, source: string, commit: string): string {
  if (!NAME_RE.test(source)) {
    throw new GitError(`invalid source name: ${JSON.stringify(source)}`);
  }
  if (!COMMIT_RE.test(commit)) {
    throw new GitError(`invalid commit id: ${JSON.stringify(commit)}`);
  }
  return path.join(root, '.ronin', 'cache', source, commit);
}

/**
 * Makes sure the repository `repo` at `commit` is checked out in `cachePath(root, source, commit)` and returns
 * that path. A cache directory that is already there is used as it is, without contacting `repo`.
 *
 * Otherwise the commit is fetched shallowly into a temporary sibling directory (`git init`,
 * `git fetch --depth 1 <repo> <commit>`, `git checkout --detach FETCH_HEAD`), checked to be at `commit`,
 * which is then renamed into place, so the cache path never holds a partial checkout. The files are the
 * committed bytes, unaffected by the user's git configuration (see `VERBATIM_ATTRIBUTES`). If a concurrent
 * run filled the cache path first, its content is used and the temporary directory is dropped. On any
 * failure the temporary directory is removed and a `GitError` is thrown. The checkout keeps its `.git`
 * directory.
 *
 * Throws `GitError` before touching the file system if `source` or `commit` is invalid (see `cachePath`) or
 * if `repo` begins with `-`.
 */
export async function ensureCommit(root: string, source: string, repo: string, commit: string): Promise<string> {
  const target = cachePath(root, source, commit);
  rejectOptionLike('repository', repo);

  const present = await lstat(target).catch(ignoreMissing);
  if (present !== null) {
    if (!present.isDirectory()) throw new GitError(`cache path is not a directory: ${target}`);
    return target;
  }

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(path.join(parent, TEMP_PREFIX));
  try {
    await git(['init', '--quiet'], temp);
    await writeVerbatimAttributes(temp);
    await git(['fetch', '--quiet', '--depth', '1', '--', repo, commit], temp);
    await git(CHECKOUT_ARGS, temp);
    const head = (await git(['rev-parse', 'HEAD'], temp)).trim();
    if (head !== commit) {
      throw new GitError(`expected the checkout to be at commit ${commit}, but it is at ${head}`);
    }
    await moveIntoPlace(temp, target);
  } catch (err) {
    await rm(temp, { recursive: true, force: true });
    if (err instanceof GitError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new GitError(`could not store ${source}@${commit} in the cache: ${reason}`);
  }
  return target;
}

async function writeVerbatimAttributes(repoDir: string): Promise<void> {
  const info = path.join(repoDir, '.git', 'info');
  await mkdir(info, { recursive: true });
  await writeFile(path.join(info, 'attributes'), VERBATIM_ATTRIBUTES);
}

/**
 * Renames `temp` to `target`. If that fails because `target` now exists (another run filled the cache in the
 * meantime), the other copy wins and `temp` is removed; any other failure is rethrown.
 */
async function moveIntoPlace(temp: string, target: string): Promise<void> {
  try {
    await rename(temp, target);
  } catch (err) {
    const winner = await lstat(target).catch(ignoreMissing);
    if (winner === null || !winner.isDirectory()) throw err;
    await rm(temp, { recursive: true, force: true });
  }
}

function ignoreMissing(err: unknown): null {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
  throw err;
}
