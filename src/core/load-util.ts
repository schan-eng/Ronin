import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { error } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { NAME_RE } from './model.js';
import { ParseError, parseFrontmatter, parseYaml } from './yaml.js';
import type { ParsedFrontmatter, ParsedYaml } from './yaml.js';

// Helpers shared by the loaders (`load.ts`, `load-skills.ts`). Each appends problems to a
// `diagnostics` list rather than throwing.

type PropertyPath = (string | number)[];

/** The `SCHEMA` message for a symbolic link: the source tree must not pull in files from elsewhere. */
export const SYMLINK_MESSAGE = 'symbolic links are not allowed in the source tree';

/**
 * Reports a `NAME` error and returns true if `name` is not a valid name, or does not equal `expected`
 * (the name of its directory or file). The two checks are exclusive: a name that is invalid
 * cannot also be said to differ.
 */
export function checkName(
  rel: string,
  line: number | undefined,
  diagnostics: Diagnostic[],
  what: { kind: 'pack' | 'agent' | 'skill'; name: string; expected: string; source: 'directory name' | 'file name' },
): boolean {
  const { kind, name, expected, source } = what;
  if (!NAME_RE.test(name)) {
    const message = `invalid ${kind} name ${JSON.stringify(name)}: must match ${NAME_RE.source}`;
    diagnostics.push(error('NAME', rel, message, line));
    return true;
  }
  if (name !== expected) {
    const message = `${kind} name ${JSON.stringify(name)} must equal its ${source} ${JSON.stringify(expected)}`;
    diagnostics.push(error('NAME', rel, message, line));
    return true;
  }
  return false;
}

/**
 * Reads and parses a YAML file under `root`. A missing file is a `SCHEMA` error when
 * `required`, and otherwise just `undefined`. Malformed YAML is a `SCHEMA` error at the line
 * the parser reports. Returns `undefined` whenever there is nothing to validate.
 */
export function readYamlFile(
  root: string,
  rel: string,
  diagnostics: Diagnostic[],
  opts: { required: boolean },
): Promise<ParsedYaml | undefined> {
  return readParsed(root, rel, diagnostics, opts, parseYaml);
}

/** Like `readYamlFile`, for a Markdown file that starts with a YAML frontmatter block. */
export function readFrontmatterFile(
  root: string,
  rel: string,
  diagnostics: Diagnostic[],
  opts: { required: boolean },
): Promise<ParsedFrontmatter | undefined> {
  return readParsed(root, rel, diagnostics, opts, parseFrontmatter);
}

export async function readParsed<T>(
  root: string,
  rel: string,
  diagnostics: Diagnostic[],
  opts: { required: boolean },
  parse: (text: string) => T,
): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(root, ...rel.split('/')), 'utf8');
  } catch (e) {
    if (!isNotFound(e)) throw e;
    if (opts.required) diagnostics.push(error('SCHEMA', rel, `${rel} is required but was not found`));
    return undefined;
  }
  try {
    return parse(text);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    diagnostics.push(error('SCHEMA', rel, e.message, e.line));
    return undefined;
  }
}

/**
 * The entries of directory `rel` under `root`, in plain string order of name, or none if it does not
 * exist. A symbolic link is reported as a `SCHEMA` error and left out: the source tree must not
 * pull in files from elsewhere.
 */
export async function readDir(root: string, rel: string, diagnostics: Diagnostic[]): Promise<Dirent[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, ...rel.split('/')), { withFileTypes: true });
  } catch (e) {
    if (!isNotFound(e)) throw e;
    return [];
  }
  const kept: Dirent[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      diagnostics.push(error('SCHEMA', `${rel}/${entry.name}`, SYMLINK_MESSAGE));
    } else {
      kept.push(entry);
    }
  }
  return kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Validates parsed data against `schema`, turning each Zod issue into a `SCHEMA`
 * diagnostic located by `lineOf`. Returns the schema's output, or `undefined` if
 * there were issues. Works for `parseYaml` and `parseFrontmatter` results alike.
 */
export function validate<S extends z.ZodType>(
  rel: string,
  parsed: ParsedYaml,
  schema: S,
  diagnostics: Diagnostic[],
): z.output<S> | undefined {
  const result = schema.safeParse(parsed.data);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const issuePath = issue.path.map((p): string | number => (typeof p === 'symbol' ? String(p) : p));
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const keyPath = [...issuePath, key];
        diagnostics.push(
          error('SCHEMA', rel, `unknown key "${keyPath.join('.')}"`, lineAt(parsed, keyPath)),
        );
      }
      continue;
    }
    const where = issuePath.join('.');
    const message = where === '' ? issue.message : `${where}: ${issue.message}`;
    diagnostics.push(error('SCHEMA', rel, message, lineAt(parsed, issuePath)));
  }
  return undefined;
}

/**
 * The line of the entry at `p`, or of its nearest ancestor that has one (a missing
 * field is reported at the key that should have contained it). File-level problems have no line.
 */
export function lineAt(parsed: Pick<ParsedYaml, 'lineOf'>, p: PropertyPath): number | undefined {
  for (let n = p.length; n > 0; n--) {
    const line = parsed.lineOf(p.slice(0, n));
    if (line !== undefined) return line;
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNotFound(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT';
}
