# Ronin v1 Format and Claude Code Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `ronin` maintainer CLI. It reads packs of specialist agents (each owning a curated set of skills), pins third-party skills in a lockfile with license checks, and builds each pack into a Claude Code plugin whose skills live in a private library that only that agent sees.

**Architecture:** `src/core` loads and validates the source format into plain data (`Project`), then resolves skills into a `ResolvedLibrary`. `src/lock` handles git fetching, the content cache, hashing, license detection, and the lockfile. `src/adapters/claude-code` is a pure `ResolvedLibrary → FileTree` function plus its own target-field validation. `src/cli` wires the commands, writes files, and runs the `check` comparisons.

**Tech Stack:** TypeScript (ES modules, strict) on Node ≥ 20. Runtime dependencies: `yaml`, `zod`. Dev dependencies: `typescript`, `vitest`, `tsx`, `@types/node`. Git is invoked via `node:child_process` `execFile`.

**Spec:** `docs/superpowers/specs/2026-11-05-ronin-format-claude-code-adapter-design.md`. Read it alongside this plan; section numbers below (§) refer to it.

## Global Constraints

- `package.json`: `"type": "module"`, `"private": true`, `"engines": { "node": ">=20" }`. Scripts: `"ronin": "tsx src/cli/bin.ts"`, `"test": "vitest run"`, `"typecheck": "tsc --noEmit"`.
- The CLI is invoked as `npm run ronin -- <command> [--root <dir>]`. `--root` defaults to the current directory.
- Names (pack, agent, first-party skill, source): `^[a-z0-9][a-z0-9-]{0,63}$`.
- Agent `description`: 1 to 300 characters.
- License allowlist, exactly: `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `CC0-1.0`, `CC-BY-4.0`.
- Neutral tools → Claude Code tools: `read`→`Read`, `write`→`Write`, `edit`→`Edit`, `search`→`Grep`+`Glob`, `shell`→`Bash`, `web-fetch`→`WebFetch`, `web-search`→`WebSearch`.
- Model tiers: `fast`→`haiku`, `balanced`→`sonnet`, `strong`→`opus`.
- Pack versions are `MAJOR.MINOR.PATCH` only (regex `^\d+\.\d+\.\d+$`).
- Diagnostic line format: `<path>[:<line>]: <error|warning> <RULE-ID>: <message>`. Paths are relative to the project root, with `/` separators. Diagnostics are printed to stderr.
- Exit codes: 0 no errors (warnings allowed); 1 one or more errors; 2 usage error, git failure, or unexpected exception.
- Output determinism:
  - LF line endings; JSON and YAML use 2-space indentation and the fixed key orders defined in Task 6.
  - No timestamps or absolute paths.
  - File modes are 0644 or 0755 only.
  - Path sorting is by plain string comparison (`a < b`), never `localeCompare`.
- Plugin name `ronin-<pack>`. Marketplace entries carry `name`, `source`, `description` only, with no `version` (Claude Code warns when both entry and `plugin.json` set it).
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Symlinks inside a skill directory** (common in upstream repos) must never be followed or copied, so dist can't pick up files from outside the skill. Expected: a `SCHEMA` error naming the link. Tested in Task 3 and Task 5.
2. **Files with CRLF line endings or a UTF-8 BOM** (authored on Windows) must parse like LF files. Tested in Task 1.
3. **Agent descriptions containing YAML-significant text** (`: `, `#`, quotes) must produce valid frontmatter that round-trips. Tested in Task 6.
4. **Skill descriptions containing `|` or newlines** must not break the index table. Tested in Task 6 and exercised by the golden fixture.
5. **Skill references that try path traversal** (`upstream/../x`, `../x`) must be rejected before any filesystem access. Expected: a `NAME` error. Tested in Task 2.

---

### Task 1: Scaffold, diagnostics, YAML and frontmatter parsing

**Files:**
- Create: `package.json`, `package-lock.json` (via `npm install`), `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/diagnostics.ts`, `src/core/yaml.ts`, `test/helpers/fs.ts`
- Test: `test/core/diagnostics.test.ts`, `test/core/yaml.test.ts`

**Interfaces:**
- Produces:
  - `type RuleId = 'SCHEMA'|'NAME'|'DUPLICATE'|'DESCRIPTION'|'TOOL'|'SKILL-UNRESOLVED'|'SKILL-COLLISION'|'LOCK-STALE'|'LICENSE-UNKNOWN'|'LICENSE-DISALLOWED'|'HASH-MISMATCH'|'HARNESS-SYNTAX'|'TARGET-FIELD'|'DIST-STALE'|'VERSION-NOT-BUMPED'|'DROPPED-FEATURE'|'SCRIPTS-NO-SHELL'|'NO-LICENSE-TEXT'`
  - `interface Diagnostic { path: string; line?: number; severity: 'error'|'warning'; rule: RuleId; message: string }`
  - `error(rule: RuleId, path: string, message: string, line?: number): Diagnostic` and `warning(...)` with the same signature
  - `formatDiagnostic(d: Diagnostic): string`, `sortDiagnostics(ds: Diagnostic[]): Diagnostic[]`, `hasErrors(ds: Diagnostic[]): boolean`
  - `class UsageError extends Error` (maps to exit 2)
  - `class ParseError extends Error { line: number }`
  - `parseYaml(text: string): { data: unknown; lineOf(path: (string|number)[]): number | undefined }`, which throws `ParseError`
  - `parseFrontmatter(text: string): { data: unknown; body: string; lineOf(path: (string|number)[]): number | undefined }`, which throws `ParseError`. `lineOf` returns 1-based line numbers within the whole file.
  - `makeProject(files: Record<string, string | { content: string | Uint8Array; executable?: boolean }>): Promise<string>`, which writes files under a fresh `os.tmpdir()` directory and returns its path
  - `enc(s: string): Uint8Array` (UTF-8 encode, used across tests); lives in `test/helpers/fs.ts`

- [ ] **Step 1: Scaffold the package**

Create the files above:
- `tsconfig.json` uses `strict`, `module`/`moduleResolution` `NodeNext`, `target` `ES2022`, `noEmit`, and includes `src` and `test`.
- `vitest.config.ts` includes `test/**/*.test.ts`.
- `.gitignore` lists `node_modules/` and `/.ronin/cache/`. The cache entry is root-anchored so that fixture caches under `test/fixtures/` are committed.

Run `npm install yaml zod && npm install -D typescript vitest tsx @types/node`.

- [ ] **Step 2: Write the failing tests**

```ts
// test/core/diagnostics.test.ts
expect(formatDiagnostic(error('TOOL', 'packs/web/agents/a.md', 'unknown tool "fly"', 3)))
  .toBe('packs/web/agents/a.md:3: error TOOL: unknown tool "fly"');
expect(formatDiagnostic(warning('DROPPED-FEATURE', 'ronin.lock', 'x')))
  .toBe('ronin.lock: warning DROPPED-FEATURE: x');
// sortDiagnostics: by path, then line (missing line sorts first)
expect(sortDiagnostics([error('NAME','b',''), error('NAME','a','',5), error('NAME','a','')]).map(d => [d.path, d.line]))
  .toEqual([['a', undefined], ['a', 5], ['b', undefined]]);
expect(hasErrors([warning('NAME','a','')])).toBe(false);

// test/core/yaml.test.ts
const fm = parseFrontmatter('---\nname: a\ndescription: b\n---\nBody\n');
expect(fm.data).toEqual({ name: 'a', description: 'b' });
expect(fm.body).toBe('Body\n');
expect(fm.lineOf(['description'])).toBe(3);
// Review Focus 2: CRLF + BOM
const crlf = parseFrontmatter('﻿---\r\nname: a\r\n---\r\nBody\r\n');
expect(crlf.data).toEqual({ name: 'a' });
expect(crlf.body).toBe('Body\n');
expect(() => parseFrontmatter('no frontmatter')).toThrow(ParseError);   // line 1
expect(() => parseYaml('a: [1,\n')).toThrow(ParseError);
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run test/core`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `src/core/diagnostics.ts` and `src/core/yaml.ts`, plus `test/helpers/fs.ts`**

- Strip a leading BOM and normalize `\r\n` to `\n` before parsing.
- Line numbers come from the `yaml` package's `parseDocument` with a `LineCounter`, via `doc.getIn(path, true)?.range`. Frontmatter lines are offset by 1 for the opening `---`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/core && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold ronin CLI with diagnostics and YAML parsing"
```

---

### Task 2: Load and validate the source format

**Files:**
- Create: `src/core/model.ts`, `src/core/schemas.ts`, `src/core/load.ts`
- Test: `test/core/load.test.ts`

**Interfaces:**
- Consumes (Task 1): `Diagnostic`, `error`, `parseYaml`, `parseFrontmatter`, `ParseError`, `makeProject`
- Produces (`src/core/model.ts`):
  - `NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/`
  - `NEUTRAL_TOOLS = ['read','write','edit','search','shell','web-fetch','web-search'] as const`, plus `type NeutralTool`
  - `type ModelTier = 'fast'|'balanced'|'strong'`
  - `interface FileEntry { path: string; bytes: Uint8Array; executable: boolean }`
  - `type FileTree = Map<string, { bytes: Uint8Array; executable: boolean }>`
  - `interface AgentDef { pack: string; name: string; file: string; description: string; skills: string[]; tools?: NeutralTool[]; model?: ModelTier; targets: Record<string, Record<string, unknown>>; body: string }`. `file` is relative to the root.
  - `interface PackDef { name: string; version: string; description: string; agents: AgentDef[] }`
  - `interface SourceDef { name: string; repo: string; ref: string; root: string; licenses: Record<string, { spdx: string; reason: string }> }`
  - `interface FirstPartySkill { name: string; dir: string; description: string; frontmatter: Record<string, unknown> }`. `dir` is relative to the root.
  - `interface Marketplace { name: string; owner: { name: string; email?: string; url?: string }; description?: string }`
  - `interface Project { root: string; marketplace: Marketplace; sources: Record<string, SourceDef>; packs: PackDef[]; firstPartySkills: Record<string, FirstPartySkill> }`
- Produces (`src/core/load.ts`): `loadProject(root: string): Promise<{ project: Project; diagnostics: Diagnostic[] }>`

Behavior notes:
- `ronin.yaml` is required. It may also hold an optional `marketplace.description` (an addition to §5.2, emitted to `marketplace.json` because `claude plugin validate` warns without one).
- `sources.yaml` and `packs/` are optional (missing means none). `root` defaults to `"."` and `licenses` to `{}`.
- Agents, packs, and skills that fail `SCHEMA` or `NAME` are left out of `project`, so later stages see only valid items.
- Skill references are validated here: a bare reference must match `NAME_RE`; `a/b` must have both parts match `NAME_RE`; anything else is a `NAME` error.
- First-party skills are every `skills/<dir>/SKILL.md`.
- Zod schemas are `.strict()` for `ronin.yaml`, `pack.yaml`, `sources.yaml`, and agent frontmatter. First-party `SKILL.md` frontmatter only requires `name` and `description` and allows other keys.
- `targets` must be a map of objects. Their contents are checked by the adapter in Task 6.
- Within one pack, agent names are unique by construction (`name` must equal the file name), so `DUPLICATE` fires only for repeated skill references.

- [ ] **Step 1: Write the failing tests**

Build a valid base project with `makeProject`, then apply one change per test:

```ts
const base = {
  'ronin.yaml': 'marketplace:\n  name: ronin\n  owner:\n    name: t\n',
  'packs/web/pack.yaml': 'name: web\nversion: 0.1.0\ndescription: Web.\n',
  'packs/web/agents/frontend.md': '---\nname: frontend\ndescription: UI work.\nskills: [react]\ntools: [read, shell]\nmodel: strong\n---\nYou build UI.\n',
  'skills/react/SKILL.md': '---\nname: react\ndescription: React patterns.\n---\nUse hooks.\n',
};
test('valid project loads clean', ...)        // diagnostics == []; agent.tools == ['read','shell']; agent.model == 'strong'
test('missing ronin.yaml → SCHEMA at ronin.yaml', ...)
test('unknown agent key → SCHEMA with line', ...)   // add 'colour: red' at line 4 → {rule:'SCHEMA', line:4}
test('NAME rules', ...)       // file Frontend.md; name≠filename; pack dir≠pack.yaml name; skill dir≠SKILL.md name
test('Review Focus 5: traversal refs → NAME', ...)  // skills: ['upstream/../x', '../x', 'a/b/c'] → three NAME errors, no fs access
test('DUPLICATE skill ref', ...)               // skills: [react, react]
test('DESCRIPTION bounds', ...)                // '' and 'x'.repeat(301) → DESCRIPTION; 'x'.repeat(300) ok
test('TOOL unknown', ...)                      // tools: [read, fly] → TOOL mentioning "fly"
test('HARNESS-SYNTAX', ...)                    // body contains '${CLAUDE_PLUGIN_ROOT}/x'
test('SCHEMA: bad model, bad version, empty license reason', ...)  // model: huge; version: '1.0'; licenses.x.reason: ''
test('missing packs/ and sources.yaml → no packs, no sources, no diagnostics', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/load.test.ts`
Expected: FAIL (`loadProject` not defined).

- [ ] **Step 3: Implement `model.ts`, `schemas.ts`, and `loadProject` in `load.ts`**

Map Zod issue paths to lines with `lineOf`. Report a `ParseError` as `SCHEMA` at its line.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/core && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): load and validate packs, agents, skills, and sources"
```

---

### Task 3: Skill files, content hashing, license detection

**Files:**
- Create: `src/core/files.ts`, `src/lock/hash.ts`, `src/lock/license.ts`
- Test: `test/core/files.test.ts`, `test/lock/hash.test.ts`, `test/lock/license.test.ts`

**Interfaces:**
- Consumes: `FileEntry`, `makeProject`
- Produces:
  - `readTree(dir: string): Promise<{ files: FileEntry[]; symlinks: string[] }>`. Recursive; skips `.git`; sorted by path. A symlink is never followed. It is listed in `symlinks` and excluded from `files`. `executable` means any execute bit is set.
  - `hashSkillFiles(files: FileEntry[]): string`
  - `ALLOWLIST: readonly string[]`, `LICENSE_FILE_NAMES = ['LICENSE','LICENSE.md','LICENSE.txt','COPYING']`
  - `type LicenseFrom = 'asserted'|'frontmatter'|'skill-file'|'repo-root'`
  - `identifyLicenseText(text: string): string | null`
  - `detectLicense(input: { assertion?: { spdx: string }; frontmatterLicense?: unknown; skillFiles: FileEntry[]; repoRootFiles: FileEntry[] }): { license: string | null; from: LicenseFrom | null; file: string | null }`. `file` is the matched file name: within the skill directory for `skill-file`, at the repo root for `repo-root`, and null otherwise.
  - `isAllowed(spdx: string): boolean`

Hash algorithm (§5.8): sort files by path, then take the SHA-256 hex digest of the concatenation of `` `${path}\0${executable ? '1' : '0'}\0${sha256hex(bytes)}\n` `` for each file.

License text identification (first match wins):

| Result | Text must contain |
|---|---|
| `Apache-2.0` | `Apache License` and `Version 2.0` |
| `MIT` | `Permission is hereby granted, free of charge, to any person obtaining a copy` |
| `BSD-3-Clause` | `Redistribution and use in source and binary forms` and `Neither the name` |
| `BSD-2-Clause` | `Redistribution and use in source and binary forms` (without `Neither the name`) |
| `ISC` | `Permission to use, copy, modify, and/or distribute this software for any purpose` and `provided that the above copyright notice` |
| `CC0-1.0` | `CC0 1.0 Universal` |
| `CC-BY-4.0` | `Attribution 4.0 International` |
| `AGPL-3.0` / `LGPL-2.1` / `LGPL-3.0` / `GPL-2.0` / `GPL-3.0` | regex `/GNU (AFFERO |LESSER )?GENERAL PUBLIC LICENSE\s+Version (\d)(\.\d)?/i` |

Anything else is `null` (unknown).

The frontmatter `license` value is used only when it exactly equals an allowlisted id or matches `/^(A|L)?GPL-\d/`. Any other value (free text such as "Complete terms in LICENSE.txt") falls through to the next detection step.

- [ ] **Step 1: Write the failing tests**

```ts
// hash.test.ts: pinned value
const files = [
  { path: 'scripts/run.sh', bytes: enc('echo hi\n'), executable: true },
  { path: 'SKILL.md', bytes: enc('---\nname: a\ndescription: b\n---\nBody\n'), executable: false },
];
expect(hashSkillFiles(files)).toBe('86b40829bf2ebc1f5849bd275577440eeecab5898326093a5322d7153d326a94');
expect(hashSkillFiles([...files].reverse())).toBe(hashSkillFiles(files));       // input order irrelevant
// flipping executable on run.sh, or changing one byte, changes the hash

// files.test.ts
test('sorted, executable flag, skips .git', ...)
test('Review Focus 1: symlink is listed, not followed', ...)   // symlink 'evil' -> '/etc/hosts' → symlinks == ['evil'], files has no 'evil'

// license.test.ts
test('identifies each allowlisted text and GPL-3.0; random text → null', ...)
test('ISC requires the notice clause (0BSD-like text → null)', ...)
test('order: asserted > frontmatter > skill-file > repo-root', ...)
// {assertion:{spdx:'MIT'}, frontmatterLicense:'Apache-2.0', ...} → {license:'MIT', from:'asserted', file:null}
// frontmatter 'Complete terms in LICENSE.txt' + skill LICENSE.txt(MIT) → {license:'MIT', from:'skill-file', file:'LICENSE.txt'}
// no skill license file, repo-root LICENSE(Apache) → {license:'Apache-2.0', from:'repo-root', file:'LICENSE'}
// nothing → {license:null, from:null, file:null}
test('isAllowed', ...)  // 'MIT' true, 'GPL-3.0' false
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/files.test.ts test/lock`
Expected: FAIL.

- [ ] **Step 3: Implement `readTree`, `hashSkillFiles`, and `license.ts`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(lock): skill file reading, content hashing, license detection"
```

---

### Task 4: Git fetching, cache, lockfile, `lock` command

**Files:**
- Create: `src/lock/git.ts`, `src/lock/cache.ts`, `src/lock/lockfile.ts`, `src/lock/lock.ts`, `test/helpers/git.ts`
- Test: `test/lock/lockfile.test.ts`, `test/lock/lock.test.ts`

**Interfaces:**
- Consumes: `Project`, `loadProject`, `readTree`, `hashSkillFiles`, `detectLicense`, `isAllowed`, `UsageError`, `Diagnostic`
- Produces:
  - `class GitError extends Error`
  - `git(args: string[], cwd?: string): Promise<string>` (stdout)
  - `resolveRef(repo: string, ref: string): Promise<string>`. A 40-hex `ref` is returned unchanged. Otherwise use `git ls-remote <repo> <ref>`, preferring `refs/heads/<ref>`, then the peeled `refs/tags/<ref>^{}`, then `refs/tags/<ref>`. Throws `GitError` if nothing matches.
  - `cachePath(root: string, source: string, commit: string): string` (`<root>/.ronin/cache/<source>/<commit>`)
  - `ensureCommit(root: string, source: string, repo: string, commit: string): Promise<string>`. Returns the cache path, fetching if it is absent. The fetch goes into a temporary sibling directory: `git init`, `git fetch --depth 1 <repo> <commit>`, `git checkout --detach FETCH_HEAD`, then rename into place. On failure the temporary directory is removed and `GitError` is thrown.
  - `interface LockedSource { repo: string; ref: string; commit: string }`
  - `interface LockedSkill { path: string; sha256: string; license: string | null; licenseFrom: LicenseFrom | null; licenseFile?: string }`
  - `interface Lock { lockVersion: 1; sources: Record<string, LockedSource>; skills: Record<string, LockedSkill> }`
  - `readLock(root: string): Promise<{ lock: Lock; diagnostics: Diagnostic[] }>`. A missing file gives an empty lock. An invalid file gives a `SCHEMA` error at `ronin.lock`.
  - `serializeLock(lock: Lock): string` (YAML; `sources` and `skills` keys sorted; field order as in §5.8)
  - `runLock(project: Project, opts: { update: string[] }): Promise<Diagnostic[]>`. Writes `ronin.lock`. Throws `UsageError` when `--update` names an unknown source.
  - Test helpers: `makeUpstream(files): Promise<{ dir: string; url: string; commit: string }>` and `commitUpstream(dir: string, files): Promise<string>`. `url` is `file://<dir>`. Pin `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME=ronin-test`, the email variables, and `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE=2026-01-01T00:00:00Z` so commits are deterministic.

`runLock` behavior (§7):
- A source's commit is re-resolved only when the source is new to the lock, its `repo` or `ref` differs from the lock, or it is named in `update`. Otherwise the locked commit is kept.
- Only sources and skills referenced by at least one agent are written.
- Every referenced skill is re-hashed and its license re-detected from the cache on every run, so `sources.yaml` assertion changes are picked up.
- `licenseFile` is the path in the upstream repo: `<path>/<name>` for `skill-file`, `<name>` for `repo-root`, and omitted otherwise.
- Problems are reported as diagnostics: a missing `SKILL.md` gives `SKILL-UNRESOLVED` at `ronin.lock`, with the message `"<id>" not found at <commit>; referenced by <agent files, sorted, comma-separated>`. Unknown and disallowed licenses give `LICENSE-UNKNOWN` and `LICENSE-DISALLOWED`. A symlink gives `SCHEMA`.
- The lock is still written when the only problems are license problems. Skills that are `SKILL-UNRESOLVED` are left out of it.

- [ ] **Step 1: Write the failing tests**

```ts
// lockfile.test.ts
test('serialize is sorted and round-trips through readLock', ...)
test('missing ronin.lock → empty lock, no diagnostics', ...)

// lock.test.ts: upstream has LICENSE (MIT) at root and skills/greeting/SKILL.md
test('pins main to its commit and records hash + license', ...)
// lock.sources.upstream.commit === upstream.commit
// lock.skills['upstream/greeting'] == { path:'skills/greeting', sha256: hashSkillFiles(<cache files>),
//   license:'MIT', licenseFrom:'repo-root', licenseFile:'LICENSE' }
// cache file exists: .ronin/cache/upstream/<commit>/skills/greeting/SKILL.md
test('commit is sticky; update re-resolves', ...)   // commitUpstream → lock keeps old; {update:['upstream']} → new
test('ref change in sources.yaml re-resolves without update', ...)
test('40-hex ref is used as-is', ...)
test('only referenced skills are locked', ...)       // upstream has 2 skills, agents use 1
test('assertion → licenseFrom asserted', ...)
test('unknown license → lock written with license null + LICENSE-UNKNOWN', ...)
test('skill deleted upstream after update → SKILL-UNRESOLVED naming both agents', ...)
// message contains 'packs/web/agents/api.md, packs/web/agents/frontend.md'
test('bad repo URL → GitError and no cache dir left behind', ...)
test('update with unknown source → UsageError', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/lock`
Expected: FAIL.

- [ ] **Step 3: Implement `git.ts`, `cache.ts`, `lockfile.ts`, `lock.ts`, and the git helpers**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(lock): pin third-party skills with git cache and lockfile"
```

---

### Task 5: Resolve the library

**Files:**
- Create: `src/core/resolve.ts`
- Test: `test/core/resolve.test.ts`

**Interfaces:**
- Consumes: `Project`, `Lock`, `readLock`, `ensureCommit`, `readTree`, `hashSkillFiles`, `detectLicense`, `isAllowed`, `LICENSE_FILE_NAMES`
- Produces (add to `src/core/model.ts`):
  - `type SkillOrigin = { kind: 'first-party' } | { kind: 'fork' } | { kind: 'third-party'; repo: string; commit: string; path: string }`
  - `interface ResolvedSkill { id: string; description: string; frontmatter: Record<string, unknown>; files: FileEntry[]; origin: SkillOrigin; license: { spdx: string; file: string | null } | null }`. `license` is null when the skill is covered by the repository license. `license.file` is the path within `files`.
  - `interface ResolvedPack extends PackDef { skills: Record<string, ResolvedSkill> }` (the union of the pack's agents' skills, keyed by id)
  - `interface ResolvedLibrary { marketplace: Marketplace; packs: ResolvedPack[] }`
  - `resolveLibrary(project: Project, lock: Lock): Promise<{ library: ResolvedLibrary; diagnostics: Diagnostic[] }>`

Behavior (§5.5, §5.9, §6.6, §7.1):
- **First-party** skills come from `skills/<name>/`. If the directory contains a `LICENSE_FILE_NAMES` file, the origin is `fork`: its license is detected with `detectLicense` (skill file only) and checked against the allowlist. Otherwise the origin is `first-party` and `license` is null.
- **Third-party** skills come from the cache at the locked commit (`ensureCommit` fetches if missing) and use the license recorded in the lock. If the skill directory has no license file and the repo root has one, that root file is appended to `files` as `LICENSE`. If neither exists, the build warns `NO-LICENSE-TEXT` and `license.file` is null.
- **Diagnostic paths:**
  - agent file: `SKILL-UNRESOLVED` for a missing first-party skill or unknown source, `SCRIPTS-NO-SHELL`
  - `skills/<name>/SKILL.md`: `SKILL-COLLISION` and first-party license and `SCHEMA` problems
  - `ronin.lock`: third-party `LOCK-STALE`, `HASH-MISMATCH`, `LICENSE-*`, `DROPPED-FEATURE`, `NO-LICENSE-TEXT`
- **`LOCK-STALE`** fires when an agent needs a skill or source absent from the lock; when a source's `repo` or `ref` differs from the lock; or when a `sources.yaml` assertion for a locked skill doesn't match the lock (`licenseFrom` must be `asserted` with an equal `license`, and a lock entry marked `asserted` must still have its assertion).
- **`DROPPED-FEATURE`** fires once per skill and lists which of `allowed-tools`, `context`, `agent`, `paths`, `hooks` appear in its frontmatter. First-party skills report it at their `SKILL.md`.
- **`SCRIPTS-NO-SHELL`** fires only when the agent declares `tools` without `shell` and one of its skills has an executable file or a file whose directory path contains a `scripts` segment.

- [ ] **Step 1: Write the failing tests**

Third-party tests pre-populate `.ronin/cache/upstream/<40×'1'>/...` with `makeProject` and write a matching lock, so no git is needed. Only the "fetch missing commit" test uses `makeUpstream`.

```ts
test('first-party skill: origin first-party, license null', ...)
test('fork with MIT LICENSE: origin fork, license {spdx:"MIT", file:"LICENSE"}', ...)
test('fork with GPL-3 LICENSE → LICENSE-DISALLOWED at skills/x/SKILL.md', ...)
test('third-party with only repo-root LICENSE: LICENSE appended to files', ...)
test('shared skill appears once in pack.skills', ...)
test('SKILL-UNRESOLVED: missing first-party, unknown source', ...)
test('SKILL-COLLISION: first-party skill named like a source', ...)
test('LOCK-STALE: missing entry; ref changed; assertion changed', ...)
test('HASH-MISMATCH after editing a cached file', ...)
test('LICENSE-UNKNOWN (lock null) and LICENSE-DISALLOWED (lock "GPL-3.0")', ...)
test('DROPPED-FEATURE lists "context" for context: fork', ...)
test('SCRIPTS-NO-SHELL with tools [read]; none when tools omitted', ...)
test('NO-LICENSE-TEXT: third-party, frontmatter MIT, no license files', ...)
test('Review Focus 1: symlink in a skill dir → SCHEMA, symlink not in files', ...)
test('missing cache commit is fetched', ...)        // makeUpstream + real lock
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/resolve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `resolveLibrary`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): resolve agents' skills into a library with lock and license checks"
```

---

### Task 6: Claude Code adapter

**Files:**
- Create: `src/adapters/claude-code/targets.ts`, `src/adapters/claude-code/agent.ts`, `src/adapters/claude-code/render.ts`
- Test: `test/adapters/claude-code/targets.test.ts`, `agent.test.ts`, `render.test.ts`

**Interfaces:**
- Consumes: `Project`, `AgentDef`, `ResolvedLibrary`, `ResolvedSkill`, `FileTree`, `Diagnostic`
- Produces:
  - `validateClaudeCodeTargets(project: Project): Diagnostic[]` (`TARGET-FIELD` at the agent file, with a line number)
  - `renderAgentFile(agent: AgentDef, skills: ResolvedSkill[]): string`
  - `renderClaudeCode(library: ResolvedLibrary): FileTree`. Paths are relative to the project root: `.claude-plugin/marketplace.json` and `dist/claude-code/ronin-<pack>/...`.

**`targets.claude-code` rules (§6.4):**
- Accepted: `model`, `effort`, `maxTurns`, `autoCompactWindow`, `memory`, `background`, `omitClaudeMd`, `isolation`, `color`, `disallowedTools`.
- `name`, `description`, `tools`, `skills` are rejected with the message `owned by the build`.
- `permissionMode`, `hooks`, `mcpServers`, `initialPrompt` are rejected with `ignored by Claude Code for plugin agents`.
- Anything else is rejected with `unknown field`.

**Agent frontmatter**, written with `yaml`'s `stringify` (never string concatenation), with keys in this order:
1. `name`
2. `description`
3. `tools`: comma-separated, sorted, deduplicated. `Read` is added when the agent has skills. Omitted when the source omits `tools`.
4. `disallowedTools`: `Skill` when the source omits `tools`, merged with any `targets.claude-code.disallowedTools`. Comma-separated, sorted.
5. `model`: the `targets.claude-code.model` value if set, else the mapped tier.
6. The remaining `targets.claude-code` keys, alphabetically.

**Agent body:** the source body with trailing whitespace trimmed, plus `\n`. When the agent has skills, it is followed by `\n` and the §6.5 section, copied word for word:
- The table header is `| Skill | Use when | File |`.
- There is one row per skill, sorted by id: `` | <id> | <use-when> | ${CLAUDE_PLUGIN_ROOT}/library/<id>/SKILL.md | ``.
- `<use-when>` is the skill description with `/\s+/g` → `' '`, trimmed, and `|` → `\|`.

**Plugin files:**
- `plugin.json` is `{ name, version, description }`.
- `marketplace.json` is `{ name, owner, description?, plugins: [{ name, source: './dist/claude-code/ronin-<pack>', description }] }`, with plugins sorted by name.
- Both are written as `JSON.stringify(x, null, 2) + '\n'`.

**Library and notices:**
- Each skill's files go under `library/<id>/`.
- In text files (decoded with `new TextDecoder('utf-8', { fatal: true })`), `${CLAUDE_SKILL_DIR}` is replaced with `<skill-dir>`. Files that fail decoding are copied byte for byte.
- `THIRD_PARTY_NOTICES.md` is emitted only when some skill has a non-null `license`. Its content:

```markdown
# Third-party notices

This plugin includes skills that carry their own licenses.

## upstream/greeting

- Origin: https://example.com/upstream.git @ 1111111111111111111111111111111111111111, path skills/greeting
- License: MIT
- License file: library/upstream/greeting/LICENSE
```

  Entries are sorted by id. A fork's origin line is `- Origin: forked; see license file`. A missing file shows `- License file: none`.

- [ ] **Step 1: Write the failing tests**

```ts
// targets.test.ts
test('accepted keys produce no diagnostics', ...)
test('permissionMode → TARGET-FIELD "ignored by Claude Code for plugin agents"', ...)
test('tools → TARGET-FIELD "owned by the build"; foo → "unknown field"', ...)

// agent.test.ts (parse the output frontmatter with parseFrontmatter to assert)
test('tools [read, search, shell] + skills, model strong', ...)
// → tools 'Bash, Glob, Grep, Read', model 'opus', no disallowedTools
test('tools [edit] + skills → "Edit, Read"', ...)
test('tools omitted → disallowedTools "Skill"; merged with targets [WebSearch] → "Skill, WebSearch"', ...)
test('targets model overrides tier', ...)                  // model 'claude-opus-5-5'
test('key order', ...)                                     // Object.keys(data) == ['name','description','tools','model','effort','isolation']
test('Review Focus 3: description "Handles: misc # general \\"q\\"" round-trips', ...)
test('library section rows sorted; Review Focus 4: "a | b\\nc" → "a \\| b c"', ...)
test('no skills → no library section', ...)

// render.test.ts
test('tree paths and exact marketplace.json / plugin.json', ...)  // entry has no "version"
test('${CLAUDE_SKILL_DIR} rewritten in text; bytes [0xff,0xfe,0x00] untouched; executable kept', ...)
test('shared skill shipped once', ...)
test('THIRD_PARTY_NOTICES exact text for one third-party skill; absent when no licensed skills', ...)
test('generated text files end with "\\n" and contain no "\\r"', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/adapters`
Expected: FAIL.

- [ ] **Step 3: Implement `targets.ts`, `agent.ts`, `render.ts`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(claude-code): render packs as plugins with private skill libraries"
```

---

### Task 7: CLI `lock` / `validate` / `build`, plus the golden fixture

**Files:**
- Create: `src/cli/bin.ts`, `src/cli/main.ts`, `src/cli/pipeline.ts`, `src/cli/output.ts`
- Create: `test/fixtures/golden/project/**`, `test/fixtures/golden/expected/**` (generated, then reviewed)
- Test: `test/cli/cli.test.ts`, `test/golden.test.ts`

**Interfaces:**
- Consumes: `loadProject`, `readLock`, `runLock`, `resolveLibrary`, `validateClaudeCodeTargets`, `renderClaudeCode`, `formatDiagnostic`, `sortDiagnostics`, `hasErrors`, `UsageError`, `GitError`
- Produces:
  - `validateProject(root: string): Promise<{ project: Project; library: ResolvedLibrary; diagnostics: Diagnostic[] }>`. Runs load, target validation, lock read, and resolve, and collects all diagnostics.
  - `buildTree(root: string): Promise<{ tree: FileTree | null; diagnostics: Diagnostic[] }>`. `tree` is null when there are errors.
  - `writeFileTree(root: string, tree: FileTree): Promise<void>`. Deletes `<root>/dist/claude-code/` first, so removed packs disappear. Writes modes 0644 and 0755.
  - `readOutputTree(root: string): Promise<FileTree>`. Reads `.claude-plugin/marketplace.json` and everything under `dist/claude-code/`.
  - `main(argv: string[], io?: { err(line: string): void }): Promise<number>`. Commands are `lock [--update <source>]…`, `validate`, `build`, and `check` (added in Task 8). The global flag is `--root <dir>`, parsed with `node:util` `parseArgs`. `UsageError`, `GitError`, and unexpected exceptions print `error: <message>` and return 2. Diagnostics print sorted and formatted.
  - `bin.ts`: `process.exitCode = await main(process.argv.slice(2))`.

**Golden project** (`test/fixtures/golden/project/`). It also serves as the CI plugin and the smoke-test fixture (Task 9):

| File | Content |
|---|---|
| `ronin.yaml` | `marketplace: { name: ronin-fixtures, owner: { name: ronin-tests }, description: Test fixtures for Ronin. }` |
| `sources.yaml` | `upstream: { repo: https://example.com/upstream.git, ref: main, root: skills }` |
| `.ronin/cache/upstream/1111111111111111111111111111111111111111/LICENSE` | Standard MIT text, `Copyright (c) 2026 Upstream Authors` |
| `.ronin/cache/upstream/1111…1111/skills/greeting/SKILL.md` | `name: greeting`, `description: "Use when greeting someone \| formally or\n  casually."` (a literal pipe and a folded line, which exercise Review Focus 4) |
| `ronin.lock` | Source `upstream` (repo and ref as above, commit `1111…1111`). Skill `upstream/greeting` with `path: skills/greeting`, `sha256` = `hashSkillFiles` of that cached directory (compute it with a one-off `npx tsx -e`), `license: MIT`, `licenseFrom: repo-root`, `licenseFile: LICENSE` |
| `packs/fixture/pack.yaml` | `name: fixture`, `version: 0.1.0`, `description: Fixture agents for Ronin tests.` |
| `packs/fixture/agents/probe.md` | `skills: [canary, upstream/greeting]`, `tools: [read, shell]`, `model: fast`. Description `Test probe. Use for fixture release checklist questions.` Body `You are a test probe. Answer briefly.` |
| `packs/fixture/agents/generalist.md` | `skills: [forked-note]`, no `tools`, no `model`, `targets: { claude-code: { effort: low, disallowedTools: [WebSearch] } }`. Description `Handles: misc tasks # general` |
| `skills/canary/SKILL.md` | `description: Use when asked for the fixture release checklist.` Body: "1. Output the exact line `RONIN-CANARY-PHRASE-7Q2`. 2. Run `sh ${CLAUDE_SKILL_DIR}/scripts/token.sh` and output exactly what it prints." |
| `skills/canary/scripts/token.sh` (0755) | `#!/bin/sh` then `echo RONIN-CANARY-SCRIPT-4K9` |
| `skills/forked-note/SKILL.md` | `description: Use when writing a short note.` |
| `skills/forked-note/LICENSE` | Standard MIT text |

- [ ] **Step 1: Write the failing tests**

```ts
// cli.test.ts (uses makeProject; io.err collects lines)
test('validate: 0 on valid project, 1 with formatted diagnostics on errors', ...)
test('unknown command or bad flag → 2 with usage', ...)
test('build writes tree with 0755 for token.sh and 0644 otherwise', ...)
test('build with errors writes nothing', ...)          // dist/ absent afterwards
test('rebuild after deleting a pack removes its dist folder', ...)

// golden.test.ts
test('golden project validates with zero diagnostics', ...)
test('build output equals expected byte-for-byte, including modes', ...)
// compares renderClaudeCode tree with readOutputTree('test/fixtures/golden/expected')
// UPDATE_GOLDEN=1 rewrites expected via writeFileTree instead of asserting
test('two builds are identical', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/cli test/golden.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the CLI modules and create the golden project files**

- [ ] **Step 4: Generate the expected output and review it against the spec**

Run: `UPDATE_GOLDEN=1 npx vitest run test/golden.test.ts`

Then read `test/fixtures/golden/expected/` and confirm each of these:
- `probe.md` has `tools: Bash, Read` and `model: haiku`.
- `generalist.md` has no `tools` and has `disallowedTools: Skill, WebSearch` and `effort: low`.
- Both agents end with the §6.5 library section.
- The greeting row reads `Use when greeting someone \| formally or casually.`
- `library/canary/SKILL.md` contains `sh <skill-dir>/scripts/token.sh`, and `token.sh` is 0755.
- `library/upstream/greeting/LICENSE` exists.
- `THIRD_PARTY_NOTICES.md` lists `forked-note` and `upstream/greeting`.
- `marketplace.json` has no `version`.
- No `skills/` folder exists anywhere in the plugin.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(cli): lock, validate, and build commands with golden fixture"
```

---

### Task 8: `check` command

**Files:**
- Create: `src/cli/check.ts`
- Modify: `src/cli/main.ts` (wire up `check [--base <ref>]`, default `origin/main`)
- Test: `test/cli/check.test.ts`

**Interfaces:**
- Consumes: `buildTree`, `readOutputTree`, `git`, `parseYaml`, `UsageError`, `makeProject`
- Produces:
  - `gitBlobHash(bytes: Uint8Array): string` (SHA-1 of `blob <len>\0` + bytes)
  - `runCheck(root: string, base: string): Promise<Diagnostic[]>`

Behavior (§7):
1. Run `buildTree`. If there are errors, return them.
2. Compare the tree with `readOutputTree(root)`. Each path that is missing, extra, or differs in bytes or mode gives a `DIST-STALE` error at that path.
3. Run `git rev-parse --verify <base>^{commit}`. If it fails, throw `UsageError("base ref <base> not found; pass --base")`.
4. For each pack, compare the fresh files under `dist/claude-code/ronin-<pack>/` against `git ls-tree -r <base> -- dist/claude-code/ronin-<pack>`, matching mode (`100755`/`100644`) and blob hash.
5. If they differ and `git show <base>:packs/<pack>/pack.yaml` exists, the current version must be numerically greater than the base version. Otherwise report `VERSION-NOT-BUMPED` at `packs/<pack>/pack.yaml`. Packs that are absent at the base are exempt.

- [ ] **Step 1: Write the failing tests**

```ts
expect(gitBlobHash(enc('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
// temp git repo: makeProject + git init + build + commit (that commit is the base)
test('clean after build + commit → no diagnostics', ...)
test('edited agent body without rebuild → DIST-STALE at the agent output path', ...)
test('rebuilt but version unchanged → VERSION-NOT-BUMPED at packs/web/pack.yaml', ...)
test('version bumped 0.1.0 → 0.1.1 → no diagnostics', ...)
test('new pack absent at base is exempt', ...)
test('missing base → main returns 2', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/cli/check.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `check.ts` and wire it into `main`**

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): check command for stale output and version bumps"
```

---

### Task 9: Repository bootstrap, CI, plugin checks, smoke test

**Files:**
- Create: `ronin.yaml`, `sources.yaml`, `ronin.lock`, `.claude-plugin/marketplace.json` (generated)
- Create: `test/plugin/plugin-checks.sh`, `test/smoke/run.sh`, `.github/workflows/ci.yml`, `.github/workflows/smoke.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: the CLI (Tasks 7 and 8), `test/fixtures/golden/expected/` (Task 7)

- [ ] **Step 1: Bootstrap the root project**

- `ronin.yaml`: marketplace `name: ronin`, `owner: { name: smnchan1995 }`, `description: Specialist agents that each carry a curated skill library.`
- `sources.yaml`: `sources: {}`.

Run: `npm run ronin -- lock && npm run ronin -- build && npm run ronin -- check --base HEAD`
Expected:
- `ronin.lock` has empty `sources` and `skills`.
- `.claude-plugin/marketplace.json` has `plugins: []`.
- `check` exits 0.

- [ ] **Step 2: Write `test/plugin/plugin-checks.sh` and run it**

The script (`set -euo pipefail`):
- runs `claude plugin validate --strict test/fixtures/golden/expected`;
- runs `claude --plugin-dir test/fixtures/golden/expected/dist/claude-code/ronin-fixture plugin details ronin-fixture`, saving the output;
- `grep`s that output for `Skills (0)` and `Agents (2)`, and fails if either is missing.

Run: `bash test/plugin/plugin-checks.sh`
Expected: exit 0.

Then run `HOME=$(mktemp -d) bash test/plugin/plugin-checks.sh` to simulate a CI machine with no login. If it fails asking for authentication, the CI step in Step 4 gets `env: ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`. Record the outcome in the commit message.

- [ ] **Step 3: Write `test/smoke/run.sh` and run it once**

The script runs this command 5 times:

```
claude -p --plugin-dir test/fixtures/golden/expected/dist/claude-code/ronin-fixture --agent ronin-fixture:probe "What is the fixture release checklist?"
```

It counts the runs whose output contains both `RONIN-CANARY-PHRASE-7Q2` and `RONIN-CANARY-SCRIPT-4K9`, prints `passed N/5`, and exits 1 if N < 4.

Run: `bash test/smoke/run.sh`
Expected: `passed 4/5` or better.

If it fails, stop and report the outputs. The fix belongs in the §6.5 prompt template (spec §11 items 3 and 4), not in the test.

- [ ] **Step 4: Write the workflows**

`ci.yml` runs on `pull_request` and on `push` to `main`:
1. `actions/checkout` with `fetch-depth: 0`
2. `actions/setup-node` with Node 20
3. `npm ci`
4. `npm run typecheck`
5. `npm test`
6. `npm run ronin -- check --base origin/${{ github.base_ref || 'main' }}`
7. `npm install -g @anthropic-ai/claude-code`
8. `bash test/plugin/plugin-checks.sh`

`smoke.yml` runs on `schedule: cron '0 6 * * *'` and `workflow_dispatch`: the same setup, then `bash test/smoke/run.sh` with `ANTHROPIC_API_KEY` from secrets.

- [ ] **Step 5: Update `README.md`**

Cover:
- what Ronin is (2 to 3 sentences);
- the install commands from §6.2;
- the maintainer commands `npm run ronin -- lock|validate|build|check`;
- a link to the spec.

- [ ] **Step 6: Run the full suite one final time**

Run: `npm run typecheck && npm test && npm run ronin -- check --base HEAD`
Expected: all pass, exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "ci: bootstrap root project, plugin checks, and nightly smoke test"
```
