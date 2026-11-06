import type { FileEntry } from '../core/model.js';

/** The licenses a third-party skill may carry (spec 5.9). Anything else is `LICENSE-DISALLOWED`. */
export const ALLOWLIST: readonly string[] = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
  'CC-BY-4.0',
];

/** The names tried, in this order, for a license file in a skill directory and at the repository root. */
export const LICENSE_FILE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'] as const;

/** Where a detected license came from, in detection order (spec 5.9). */
export type LicenseFrom = 'asserted' | 'frontmatter' | 'skill-file' | 'repo-root';

export interface LicenseInput {
  /** The assertion in `sources.yaml`, if any. Returned as-is, without validation. */
  assertion?: { spdx: string };
  /** The `license` value from the skill's `SKILL.md` frontmatter, as parsed. Only a string can match. */
  frontmatterLicense?: unknown;
  /** Files of the skill directory, with paths relative to it. */
  skillFiles: FileEntry[];
  /** Files at the repository root, with paths relative to it. */
  repoRootFiles: FileEntry[];
}

export interface LicenseDetection {
  /** An SPDX identifier, or null when unknown. */
  license: string | null;
  /** The detection step that ended the search, or null when no step applied. */
  from: LicenseFrom | null;
  /** The license file name, for `skill-file` and `repo-root`. Null otherwise. */
  file: string | null;
}

const GNU_FAMILY = /GNU (AFFERO |LESSER )?GENERAL PUBLIC LICENSE\s+Version (\d)(\.\d)?/i;
const FRONTMATTER_GPL_FAMILY = /^(A|L)?GPL-\d/;

/**
 * Identifies a license from its standard text (spec 5.9), or returns null when the text is not
 * recognized. A leading UTF-8 BOM is removed and every run of whitespace (including CR and LF) is
 * collapsed to one space before matching, so a re-wrapped text is still recognized. The literal
 * phrases are case-sensitive; the GNU family match is not. The first match in this order wins:
 * Apache-2.0, MIT, BSD-3-Clause, BSD-2-Clause, ISC, CC0-1.0, CC-BY-4.0, then the GNU family.
 */
export function identifyLicenseText(text: string): string | null {
  const t = text.replace(/^\uFEFF/, '').replace(/\s+/g, ' ');
  if (t.includes('Apache License') && t.includes('Version 2.0')) return 'Apache-2.0';
  if (t.includes('Permission is hereby granted, free of charge, to any person obtaining a copy')) return 'MIT';
  if (t.includes('Redistribution and use in source and binary forms')) {
    return t.includes('Neither the name') ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  if (
    t.includes('Permission to use, copy, modify, and/or distribute this software for any purpose') &&
    t.includes('provided that the above copyright notice')
  ) {
    return 'ISC';
  }
  if (t.includes('CC0 1.0 Universal')) return 'CC0-1.0';
  if (t.includes('Attribution 4.0 International')) return 'CC-BY-4.0';
  return identifyGnu(t);
}

function identifyGnu(text: string): string | null {
  const match = GNU_FAMILY.exec(text);
  if (match === null) return null;
  const qualifier = match[1]?.trim().toUpperCase();
  const version = match[2];
  if (qualifier === 'AFFERO') return version === '3' ? 'AGPL-3.0' : null;
  if (qualifier === 'LESSER') return version === '2' ? 'LGPL-2.1' : version === '3' ? 'LGPL-3.0' : null;
  return version === '2' ? 'GPL-2.0' : version === '3' ? 'GPL-3.0' : null;
}

/**
 * Detects the license of a skill (spec 5.9). The first step that applies ends detection:
 * 1. the assertion, returned as-is;
 * 2. a string frontmatter `license` that equals an allowlisted id or matches `/^(A|L)?GPL-\d/`
 *    (other values, such as free text, fall through);
 * 3. the first of `LICENSE_FILE_NAMES` present in `skillFiles`;
 * 4. the same at the root of the repository, in `repoRootFiles`.
 *
 * In steps 3 and 4 only a top-level entry whose `path` equals the name exactly is a license file.
 * Its bytes are decoded as UTF-8 and identified by `identifyLicenseText`. If that file exists but its
 * text is not recognized, the license is null with `from` and `file` set: detection stops there and
 * does not fall through to the repository root.
 */
export function detectLicense(input: LicenseInput): LicenseDetection {
  if (input.assertion !== undefined) {
    return { license: input.assertion.spdx, from: 'asserted', file: null };
  }

  const declared = input.frontmatterLicense;
  if (typeof declared === 'string' && (ALLOWLIST.includes(declared) || FRONTMATTER_GPL_FAMILY.test(declared))) {
    return { license: declared, from: 'frontmatter', file: null };
  }

  return (
    fromLicenseFile(input.skillFiles, 'skill-file') ??
    fromLicenseFile(input.repoRootFiles, 'repo-root') ?? { license: null, from: null, file: null }
  );
}

function fromLicenseFile(files: FileEntry[], from: 'skill-file' | 'repo-root'): LicenseDetection | null {
  for (const name of LICENSE_FILE_NAMES) {
    const entry = files.find((f) => f.path === name);
    if (entry !== undefined) {
      return { license: identifyLicenseText(new TextDecoder().decode(entry.bytes)), from, file: name };
    }
  }
  return null;
}

/** True when `spdx` is exactly one of `ALLOWLIST`. */
export function isAllowed(spdx: string): boolean {
  return ALLOWLIST.includes(spdx);
}
