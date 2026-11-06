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
  - LF line endings; JSON and YAML use 2-space indentation and the fixed key orders defined in Tasks 5.2 and 5.3.
  - No timestamps or absolute paths.
  - File modes are 0644 or 0755 only.
  - Path sorting is by plain string comparison (`a < b`), never `localeCompare`.
- Plugin name `ronin-<pack>`. Marketplace entries carry `name`, `source`, `description` only, with no `version` (Claude Code warns when both entry and `plugin.json` set it).
- Test-file conventions:
  - Tests live under `test/`, mirroring `src/`.
  - Tests that touch the filesystem use `makeProject` (Task 1.1).
  - Tests that need git upstreams use `makeUpstream` and `commitUpstream` (Task 3.3).
- Every task's verification command is `npx vitest run && npm run typecheck`, unless the task names another. Both must pass before committing.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Symlinks inside a skill directory** (common in upstream repos) must never be followed or copied, so dist can't pick up files from outside the skill. Expected: a `SCHEMA` error naming the link. Tested in Tasks 3.1 and 4.3.
2. **Files with CRLF line endings or a UTF-8 BOM** (authored on Windows) must parse like LF files. Tested in Task 1.2.
3. **Agent descriptions containing YAML-significant text** (`: `, `#`, quotes) must produce valid frontmatter that round-trips. Tested in Task 5.2.
4. **Skill descriptions containing `|` or newlines** must not break the index table. Tested in Task 5.2 and exercised by the golden fixture (Task 6.3).
5. **Skill references that try path traversal** (`upstream/../x`, `../x`) must be rejected before any filesystem access. Expected: a `NAME` error. Tested in Task 2.2.

## Milestones

| Milestone | Tasks | Done when |
|---|---|---|
| M1 Foundation | 1.1, 1.2 | Diagnostics and YAML/frontmatter parsing work and are tested |
| M2 Source format | 2.1, 2.2, 2.3 | `loadProject` turns a repo into a validated `Project` |
| M3 Skill sourcing | 3.1, 3.2, 3.3, 3.4, 3.5 | `runLock` pins third-party skills with hashes and licenses |
| M4 Resolution | 4.1, 4.2, 4.3 | `resolveLibrary` produces a `ResolvedLibrary` with every resolve-time rule |
| M5 Claude Code adapter | 5.1, 5.2, 5.3 | `renderClaudeCode` produces a complete plugin `FileTree` |
| M6 CLI | 6.1, 6.2, 6.3, 6.4 | `npm run ronin -- lock\|validate\|build\|check` works end to end against the golden fixture |
| M7 Ship | 7.1, 7.2, 7.3, 7.4 | Root project bootstrapped; plugin checks, smoke test, and CI workflows in place |

---

## M1: Foundation

### Task 1.1: Scaffold and diagnostics

**Files:**
- Create: `package.json`, `package-lock.json` (via `npm install`), `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/diagnostics.ts`, `test/helpers/fs.ts`
- Test: `test/core/diagnostics.test.ts`, `test/helpers/fs.test.ts`

**Interfaces:**
- Produces:
  - `type RuleId = 'SCHEMA'|'NAME'|'DUPLICATE'|'DESCRIPTION'|'TOOL'|'SKILL-UNRESOLVED'|'SKILL-COLLISION'|'LOCK-STALE'|'LICENSE-UNKNOWN'|'LICENSE-DISALLOWED'|'HASH-MISMATCH'|'HARNESS-SYNTAX'|'TARGET-FIELD'|'DIST-STALE'|'VERSION-NOT-BUMPED'|'DROPPED-FEATURE'|'SCRIPTS-NO-SHELL'|'NO-LICENSE-TEXT'`
  - `interface Diagnostic { path: string; line?: number; severity: 'error'|'warning'; rule: RuleId; message: string }`
  - `error(rule: RuleId, path: string, message: string, line?: number): Diagnostic` and `warning(...)` with the same signature
  - `formatDiagnostic(d: Diagnostic): string`, `sortDiagnostics(ds: Diagnostic[]): Diagnostic[]`, `hasErrors(ds: Diagnostic[]): boolean`
  - `class UsageError extends Error` (maps to exit 2)
  - Test helpers in `test/helpers/fs.ts`:
    - `makeProject(files: Record<string, string | { content: string | Uint8Array; executable?: boolean }>): Promise<string>`. Writes files (creating parent directories) under a fresh `os.tmpdir()` directory and returns its path. `executable` sets mode 0755.
    - `enc(s: string): Uint8Array` (UTF-8 encode)

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
expect(sortDiagnostics([error('NAME','b',''), error('NAME','a','',5), error('NAME','a','')]).map(d => [d.path, d.line]))
  .toEqual([['a', undefined], ['a', 5], ['b', undefined]]);
expect(hasErrors([warning('NAME','a','')])).toBe(false);
expect(hasErrors([error('NAME','a','')])).toBe(true);

// test/helpers/fs.test.ts
// makeProject({'a/b.txt':'x', 'run.sh':{content:'#!/bin/sh', executable:true}}) → files exist; run.sh mode & 0o111 != 0
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `src/core/diagnostics.ts` and `test/helpers/fs.ts`**

- [ ] **Step 5: Run the verification command**

Expected: PASS.

- [ ] **Step 6: Commit**: `chore: scaffold ronin CLI with diagnostics`

### Task 1.2: YAML and frontmatter parsing

**Files:**
- Create: `src/core/yaml.ts`
- Test: `test/core/yaml.test.ts`

**Interfaces:**
- Produces:
  - `class ParseError extends Error { line: number }`
  - `parseYaml(text: string): { data: unknown; lineOf(path: (string|number)[]): number | undefined }`, which throws `ParseError`
  - `parseFrontmatter(text: string): { data: unknown; body: string; lineOf(path: (string|number)[]): number | undefined }`, which throws `ParseError`. `lineOf` returns 1-based line numbers within the whole file.

- [ ] **Step 1: Write the failing tests**

```ts
const fm = parseFrontmatter('---\nname: a\ndescription: b\n---\nBody\n');
expect(fm.data).toEqual({ name: 'a', description: 'b' });
expect(fm.body).toBe('Body\n');
expect(fm.lineOf(['description'])).toBe(3);
expect(parseYaml('a: 1\nb:\n  c: 2\n').lineOf(['b', 'c'])).toBe(3);
// Review Focus 2: CRLF + BOM
const crlf = parseFrontmatter('﻿---\r\nname: a\r\n---\r\nBody\r\n');
expect(crlf.data).toEqual({ name: 'a' });
expect(crlf.body).toBe('Body\n');
expect(() => parseFrontmatter('no frontmatter')).toThrow(ParseError);   // .line === 1
expect(() => parseYaml('a: [1,\n')).toThrow(ParseError);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/yaml.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/core/yaml.ts`**

- Strip a leading BOM and normalize `\r\n` to `\n` before parsing.
- Line numbers come from the `yaml` package's `parseDocument` with a `LineCounter`, via `doc.getIn(path, true)?.range`. Frontmatter lines are offset by 1 for the opening `---`.

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(core): YAML and frontmatter parsing with line numbers`

---

## M2: Source format

### Task 2.1: Model types, schemas, and config loading

**Files:**
- Create: `src/core/model.ts`, `src/core/schemas.ts`, `src/core/load.ts`
- Test: `test/core/load-config.test.ts`

**Interfaces:**
- Consumes: `Diagnostic`, `error`, `parseYaml`, `ParseError`, `makeProject`
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
- Produces (`src/core/load.ts`): `loadProject(root: string): Promise<{ project: Project; diagnostics: Diagnostic[] }>`. In this task it loads `ronin.yaml` and `sources.yaml` and returns `packs: []` and `firstPartySkills: {}`. Tasks 2.2 and 2.3 extend it.

Behavior:
- `ronin.yaml` is required; a missing file is a `SCHEMA` error at `ronin.yaml`. It may hold an optional `marketplace.description` (an addition to §5.2, emitted to `marketplace.json` because `claude plugin validate` warns without one).
- `sources.yaml` is optional (missing means no sources). For each source, `root` defaults to `"."` and `licenses` to `{}`.
- Zod schemas are `.strict()`. Map Zod issue paths to lines with `lineOf`. Report a `ParseError` as `SCHEMA` at its line.
- A source name that doesn't match `NAME_RE` is a `NAME` error, and that source is dropped.

- [ ] **Step 1: Write the failing tests**

```ts
test('loads marketplace and sources with defaults', ...)
// ronin.yaml {marketplace:{name:'ronin', owner:{name:'t'}}}, sources.yaml {sources:{upstream:{repo:'https://x/y.git', ref:'main'}}}
// → project.sources.upstream == {name:'upstream', repo:'https://x/y.git', ref:'main', root:'.', licenses:{}}; diagnostics == []
test('missing ronin.yaml → SCHEMA at ronin.yaml', ...)
test('unknown key in ronin.yaml → SCHEMA with line', ...)
test('empty license reason → SCHEMA', ...)
test('bad source name "Up_Stream" → NAME, source dropped', ...)
test('missing sources.yaml → sources {}', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/load-config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `model.ts`, `schemas.ts`, and the config part of `loadProject`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(core): model types and config loading`

### Task 2.2: Load packs and agents

**Files:**
- Modify: `src/core/schemas.ts`, `src/core/load.ts`
- Test: `test/core/load-packs.test.ts`

**Interfaces:**
- Consumes: Task 2.1 types and `loadProject`, plus `parseFrontmatter`
- Produces: `loadProject` now fills `project.packs`

Behavior:
- Packs come from `packs/<dir>/pack.yaml`; a missing `packs/` folder means no packs. A pack's agents are every `*.md` directly inside `packs/<pack>/agents/` (not recursive).
- `pack.yaml` must have `name` equal to the directory name (else `NAME`), a `MAJOR.MINOR.PATCH` version, and a description. Its schema is `.strict()`.
- Agent frontmatter is `.strict()`, and `name` must equal the file name without `.md` (else `NAME`). `description` must be 1 to 300 characters (`DESCRIPTION`).
- `tools` must come from `NEUTRAL_TOOLS`; any other name is a `TOOL` error naming the tool. `model` must be a `ModelTier` (else `SCHEMA`).
- `targets` must be a map of objects (else `SCHEMA`). Their contents are checked by the adapter in Task 5.1.
- Skill references: a bare reference must match `NAME_RE`; `a/b` must have both parts match `NAME_RE`; anything else is a `NAME` error. A repeated reference is a `DUPLICATE` error.
- The body must be non-empty (`SCHEMA`) and must not contain `${CLAUDE_` (`HARNESS-SYNTAX`).
- Agents and packs that fail `SCHEMA` or `NAME` are left out of `project`. Other rules report without excluding.
- Agent names are unique within a pack by construction (the name equals the file name), so `DUPLICATE` applies only to skill references.

- [ ] **Step 1: Write the failing tests**

Build a valid base project with `makeProject`, then apply one change per test:

```ts
const base = {
  'ronin.yaml': 'marketplace:\n  name: ronin\n  owner:\n    name: t\n',
  'packs/web/pack.yaml': 'name: web\nversion: 0.1.0\ndescription: Web.\n',
  'packs/web/agents/frontend.md': '---\nname: frontend\ndescription: UI work.\nskills: [react]\ntools: [read, shell]\nmodel: strong\n---\nYou build UI.\n',
};
test('valid pack loads clean', ...)          // agent.tools == ['read','shell']; model 'strong'; file 'packs/web/agents/frontend.md'
test('unknown agent key → SCHEMA with line', ...)   // add 'colour: red' on line 4 → {rule:'SCHEMA', line:4}
test('NAME: file Frontend.md; name≠filename; pack dir≠pack.yaml name', ...)
test('Review Focus 5: traversal refs → NAME', ...)  // skills: ['upstream/../x', '../x', 'a/b/c'] → three NAME errors
test('DUPLICATE skill ref', ...)               // skills: [react, react]
test('DESCRIPTION bounds', ...)                // '' and 'x'.repeat(301) → DESCRIPTION; 'x'.repeat(300) ok
test('TOOL unknown', ...)                      // tools: [read, fly] → TOOL mentioning "fly"
test('HARNESS-SYNTAX', ...)                    // body contains '${CLAUDE_PLUGIN_ROOT}/x'
test('SCHEMA: model huge; version 1.0; targets not a map of objects', ...)
test('missing packs/ → no packs', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/load-packs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement pack and agent loading in `load.ts`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(core): load and validate packs and agents`

### Task 2.3: Load first-party skills

**Files:**
- Modify: `src/core/schemas.ts`, `src/core/load.ts`
- Test: `test/core/load-skills.test.ts`

**Interfaces:**
- Consumes: Tasks 2.1 and 2.2
- Produces: `loadProject` now fills `project.firstPartySkills` (keyed by name; `dir` is `skills/<name>`)

Behavior:
- First-party skills are every `skills/<dir>/SKILL.md`. Directories without a `SKILL.md` are ignored.
- The frontmatter requires `name` and `description` and allows other keys (passthrough, kept in `frontmatter`).
- `name` must equal the directory name (`NAME`).
- A skill that fails `SCHEMA` or `NAME` is excluded.

- [ ] **Step 1: Write the failing tests**

```ts
test('loads skills/react/SKILL.md with passthrough frontmatter', ...)  // extra key 'license: MIT' kept in frontmatter
test('name ≠ dir → NAME, excluded', ...)
test('missing description → SCHEMA', ...)
test('dir without SKILL.md ignored', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/load-skills.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement first-party skill loading**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(core): load first-party skills`

---

## M3: Skill sourcing

### Task 3.1: Skill file reading and content hashing

**Files:**
- Create: `src/core/files.ts`, `src/lock/hash.ts`
- Test: `test/core/files.test.ts`, `test/lock/hash.test.ts`

**Interfaces:**
- Consumes: `FileEntry`, `makeProject`, `enc`
- Produces:
  - `readTree(dir: string): Promise<{ files: FileEntry[]; symlinks: string[] }>`. Recursive; skips `.git`; sorted by path. A symlink is never followed. It is listed in `symlinks` (path relative to `dir`) and excluded from `files`. `executable` means any execute bit is set.
  - `hashSkillFiles(files: FileEntry[]): string`

Hash algorithm (§5.8): sort files by path, then take the SHA-256 hex digest of the concatenation of `` `${path}\0${executable ? '1' : '0'}\0${sha256hex(bytes)}\n` `` for each file.

- [ ] **Step 1: Write the failing tests**

```ts
// hash.test.ts: pinned value
const files = [
  { path: 'scripts/run.sh', bytes: enc('echo hi\n'), executable: true },
  { path: 'SKILL.md', bytes: enc('---\nname: a\ndescription: b\n---\nBody\n'), executable: false },
];
expect(hashSkillFiles(files)).toBe('86b40829bf2ebc1f5849bd275577440eeecab5898326093a5322d7153d326a94');
expect(hashSkillFiles([...files].reverse())).toBe(hashSkillFiles(files));
// flipping executable on run.sh, or changing one byte, changes the hash

// files.test.ts
test('sorted, executable flag, nested paths use "/", skips .git', ...)
test('Review Focus 1: symlink listed, not followed', ...)   // symlink 'evil' -> '/etc/hosts' → symlinks == ['evil']; files has no 'evil'
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/files.test.ts test/lock/hash.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `readTree` and `hashSkillFiles`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(lock): skill file reading and content hashing`

### Task 3.2: License detection

**Files:**
- Create: `src/lock/license.ts`
- Test: `test/lock/license.test.ts`

**Interfaces:**
- Consumes: `FileEntry`
- Produces:
  - `ALLOWLIST: readonly string[]`, `LICENSE_FILE_NAMES = ['LICENSE','LICENSE.md','LICENSE.txt','COPYING']`
  - `type LicenseFrom = 'asserted'|'frontmatter'|'skill-file'|'repo-root'`
  - `identifyLicenseText(text: string): string | null`
  - `detectLicense(input: { assertion?: { spdx: string }; frontmatterLicense?: unknown; skillFiles: FileEntry[]; repoRootFiles: FileEntry[] }): { license: string | null; from: LicenseFrom | null; file: string | null }`. `file` is the matched file name: within the skill directory for `skill-file`, at the repo root for `repo-root`, and null otherwise. License files are looked up by exact name, in `LICENSE_FILE_NAMES` order.
  - `isAllowed(spdx: string): boolean`

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

Run: `npx vitest run test/lock/license.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `license.ts`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(lock): license detection with allowlist`

### Task 3.3: Git access and content cache

**Files:**
- Create: `src/lock/git.ts`, `src/lock/cache.ts`, `test/helpers/git.ts`
- Test: `test/lock/git.test.ts`

**Interfaces:**
- Produces:
  - `class GitError extends Error`
  - `git(args: string[], cwd?: string): Promise<string>` (stdout; throws `GitError` with stderr on failure)
  - `resolveRef(repo: string, ref: string): Promise<string>`. A 40-hex `ref` is returned unchanged. Otherwise use `git ls-remote <repo> <ref>`, preferring `refs/heads/<ref>`, then the peeled `refs/tags/<ref>^{}`, then `refs/tags/<ref>`. Throws `GitError` if nothing matches.
  - `cachePath(root: string, source: string, commit: string): string` (`<root>/.ronin/cache/<source>/<commit>`)
  - `ensureCommit(root: string, source: string, repo: string, commit: string): Promise<string>`. Returns the cache path, fetching only if it is absent. The fetch goes into a temporary sibling directory: `git init`, `git fetch --depth 1 <repo> <commit>`, `git checkout --detach FETCH_HEAD`, then rename into place. On failure the temporary directory is removed and `GitError` is thrown.
  - Test helpers in `test/helpers/git.ts`:
    - `makeUpstream(files): Promise<{ dir: string; url: string; commit: string }>` and `commitUpstream(dir: string, files): Promise<string>`. `files` has the same shape as for `makeProject`; `commitUpstream` adds or overwrites files, and a `null` value deletes one. `url` is `file://<dir>`.
    - Pin `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME=ronin-test`, `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL=test@ronin.invalid`, and `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE=2026-01-01T00:00:00Z`. The default branch is `main`.

- [ ] **Step 1: Write the failing tests**

```ts
test('resolveRef: main → head commit; annotated tag → peeled commit; 40-hex passthrough', ...)
test('resolveRef: unknown ref → GitError', ...)
test('ensureCommit fetches into cachePath and checks out the commit', ...)  // SKILL.md readable under cache path
test('ensureCommit reuses an existing cache dir', ...)   // delete upstream dir, call again → same path, no throw
test('bad URL → GitError and no cache or temp dir left', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/lock/git.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `git.ts`, `cache.ts`, and the git helpers**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(lock): git ref resolution and commit cache`

### Task 3.4: Lockfile

**Files:**
- Create: `src/lock/lockfile.ts`
- Test: `test/lock/lockfile.test.ts`

**Interfaces:**
- Consumes: `LicenseFrom`, `parseYaml`, `Diagnostic`
- Produces:
  - `interface LockedSource { repo: string; ref: string; commit: string }`
  - `interface LockedSkill { path: string; sha256: string; license: string | null; licenseFrom: LicenseFrom | null; licenseFile?: string }`
  - `interface Lock { lockVersion: 1; sources: Record<string, LockedSource>; skills: Record<string, LockedSkill> }`
  - `emptyLock(): Lock`
  - `readLock(root: string): Promise<{ lock: Lock; diagnostics: Diagnostic[] }>`. A missing file gives `emptyLock()`. An invalid file gives a `SCHEMA` error at `ronin.lock` and `emptyLock()`.
  - `serializeLock(lock: Lock): string` (YAML; `sources` and `skills` keys sorted; field order as in §5.8)
  - `writeLock(root: string, lock: Lock): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
test('serialize sorts sources and skills and round-trips through readLock', ...)
test('missing ronin.lock → empty lock, no diagnostics', ...)
test('invalid ronin.lock → SCHEMA at ronin.lock', ...)
test('field order matches §5.8', ...)   // serialized skill entry lists path, sha256, license, licenseFrom, licenseFile in that order
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/lock/lockfile.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lockfile.ts`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(lock): lockfile read and write`

### Task 3.5: `runLock`

**Files:**
- Create: `src/lock/lock.ts`
- Test: `test/lock/lock.test.ts`

**Interfaces:**
- Consumes: `Project`, `readTree`, `hashSkillFiles`, `detectLicense`, `isAllowed`, `resolveRef`, `ensureCommit`, `readLock`, `writeLock`, `UsageError`, `makeUpstream`, `commitUpstream`
- Produces: `runLock(project: Project, opts: { update: string[] }): Promise<Diagnostic[]>`. Writes `ronin.lock`. Throws `UsageError` when `update` names a source not in `sources.yaml`.

Behavior (§7):
- A source's commit is re-resolved only when the source is new to the lock, its `repo` or `ref` differs from the lock, or it is named in `update`. Otherwise the locked commit is kept.
- Only sources and skills referenced by at least one agent are written.
- Every referenced skill is re-hashed and its license re-detected from the cache on every run, so `sources.yaml` assertion changes are picked up.
- A skill lives at `<root>/<skill>` within the source checkout (`root` from `sources.yaml`). Repo-root license files are read from the checkout's top level.
- `licenseFile` is the path in the upstream repo: `<path>/<name>` for `skill-file`, `<name>` for `repo-root`, and omitted otherwise.
- Problems are reported as diagnostics at `ronin.lock`:
  - a missing `SKILL.md` gives `SKILL-UNRESOLVED`, with the message `"<id>" not found at <commit>; referenced by <agent files, sorted, comma-separated>`;
  - unknown and disallowed licenses give `LICENSE-UNKNOWN` and `LICENSE-DISALLOWED`;
  - a symlink in a skill gives `SCHEMA`.
- The lock is still written when the only problems are license problems. Skills that are `SKILL-UNRESOLVED` are left out of it.

- [ ] **Step 1: Write the failing tests**

The upstream has `LICENSE` (MIT) at its root and `skills/greeting/SKILL.md`, and `sources.yaml` uses `root: skills`.

```ts
test('pins main to its commit and records hash + license', ...)
// lock.sources.upstream.commit === upstream.commit
// lock.skills['upstream/greeting'] == { path:'skills/greeting', sha256: hashSkillFiles(<cache files>),
//   license:'MIT', licenseFrom:'repo-root', licenseFile:'LICENSE' }
test('commit is sticky; update re-resolves', ...)   // commitUpstream → lock keeps old; {update:['upstream']} → new
test('ref change in sources.yaml re-resolves without update', ...)
test('only referenced skills are locked', ...)       // upstream has 2 skills, agents use 1
test('assertion → licenseFrom asserted', ...)
test('unknown license → lock written with license null + LICENSE-UNKNOWN', ...)
test('skill deleted upstream after update → SKILL-UNRESOLVED naming both agents', ...)
// message contains 'packs/web/agents/api.md, packs/web/agents/frontend.md'
test('update with unknown source → UsageError', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/lock/lock.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `runLock`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(lock): runLock pins referenced third-party skills`

---

## M4: Resolution

### Task 4.1: Resolve first-party and forked skills

**Files:**
- Modify: `src/core/model.ts`
- Create: `src/core/resolve.ts`
- Test: `test/core/resolve-first-party.test.ts`

**Interfaces:**
- Consumes: `Project`, `Lock`, `readTree`, `detectLicense`, `isAllowed`, `LICENSE_FILE_NAMES`
- Produces (add to `model.ts`):
  - `type SkillOrigin = { kind: 'first-party' } | { kind: 'fork' } | { kind: 'third-party'; repo: string; commit: string; path: string }`
  - `interface ResolvedSkill { id: string; description: string; frontmatter: Record<string, unknown>; files: FileEntry[]; origin: SkillOrigin; license: { spdx: string; file: string | null } | null }`. `license` is null when the skill is covered by the repository license. `license.file` is the path within `files`.
  - `interface ResolvedPack extends PackDef { skills: Record<string, ResolvedSkill> }` (the union of the pack's agents' skills, keyed by id)
  - `interface ResolvedLibrary { marketplace: Marketplace; packs: ResolvedPack[] }`
- Produces (`resolve.ts`): `resolveLibrary(project: Project, lock: Lock): Promise<{ library: ResolvedLibrary; diagnostics: Diagnostic[] }>`. This task handles bare references only; `<source>/<skill>` references are added in Task 4.2 (skip them here).

Behavior:
- A bare reference resolves to `project.firstPartySkills[name]`. If it's missing, report `SKILL-UNRESOLVED` at the agent file.
- If a first-party skill name equals a source name, report `SKILL-COLLISION` at its `SKILL.md`.
- If the skill directory contains a `LICENSE_FILE_NAMES` file, the origin is `fork`. Its license is detected with `detectLicense` (`frontmatterLicense` and `skillFiles` only). Unknown licenses give `LICENSE-UNKNOWN` and disallowed ones give `LICENSE-DISALLOWED`, both at its `SKILL.md`. `license.file` is the matched file name.
- Otherwise the origin is `first-party` and `license` is null.
- Each skill's `files` come from `readTree(skills/<name>)`.

- [ ] **Step 1: Write the failing tests**

```ts
test('first-party skill: origin first-party, license null, files read', ...)
test('fork with MIT LICENSE: origin fork, license {spdx:"MIT", file:"LICENSE"}', ...)
test('fork with GPL-3 LICENSE → LICENSE-DISALLOWED at skills/x/SKILL.md', ...)
test('shared skill appears once in pack.skills', ...)
test('missing first-party skill → SKILL-UNRESOLVED at the agent file', ...)
test('SKILL-COLLISION: first-party skill named like a source', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/resolve-first-party.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `resolveLibrary` for bare references**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(core): resolve first-party and forked skills`

### Task 4.2: Resolve third-party skills

**Files:**
- Modify: `src/core/resolve.ts`
- Test: `test/core/resolve-third-party.test.ts`

**Interfaces:**
- Consumes: Task 4.1, `ensureCommit`, `cachePath`, `hashSkillFiles`, `isAllowed`, `LICENSE_FILE_NAMES`, `makeUpstream`
- Produces: `resolveLibrary` now resolves `<source>/<skill>` references

Behavior (§5.7, §5.8, §6.6, §7.1). All diagnostics are at `ronin.lock`, except where noted:
- An unknown source is `SKILL-UNRESOLVED` at the agent file.
- **`LOCK-STALE`** fires when:
  - the lock lacks the source or skill entry;
  - the source's `repo` or `ref` differs from the lock;
  - a `sources.yaml` assertion for the skill doesn't match the lock (`licenseFrom` must be `asserted` with an equal `license`);
  - a lock entry with `licenseFrom: asserted` no longer has its assertion.
- The cache is obtained with `ensureCommit` (fetching if missing). A missing `SKILL.md` gives `SKILL-UNRESOLVED`. The recomputed `hashSkillFiles` must equal the lock's `sha256` (else `HASH-MISMATCH`).
- The license comes from the lock: `null` gives `LICENSE-UNKNOWN`, and a non-allowlisted id gives `LICENSE-DISALLOWED`.
- **License file:**
  - If the skill directory has a `LICENSE_FILE_NAMES` file, `license.file` is that name.
  - Otherwise, if the repo root has one, it is appended to `files` as `LICENSE` and `license.file` is `'LICENSE'`.
  - Otherwise `NO-LICENSE-TEXT` (warning) and `license.file` is null.
- `origin` is `{ kind: 'third-party', repo, commit, path }`.

- [ ] **Step 1: Write the failing tests**

Pre-populate `.ronin/cache/upstream/<40×'1'>/...` with `makeProject` and write a matching lock, so no git is needed. Only the last test uses `makeUpstream`.

```ts
test('third-party with only repo-root LICENSE: LICENSE appended to files', ...)
test('unknown source → SKILL-UNRESOLVED at the agent file', ...)
test('LOCK-STALE: missing entry; ref changed; assertion changed', ...)
test('HASH-MISMATCH after editing a cached file', ...)
test('LICENSE-UNKNOWN (lock null) and LICENSE-DISALLOWED (lock "GPL-3.0")', ...)
test('NO-LICENSE-TEXT: frontmatter MIT, no license files anywhere', ...)
test('missing cache commit is fetched', ...)        // makeUpstream + real lock
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/resolve-third-party.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement third-party resolution**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(core): resolve third-party skills against the lock`

### Task 4.3: Skill feature warnings and symlink safety

**Files:**
- Modify: `src/core/resolve.ts`
- Test: `test/core/resolve-checks.test.ts`

**Interfaces:**
- Consumes: Tasks 4.1 and 4.2
- Produces: `resolveLibrary` additionally emits `DROPPED-FEATURE`, `SCRIPTS-NO-SHELL`, and symlink `SCHEMA` diagnostics

Behavior:
- **`DROPPED-FEATURE`** (warning) fires once per skill and lists which of `allowed-tools`, `context`, `agent`, `paths`, `hooks` appear in its frontmatter. It is reported at the skill's `SKILL.md` for first-party skills and at `ronin.lock` for third-party skills.
- **`SCRIPTS-NO-SHELL`** (warning, at the agent file) fires only when the agent declares `tools` without `shell` and one of its skills has an executable file or a file whose directory path contains a `scripts` segment.
- **Symlinks:** any symlink `readTree` reports in a skill is a `SCHEMA` error naming it (at `SKILL.md` for first-party, at `ronin.lock` for third-party). The link is never in `files`.

- [ ] **Step 1: Write the failing tests**

```ts
test('DROPPED-FEATURE lists "context" for context: fork', ...)
test('SCRIPTS-NO-SHELL with tools [read]; none when tools omitted; none with shell', ...)
test('Review Focus 1: symlink in a skill dir → SCHEMA, symlink not in files', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/core/resolve-checks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the checks**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(core): skill feature warnings and symlink rejection`

---

## M5: Claude Code adapter

### Task 5.1: Target field validation

**Files:**
- Create: `src/adapters/claude-code/targets.ts`
- Test: `test/adapters/claude-code/targets.test.ts`

**Interfaces:**
- Consumes: `Project`, `Diagnostic`, `error`
- Produces:
  - `ACCEPTED_TARGET_KEYS = ['model','effort','maxTurns','autoCompactWindow','memory','background','omitClaudeMd','isolation','color','disallowedTools'] as const`
  - `validateClaudeCodeTargets(project: Project): Diagnostic[]` (`TARGET-FIELD` at the agent file)

Rules (§6.4):
- `name`, `description`, `tools`, `skills` are rejected with the message `"<key>" is owned by the build`.
- `permissionMode`, `hooks`, `mcpServers`, `initialPrompt` are rejected with `"<key>" is ignored by Claude Code for plugin agents`.
- Any other key not in `ACCEPTED_TARGET_KEYS` is rejected with `"<key>" is an unknown field`.

- [ ] **Step 1: Write the failing tests**

```ts
test('accepted keys produce no diagnostics', ...)
test('permissionMode → TARGET-FIELD "ignored by Claude Code for plugin agents"', ...)
test('tools → "owned by the build"; foo → "unknown field"', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/adapters/claude-code/targets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `targets.ts`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(claude-code): validate targets.claude-code fields`

### Task 5.2: Agent file rendering

**Files:**
- Create: `src/adapters/claude-code/agent.ts`
- Test: `test/adapters/claude-code/agent.test.ts`

**Interfaces:**
- Consumes: `AgentDef`, `ResolvedSkill`, `parseFrontmatter` (in tests)
- Produces: `renderAgentFile(agent: AgentDef, skills: ResolvedSkill[]): string`

**Agent frontmatter**, written with `yaml`'s `stringify` (never string concatenation), with keys in this order:
1. `name`
2. `description`
3. `tools`: comma-separated, sorted, deduplicated. `Read` is added when the agent has skills. Omitted when the source omits `tools`.
4. `disallowedTools`: `Skill` when the source omits `tools`, merged with any `targets.claude-code.disallowedTools`. Comma-separated, sorted.
5. `model`: the `targets.claude-code.model` value if set, else the mapped tier.
6. The remaining `targets.claude-code` keys, alphabetically.

**Agent body:** the source body with trailing whitespace trimmed, plus `\n`. When the agent has skills, it is followed by `\n` and this section, word for word (§6.5):

```markdown
## Your skill library

Library root: ${CLAUDE_PLUGIN_ROOT}/library

These skills are yours alone. Before starting a task, check the list below. When a skill applies, Read its SKILL.md in full and follow it. Paths inside a skill's files are relative to that skill's folder (the folder containing its SKILL.md). The token `<skill-dir>` in a skill's files means that folder: replace it with the folder's absolute path before using it in a command.

| Skill | Use when | File |
|---|---|---|
```

That is followed by one row per skill, sorted by id: `` | <id> | <use-when> | ${CLAUDE_PLUGIN_ROOT}/library/<id>/SKILL.md | ``. `<use-when>` is the skill description with `/\s+/g` → `' '`, trimmed, and `|` → `\|`.

- [ ] **Step 1: Write the failing tests** (parse the output with `parseFrontmatter` to assert)

```ts
test('tools [read, search, shell] + skills, model strong', ...)
// → tools 'Bash, Glob, Grep, Read', model 'opus', no disallowedTools
test('tools [edit] + skills → "Edit, Read"', ...)
test('tools omitted → disallowedTools "Skill"; merged with targets [WebSearch] → "Skill, WebSearch"', ...)
test('targets model overrides tier', ...)                  // model 'claude-opus-5-5'
test('key order', ...)   // Object.keys(data) == ['name','description','tools','model','effort','isolation']
test('Review Focus 3: description "Handles: misc # general \\"q\\"" round-trips', ...)
test('library section rows sorted; Review Focus 4: "a | b\\nc" → "a \\| b c"', ...)
test('no skills → no library section; output ends with "\\n", no "\\r"', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/adapters/claude-code/agent.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `renderAgentFile`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(claude-code): render agent files with skill library index`

### Task 5.3: Plugin tree rendering

**Files:**
- Create: `src/adapters/claude-code/render.ts`
- Test: `test/adapters/claude-code/render.test.ts`

**Interfaces:**
- Consumes: `ResolvedLibrary`, `FileTree`, `renderAgentFile`
- Produces: `renderClaudeCode(library: ResolvedLibrary): FileTree`. Paths are relative to the project root: `.claude-plugin/marketplace.json` and `dist/claude-code/ronin-<pack>/...`.

Contents (§6.1–6.3, §6.6, §6.7):
- **`marketplace.json`** is `{ name, owner, description?, plugins: [{ name: 'ronin-<pack>', source: './dist/claude-code/ronin-<pack>', description }] }`, with plugins sorted by name. It is always emitted, even with zero packs.
- **Per pack:**
  - `.claude-plugin/plugin.json` `{ name, version, description }`;
  - `agents/<name>.md` via `renderAgentFile`;
  - `library/<id>/<file>` for each skill in `pack.skills`;
  - `THIRD_PARTY_NOTICES.md`.
- JSON files are written as `JSON.stringify(x, null, 2) + '\n'`.
- **Library rewrite:** in text files (decoded with `new TextDecoder('utf-8', { fatal: true })`), `${CLAUDE_SKILL_DIR}` is replaced with `<skill-dir>`. Files that fail decoding are copied byte for byte. Executable bits are kept.
- **`THIRD_PARTY_NOTICES.md`** is emitted only when some skill in the pack has a non-null `license`. Entries are sorted by id; a fork's origin line is `- Origin: forked; see license file`; a missing file shows `- License file: none`. Format:

```markdown
# Third-party notices

This plugin includes skills that carry their own licenses.

## upstream/greeting

- Origin: https://example.com/upstream.git @ 1111111111111111111111111111111111111111, path skills/greeting
- License: MIT
- License file: library/upstream/greeting/LICENSE
```

- [ ] **Step 1: Write the failing tests**

```ts
test('tree paths and exact marketplace.json / plugin.json', ...)  // entry has no "version"
test('zero packs → marketplace.json with plugins []', ...)
test('${CLAUDE_SKILL_DIR} rewritten in text; bytes [0xff,0xfe,0x00] untouched; executable kept', ...)
test('shared skill shipped once', ...)
test('THIRD_PARTY_NOTICES exact text for one third-party skill; absent when no licensed skills', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/adapters/claude-code/render.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `renderClaudeCode`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(claude-code): render plugins, marketplace, library, and notices`

---

## M6: CLI

### Task 6.1: Build pipeline and output writing

**Files:**
- Create: `src/cli/pipeline.ts`, `src/cli/output.ts`
- Test: `test/cli/pipeline.test.ts`

**Interfaces:**
- Consumes: `loadProject`, `validateClaudeCodeTargets`, `readLock`, `resolveLibrary`, `renderClaudeCode`, `hasErrors`
- Produces:
  - `validateProject(root: string): Promise<{ project: Project; library: ResolvedLibrary; diagnostics: Diagnostic[] }>`. Runs load, target validation, lock read, and resolve, and collects all diagnostics.
  - `buildTree(root: string): Promise<{ tree: FileTree | null; diagnostics: Diagnostic[] }>`. `tree` is null when there are errors.
  - `writeFileTree(root: string, tree: FileTree): Promise<void>`. Deletes `<root>/dist/claude-code/` first, so removed packs disappear, then writes every entry with mode 0755 (executable) or 0644.
  - `readOutputTree(root: string): Promise<FileTree>`. Reads `.claude-plugin/marketplace.json` (if present) and everything under `dist/claude-code/`.

- [ ] **Step 1: Write the failing tests**

```ts
test('validateProject on a valid project → no diagnostics', ...)
test('buildTree returns null tree on errors', ...)
test('writeFileTree writes modes 0755/0644 and readOutputTree reads them back equal', ...)
test('writeFileTree removes a pack folder no longer in the tree', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/cli/pipeline.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `pipeline.ts` and `output.ts`**

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(cli): build pipeline and output tree writing`

### Task 6.2: Command-line entry point

**Files:**
- Create: `src/cli/main.ts`, `src/cli/bin.ts`
- Test: `test/cli/main.test.ts`

**Interfaces:**
- Consumes: `validateProject`, `buildTree`, `writeFileTree`, `loadProject`, `runLock`, `formatDiagnostic`, `sortDiagnostics`, `hasErrors`, `UsageError`, `GitError`
- Produces:
  - `main(argv: string[], io?: { err(line: string): void }): Promise<number>`:
    - Commands are `lock [--update <source>]…`, `validate`, and `build`. Task 6.4 adds `check`.
    - The global flag is `--root <dir>`, parsed with `node:util` `parseArgs` (`strict: true`).
    - Diagnostics print sorted and formatted.
    - `lock` runs `loadProject` (stopping on errors) and then `runLock`.
    - `UsageError`, `GitError`, a parse failure, and unexpected exceptions print `error: <message>` and return 2.
    - An unknown or missing command also prints a one-line usage message.
  - `bin.ts`: `process.exitCode = await main(process.argv.slice(2))`.

- [ ] **Step 1: Write the failing tests** (`io.err` collects lines)

```ts
test('validate: 0 on valid project, 1 with formatted diagnostics on errors', ...)
test('unknown command, missing command, bad flag → 2 with usage', ...)
test('build writes tree; build with errors writes nothing', ...)    // dist/ absent afterwards
test('lock --update unknown → 2', ...)
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/cli/main.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `main.ts` and `bin.ts`**

- [ ] **Step 4: Run the verification command, then a manual check**

Run: `npm run ronin -- validate --root /nonexistent; echo $?`
Expected: a formatted `SCHEMA` diagnostic for `ronin.yaml`, then `1`.

- [ ] **Step 5: Commit**: `feat(cli): lock, validate, and build commands`

### Task 6.3: Golden fixture

**Files:**
- Create: `test/fixtures/golden/project/**`, `test/fixtures/golden/expected/**` (generated, then reviewed)
- Test: `test/golden.test.ts`

**Interfaces:**
- Consumes: `validateProject`, `buildTree`, `writeFileTree`, `readOutputTree`, `hashSkillFiles`, `readTree`

**Golden project** (`test/fixtures/golden/project/`). It also serves as the CI plugin and the smoke-test fixture (Tasks 7.2 and 7.3):

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
test('golden project validates with zero diagnostics', ...)
test('build output equals expected byte-for-byte, including modes', ...)
// compares buildTree tree with readOutputTree('test/fixtures/golden/expected')
// UPDATE_GOLDEN=1 rewrites expected via writeFileTree instead of asserting
test('two builds are identical', ...)
```

- [ ] **Step 2: Create the golden project files, then run the tests and confirm they fail**

Run: `npx vitest run test/golden.test.ts`
Expected: FAIL (expected directory missing).

- [ ] **Step 3: Generate the expected output and review it against the spec**

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

Fix the code, not the expectations, for anything that's off.

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `test: golden fixture for end-to-end build output`

### Task 6.4: `check` command

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
3. Run `git rev-parse --verify <base>^{commit}` in `root`. If it fails, throw `UsageError("base ref <base> not found; pass --base")`.
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

- [ ] **Step 4: Run the verification command**

Expected: PASS.

- [ ] **Step 5: Commit**: `feat(cli): check command for stale output and version bumps`

---

## M7: Ship

### Task 7.1: Root project bootstrap and README

**Files:**
- Create: `ronin.yaml`, `sources.yaml`, `ronin.lock` (generated), `.claude-plugin/marketplace.json` (generated)
- Modify: `README.md`

- [ ] **Step 1: Write the root config**

- `ronin.yaml`: marketplace `name: ronin`, `owner: { name: smnchan1995 }`, `description: Specialist agents that each carry a curated skill library.`
- `sources.yaml`: `sources: {}`.

- [ ] **Step 2: Generate and check**

Run: `npm run ronin -- lock && npm run ronin -- build && npm run ronin -- check --base HEAD`
Expected:
- `ronin.lock` has empty `sources` and `skills`.
- `.claude-plugin/marketplace.json` has `plugins: []`.
- All three commands exit 0.

- [ ] **Step 3: Update `README.md`**

Cover:
- what Ronin is (2 to 3 sentences);
- the install commands (`claude plugin marketplace add <github-owner>/<repo>`, `claude plugin install ronin-<pack>@ronin`);
- the maintainer commands `npm run ronin -- lock|validate|build|check`;
- a link to the spec.

- [ ] **Step 4: Commit**: `chore: bootstrap root Ronin project and README`

### Task 7.2: Plugin checks script

**Files:**
- Create: `test/plugin/plugin-checks.sh` (0755)

- [ ] **Step 1: Write the script**

The script (`set -euo pipefail`):
- runs `claude plugin validate --strict test/fixtures/golden/expected`;
- runs `claude --plugin-dir test/fixtures/golden/expected/dist/claude-code/ronin-fixture plugin details ronin-fixture`, saving the output;
- `grep`s that output for `Skills (0)` and `Agents (2)`, printing the output and exiting 1 if either is missing.

- [ ] **Step 2: Run it**

Run: `bash test/plugin/plugin-checks.sh`
Expected: exit 0.

- [ ] **Step 3: Simulate a CI machine with no login**

Run: `HOME=$(mktemp -d) bash test/plugin/plugin-checks.sh`

Record whether it passes or fails asking for authentication. Task 7.4 needs this.

- [ ] **Step 4: Commit**: `test: plugin validation and context-cost checks`

Note the authentication outcome from Step 3 in the commit body.

### Task 7.3: Smoke test script

**Files:**
- Create: `test/smoke/run.sh` (0755)

- [ ] **Step 1: Write the script**

The script runs this command 5 times:

```
claude -p --plugin-dir test/fixtures/golden/expected/dist/claude-code/ronin-fixture --agent ronin-fixture:probe "What is the fixture release checklist?"
```

It counts the runs whose output contains both `RONIN-CANARY-PHRASE-7Q2` and `RONIN-CANARY-SCRIPT-4K9`, prints `passed N/5`, and exits 1 if N < 4.

- [ ] **Step 2: Run it once**

Run: `bash test/smoke/run.sh`
Expected: `passed 4/5` or better.

If it fails, stop and report the outputs. The fix belongs in the §6.5 prompt template (spec §11 items 3 and 4), not in the test.

- [ ] **Step 3: Commit**: `test: headless smoke test for private skill libraries`

### Task 7.4: CI workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/smoke.yml`

- [ ] **Step 1: Write `ci.yml`**

It runs on `pull_request` and on `push` to `main`:
1. `actions/checkout@v4` with `fetch-depth: 0`
2. `actions/setup-node@v4` with Node 20 and npm cache
3. `npm ci`
4. `npm run typecheck`
5. `npm test`
6. `npm run ronin -- check --base origin/${{ github.base_ref || 'main' }}`
7. `npm install -g @anthropic-ai/claude-code`
8. `bash test/plugin/plugin-checks.sh`

If Task 7.2 Step 3 needed authentication, the last step gets `env: ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`.

- [ ] **Step 2: Write `smoke.yml`**

It runs on `schedule: cron '0 6 * * *'` and `workflow_dispatch`. It does the same setup (steps 1–3 and 7 of `ci.yml`), then runs `bash test/smoke/run.sh` with `env: ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`.

- [ ] **Step 3: Validate the workflow syntax**

Run: `npx --yes yaml-lint .github/workflows/*.yml` (or `python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml`)
Expected: no errors.

- [ ] **Step 4: Run the full suite one final time**

Run: `npm run typecheck && npm test && npm run ronin -- check --base HEAD`
Expected: all pass, exit 0.

- [ ] **Step 5: Commit**: `ci: PR checks and nightly smoke test`
