import { z } from 'zod';

/** A string with at least one non-whitespace character. */
const nonBlank = z.string().refine((s) => s.trim() !== '', 'must not be empty');

/** `ronin.yaml` (spec 5.2). `marketplace.description` is an addition: `claude plugin validate` warns without one. */
export const RoninYamlSchema = z.strictObject({
  marketplace: z.strictObject({
    name: nonBlank,
    owner: z.strictObject({
      name: nonBlank,
      email: z.string().optional(),
      url: z.string().optional(),
    }),
    description: z.string().optional(),
  }),
});

const LicenseAssertionSchema = z.strictObject({
  spdx: nonBlank,
  reason: nonBlank,
});

/**
 * Why a source `root` may not be used, or `undefined` if it is fine. `root` is joined onto a checkout
 * of the source repository, so it must stay inside it: no absolute paths (POSIX, Windows drive,
 * or backslash-rooted) and no `..` segment, written with either separator.
 */
function rootProblem(root: string): string | undefined {
  if (root.startsWith('/') || root.startsWith('\\') || /^[A-Za-z]:/.test(root)) {
    return 'root must be a relative path inside the source repository, not an absolute path';
  }
  if (root.split(/[\\/]/).includes('..')) {
    return 'root must stay inside the source repository: a ".." path segment is not allowed';
  }
  return undefined;
}

const SourceSchema = z.strictObject({
  repo: nonBlank,
  ref: nonBlank,
  root: z
    .string()
    .check((ctx) => {
      const problem = rootProblem(ctx.value);
      if (problem) ctx.issues.push({ code: 'custom', message: problem, input: ctx.value });
    })
    .default('.'),
  licenses: z.record(z.string(), LicenseAssertionSchema).default({}),
});

/** `sources.yaml` (spec 5.7). Source names are checked against `NAME_RE` by the loader, not here. */
export const SourcesYamlSchema = z.strictObject({
  sources: z.record(z.string(), SourceSchema),
});

/** `packs/<pack>/pack.yaml` (spec 5.3). `name` is checked against the directory name (rule `NAME`) by the loader. */
export const PackYamlSchema = z.strictObject({
  name: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be MAJOR.MINOR.PATCH, for example 0.1.0'),
  description: nonBlank,
});

/**
 * Agent frontmatter (spec 5.4). The rules that have their own ids are checked by the loader, not here, so
 * they report as such: `name` (NAME), `description` length (DESCRIPTION), `tools` vocabulary (TOOL),
 * and the shape and uniqueness of `skills` (NAME, DUPLICATE).
 */
export const AgentFrontmatterSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  skills: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  // Mirrors `ModelTier` in model.ts.
  model: z.enum(['fast', 'balanced', 'strong']).optional(),
  // Harness id -> harness-specific fields. The fields are checked by the adapter.
  targets: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

/**
 * First-party `skills/<dir>/SKILL.md` frontmatter (spec 5.5). Only `name` and `description` are required; any
 * other key is kept as written, since the open Agent Skills format defines more (`license`, `allowed-tools`,
 * and so on). `name` is checked against the directory name (rule `NAME`) by the loader.
 */
export const SkillFrontmatterSchema = z.looseObject({
  name: z.string(),
  description: nonBlank,
});

export type RoninYaml = z.output<typeof RoninYamlSchema>;
export type SourcesYaml = z.output<typeof SourcesYamlSchema>;
export type PackYaml = z.output<typeof PackYamlSchema>;
export type AgentFrontmatter = z.output<typeof AgentFrontmatterSchema>;
export type SkillFrontmatter = z.output<typeof SkillFrontmatterSchema>;
