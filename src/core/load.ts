import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { error } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { NAME_RE } from './model.js';
import type { Marketplace, Project, SourceDef } from './model.js';
import { RoninYamlSchema, SourcesYamlSchema } from './schemas.js';
import { ParseError, parseYaml } from './yaml.js';
import type { ParsedYaml } from './yaml.js';

type PropertyPath = (string | number)[];

/**
 * Loads a project from `root`. Problems are returned as diagnostics, never thrown,
 * and loading continues past them so one run reports as much as it can. Callers
 * stop on errors before using the project: whatever failed to load is left empty
 * (for instance, the marketplace falls back to a placeholder with empty names).
 *
 * Each part of the project is loaded by its own function, appending to `diagnostics`.
 */
export async function loadProject(root: string): Promise<{ project: Project; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const marketplace = await loadMarketplace(root, diagnostics);
  const sources = await loadSources(root, diagnostics);
  const project: Project = { root, marketplace, sources, packs: [], firstPartySkills: {} };
  return { project, diagnostics };
}

async function loadMarketplace(root: string, diagnostics: Diagnostic[]): Promise<Marketplace> {
  const rel = 'ronin.yaml';
  const parsed = await readYamlFile(root, rel, diagnostics, { required: true });
  const config = parsed && validate(rel, parsed, RoninYamlSchema, diagnostics);
  return config ? config.marketplace : { name: '', owner: { name: '' } };
}

async function loadSources(root: string, diagnostics: Diagnostic[]): Promise<Record<string, SourceDef>> {
  const rel = 'sources.yaml';
  const parsed = await readYamlFile(root, rel, diagnostics, { required: false });
  if (!parsed) return {};

  // Checked on the raw keys, so a bad name is reported even when the file also has schema errors.
  const rawSources = isRecord(parsed.data) ? parsed.data['sources'] : undefined;
  const badNames = new Set<string>();
  if (isRecord(rawSources)) {
    for (const name of Object.keys(rawSources)) {
      if (NAME_RE.test(name)) continue;
      badNames.add(name);
      diagnostics.push(
        error('NAME', rel, `invalid source name "${name}": must match ${NAME_RE.source}`, parsed.lineOf(['sources', name])),
      );
    }
  }

  const config = validate(rel, parsed, SourcesYamlSchema, diagnostics);
  const sources: Record<string, SourceDef> = {};
  if (!config) return sources;
  for (const [name, def] of Object.entries(config.sources)) {
    if (badNames.has(name)) continue;
    sources[name] = { name, ...def };
  }
  return sources;
}

/**
 * Reads and parses a YAML file under `root`. A missing file is a `SCHEMA` error when
 * `required`, and otherwise just `undefined`. Malformed YAML is a `SCHEMA` error at the line
 * the parser reports. Returns `undefined` whenever there is nothing to validate.
 */
async function readYamlFile(
  root: string,
  rel: string,
  diagnostics: Diagnostic[],
  opts: { required: boolean },
): Promise<ParsedYaml | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(root, ...rel.split('/')), 'utf8');
  } catch (e) {
    if (!isNotFound(e)) throw e;
    if (opts.required) diagnostics.push(error('SCHEMA', rel, `${rel} is required but was not found`));
    return undefined;
  }
  try {
    return parseYaml(text);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    diagnostics.push(error('SCHEMA', rel, e.message, e.line));
    return undefined;
  }
}

/**
 * Validates parsed data against `schema`, turning each Zod issue into a `SCHEMA`
 * diagnostic located by `lineOf`. Returns the schema's output, or `undefined` if
 * there were issues. Works for `parseYaml` and `parseFrontmatter` results alike.
 */
function validate<S extends z.ZodType>(
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
function lineAt(parsed: Pick<ParsedYaml, 'lineOf'>, p: PropertyPath): number | undefined {
  for (let n = p.length; n > 0; n--) {
    const line = parsed.lineOf(p.slice(0, n));
    if (line !== undefined) return line;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(e: unknown): boolean {
  return e instanceof Error && 'code' in e && e.code === 'ENOENT';
}
