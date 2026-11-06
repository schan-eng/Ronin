/** Names of packs, agents, first-party skills, and sources (spec 5.1). */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The closed neutral tool vocabulary (spec 5.6). */
export const NEUTRAL_TOOLS = ['read', 'write', 'edit', 'search', 'shell', 'web-fetch', 'web-search'] as const;
export type NeutralTool = (typeof NEUTRAL_TOOLS)[number];

export type ModelTier = 'fast' | 'balanced' | 'strong';

export interface FileEntry {
  path: string;
  bytes: Uint8Array;
  executable: boolean;
}

/** Relative path -> contents. What an adapter's `render` returns. */
export type FileTree = Map<string, { bytes: Uint8Array; executable: boolean }>;

export interface AgentDef {
  pack: string;
  name: string;
  /** Path of the agent file, relative to the project root. */
  file: string;
  description: string;
  /** Skill references as written in the source: `name` or `<source>/<skill>`. */
  skills: string[];
  tools?: NeutralTool[];
  model?: ModelTier;
  /** Harness id -> harness-specific fields. */
  targets: Record<string, Record<string, unknown>>;
  body: string;
}

export interface PackDef {
  name: string;
  version: string;
  description: string;
  agents: AgentDef[];
}

export interface SourceDef {
  name: string;
  repo: string;
  ref: string;
  /** Folder in the source repository that holds skill directories. */
  root: string;
  /** Per-skill license assertions, keyed by skill name. */
  licenses: Record<string, { spdx: string; reason: string }>;
}

export interface FirstPartySkill {
  name: string;
  /** Skill directory, relative to the project root. */
  dir: string;
  description: string;
  frontmatter: Record<string, unknown>;
}

export interface Marketplace {
  name: string;
  owner: { name: string; email?: string; url?: string };
  description?: string;
}

export interface Project {
  root: string;
  marketplace: Marketplace;
  sources: Record<string, SourceDef>;
  packs: PackDef[];
  firstPartySkills: Record<string, FirstPartySkill>;
}

/** Where a resolved skill comes from (spec 5.5). A `fork` is a first-party skill that carries its own license file. */
export type SkillOrigin =
  | { kind: 'first-party' }
  | { kind: 'fork' }
  | { kind: 'third-party'; repo: string; commit: string; path: string };

/**
 * A skill with its files read, ready for an adapter (spec 8). A first-party skill is keyed by its name and a
 * third-party skill by `<source>/<skill>`.
 */
export interface ResolvedSkill {
  id: string;
  description: string;
  frontmatter: Record<string, unknown>;
  /** The skill directory, with paths relative to it. Symbolic links are never in here. */
  files: FileEntry[];
  origin: SkillOrigin;
  /**
   * Null when the repository license covers the skill. `spdx` is `NOASSERTION` when the license is unknown.
   * `file` is a path in `files`, or null when there is no license text to ship.
   */
  license: { spdx: string; file: string | null } | null;
}

/** A pack with the skills of all its agents, keyed by skill id. */
export interface ResolvedPack extends PackDef {
  skills: Record<string, ResolvedSkill>;
}

/** The project after resolution: plain data, with no knowledge of any adapter (spec 8). */
export interface ResolvedLibrary {
  marketplace: Marketplace;
  packs: ResolvedPack[];
}
