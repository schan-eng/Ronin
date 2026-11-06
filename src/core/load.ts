import { error } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';
import { loadFirstPartySkills } from './load-skills.js';
import { checkName, isRecord, lineAt, readDir, readFrontmatterFile, readYamlFile, validate } from './load-util.js';
import { NAME_RE, NEUTRAL_TOOLS } from './model.js';
import type { AgentDef, Marketplace, NeutralTool, PackDef, Project, SourceDef } from './model.js';
import { AgentFrontmatterSchema, PackYamlSchema, RoninYamlSchema, SourcesYamlSchema } from './schemas.js';

/** The longest agent description, in characters (spec 5.4). */
const MAX_DESCRIPTION_LENGTH = 300;

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
  const packs = await loadPacks(root, diagnostics);
  const firstPartySkills = await loadFirstPartySkills(root, diagnostics);
  const project: Project = { root, marketplace, sources, packs, firstPartySkills };
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
 * Loads every `packs/<dir>/pack.yaml` with the agents in `packs/<dir>/agents/`. A missing `packs/`
 * folder means no packs. A pack that fails `SCHEMA` or `NAME` is left out, but its agents are still
 * checked, so one run reports as much as it can.
 */
async function loadPacks(root: string, diagnostics: Diagnostic[]): Promise<PackDef[]> {
  const packs: PackDef[] = [];
  for (const entry of await readDir(root, 'packs', diagnostics)) {
    if (!entry.isDirectory()) continue;
    const pack = await loadPack(root, entry.name, diagnostics);
    if (pack) packs.push(pack);
  }
  return packs;
}

async function loadPack(root: string, dir: string, diagnostics: Diagnostic[]): Promise<PackDef | undefined> {
  const rel = `packs/${dir}/pack.yaml`;
  const parsed = await readYamlFile(root, rel, diagnostics, { required: true });
  const config = parsed && validate(rel, parsed, PackYamlSchema, diagnostics);
  // Checked on the raw value, so a wrong name is reported even when the file also has schema errors.
  const rawName = parsed && isRecord(parsed.data) ? parsed.data['name'] : undefined;
  const nameProblem =
    parsed !== undefined &&
    typeof rawName === 'string' &&
    checkName(rel, parsed.lineOf(['name']), diagnostics, {
      kind: 'pack',
      name: rawName,
      expected: dir,
      source: 'directory name',
    });

  const agents = await loadAgents(root, dir, diagnostics);
  return config && !nameProblem ? { ...config, agents } : undefined;
}

async function loadAgents(root: string, pack: string, diagnostics: Diagnostic[]): Promise<AgentDef[]> {
  const agents: AgentDef[] = [];
  for (const entry of await readDir(root, `packs/${pack}/agents`, diagnostics)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const agent = await loadAgent(root, pack, entry.name.slice(0, -'.md'.length), diagnostics);
    if (agent) agents.push(agent);
  }
  return agents;
}

/**
 * Loads `packs/<pack>/agents/<stem>.md`. Only `SCHEMA` and `NAME` problems leave the agent out. The
 * other rules (`DESCRIPTION`, `TOOL`, `DUPLICATE`, `HARNESS-SYNTAX`) report and keep it. Every check
 * reads the raw frontmatter, so it fires even when the agent also has a schema error.
 */
async function loadAgent(
  root: string,
  pack: string,
  stem: string,
  diagnostics: Diagnostic[],
): Promise<AgentDef | undefined> {
  const rel = `packs/${pack}/agents/${stem}.md`;
  const parsed = await readFrontmatterFile(root, rel, diagnostics, { required: true });
  if (!parsed) return undefined;

  const frontmatter = validate(rel, parsed, AgentFrontmatterSchema, diagnostics);
  const raw = isRecord(parsed.data) ? parsed.data : {};
  let excluded = frontmatter === undefined;

  const name = raw['name'];
  if (typeof name === 'string') {
    const what = { kind: 'agent', name, expected: stem, source: 'file name' } as const;
    if (checkName(rel, lineAt(parsed, ['name']), diagnostics, what)) excluded = true;
  }

  const description = raw['description'];
  if (typeof description === 'string') {
    const length = Array.from(description).length;
    if (description.trim() === '') {
      diagnostics.push(error('DESCRIPTION', rel, 'description must not be empty', lineAt(parsed, ['description'])));
    } else if (length > MAX_DESCRIPTION_LENGTH) {
      const message = `description is ${length} characters long: the limit is ${MAX_DESCRIPTION_LENGTH}`;
      diagnostics.push(error('DESCRIPTION', rel, message, lineAt(parsed, ['description'])));
    }
  }

  const seen = new Set<string>();
  for (const { value: ref, index } of stringItems(raw['skills'])) {
    const line = lineAt(parsed, ['skills', index]);
    if (!isSkillRef(ref)) {
      excluded = true;
      const message = `invalid skill reference ${JSON.stringify(ref)}: use <skill> or <source>/<skill>`;
      diagnostics.push(error('NAME', rel, `${message}, each part matching ${NAME_RE.source}`, line));
    } else if (seen.has(ref)) {
      const message = `skill reference ${JSON.stringify(ref)} is listed more than once`;
      diagnostics.push(error('DUPLICATE', rel, message, line));
    } else {
      seen.add(ref);
    }
  }

  const tools: NeutralTool[] = [];
  for (const { value: tool, index } of stringItems(raw['tools'])) {
    if (isNeutralTool(tool)) {
      tools.push(tool);
    } else {
      const message = `unknown tool ${JSON.stringify(tool)}: use one of ${NEUTRAL_TOOLS.join(', ')}`;
      diagnostics.push(error('TOOL', rel, message, lineAt(parsed, ['tools', index])));
    }
  }

  if (parsed.body.trim() === '') {
    excluded = true;
    diagnostics.push(error('SCHEMA', rel, 'the agent body (the system prompt after the frontmatter) is empty'));
  } else if (parsed.body.includes('${CLAUDE_')) {
    const message = 'the agent body contains "${CLAUDE_": adapters generate harness-specific syntax';
    diagnostics.push(error('HARNESS-SYNTAX', rel, `${message}, so it must not be written in source`));
  }

  if (!frontmatter || excluded) return undefined;
  const agent: AgentDef = {
    pack,
    name: frontmatter.name,
    file: rel,
    description: frontmatter.description,
    skills: frontmatter.skills ?? [],
    targets: frontmatter.targets ?? {},
    body: parsed.body,
  };
  if (frontmatter.tools) agent.tools = tools;
  if (frontmatter.model) agent.model = frontmatter.model;
  return agent;
}

/** `<skill>` or `<source>/<skill>`, each part a valid name. Anything else, `..` included, is not a reference. */
function isSkillRef(ref: string): boolean {
  const parts = ref.split('/');
  return parts.length <= 2 && parts.every((part) => NAME_RE.test(part));
}

function isNeutralTool(tool: string): tool is NeutralTool {
  return (NEUTRAL_TOOLS as readonly string[]).includes(tool);
}

/** The string items of `value` with their positions. A non-list, or a non-string item, is a schema error elsewhere. */
function stringItems(value: unknown): { value: string; index: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown, index) => (typeof item === 'string' ? [{ value: item, index }] : []));
}
