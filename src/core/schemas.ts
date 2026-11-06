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

const SourceSchema = z.strictObject({
  repo: nonBlank,
  ref: nonBlank,
  root: z.string().default('.'),
  licenses: z.record(z.string(), LicenseAssertionSchema).default({}),
});

/** `sources.yaml` (spec 5.7). Source names are checked against `NAME_RE` by the loader, not here. */
export const SourcesYamlSchema = z.strictObject({
  sources: z.record(z.string(), SourceSchema),
});

export type RoninYaml = z.output<typeof RoninYamlSchema>;
export type SourcesYaml = z.output<typeof SourcesYamlSchema>;
