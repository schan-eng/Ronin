# Ronin v1: Agent Format and Claude Code Adapter

- **Date:** 2026-11-05
- **Status:** Draft for review
- **Sub-project:** 1 of 3. This spec covers the provider-neutral format and the Claude Code adapter. Later sub-projects: adapters for other harnesses, and a standalone multi-provider runtime. Each gets its own spec.

## 1. Problem and idea

There are far more useful agent skills than any session can carry. In Claude Code, every installed skill's name and description sits in the main session's context on every turn, and Claude picks the right skill less reliably as the list grows.

Ronin moves the unit of installation up a level: **specialist agents that each own a curated set of skills.** The main session sees only agent descriptions. A specialist sees an index of its own skills and reads a skill in full only when it needs it.

Claude Code cannot do this natively (checked against code.claude.com docs on 2026-11-05):

- No skill frontmatter field or setting limits a skill's visibility to one subagent.
- A subagent's `skills:` field preloads full skill content at startup. It does not hide the skill from the main session or restrict access.
- `disable-model-invocation: true` removes a skill's description from context, but also prevents preloading it into subagents.

Ronin therefore ships each agent's skills as plain files that Claude Code does not register as skills (a "private library"), and generates an index of them into the agent's prompt. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` inside plugin agent content, so the index can point at files inside the installed plugin.

## 2. Scope

**In scope for v1:**

- A provider-neutral source format for packs, agents, and skill references.
- Reproducible sourcing of third-party skills, with license enforcement.
- A Claude Code adapter that builds each pack into an installable plugin, with this repository acting as the plugin marketplace.
- A CLI for maintainers, plus validation and CI checks suited to a public open-source project.

**Out of scope for v1:**

- Adapters for other harnesses (Codex CLI, Gemini CLI, and so on).
- The standalone multi-provider runtime.
- Pack-level MCP servers and hooks.
- The agent-as-skill fallback output (section 10).
- Authoring real packs. v1 ships test fixture packs only. Curating real packs is follow-on work that uses this tooling.
- Publishing the CLI to npm.

## 3. Success criteria

1. Installing a pack adds no skill descriptions to the main session, only the pack's agent names and descriptions.
2. A specialist reliably finds and follows its own skills.
3. `ronin build` output is byte-for-byte reproducible from the lockfile.
4. The validator blocks invalid definitions and non-redistributable skills in CI.
5. Packs work headless: `claude -p --agent ronin-<pack>:<agent> "<task>"`.

## 4. Repository layout

```
ronin/
├── ronin.yaml                        # marketplace metadata
├── sources.yaml                      # third-party skill sources
├── ronin.lock                        # generated, committed
├── packs/<pack>/
│   ├── pack.yaml
│   └── agents/<agent>.md
├── skills/<skill>/SKILL.md           # first-party and forked skills, plus supporting files
├── .claude-plugin/marketplace.json   # generated, committed
├── dist/claude-code/ronin-<pack>/    # generated, committed
├── src/                              # CLI (section 8)
├── test/
└── .ronin/cache/                     # fetched upstream content, git-ignored
```

## 5. Source format

### 5.1 Names

Pack, agent, first-party skill, and source names all match `^[a-z0-9][a-z0-9-]{0,63}$`.

### 5.2 `ronin.yaml`

```yaml
marketplace:
  name: ronin
  owner:
    name: smnchan1995
```

### 5.3 `packs/<pack>/pack.yaml`

```yaml
name: web          # must equal the directory name
version: 0.1.0     # semver
description: Frontend and API specialists for web apps.
```

A pack's agents are every `*.md` file directly inside `packs/<pack>/agents/` (not recursive). `pack.yaml` does not list them.

### 5.4 Agent files

Markdown with YAML frontmatter. The body is the agent's system prompt.

```markdown
---
name: frontend
description: Builds and fixes React/TypeScript UI. Use for components, styling, accessibility, client state.
skills:
  - react-patterns
  - anthropic/frontend-design
tools: [read, edit, write, search, shell]
model: strong
targets:
  claude-code: { isolation: worktree }
---
You are a frontend specialist…
```

| Field | Required | Rules |
|---|---|---|
| `name` | yes | Equals the file name without `.md`. Unique within the pack. |
| `description` | yes | 1 to 300 characters. This is what the main session routes on. |
| `skills` | no | List of skill references (5.5). No duplicates. |
| `tools` | no | List from the neutral tool vocabulary (5.6). Omitted means the harness default (all tools). |
| `model` | no | `fast`, `balanced`, or `strong`. Omitted means the harness default. |
| `targets` | no | Map from harness id to harness-specific fields. v1 recognizes `claude-code` (6.4). |

The body must be non-empty and must not contain `${CLAUDE_` (rule `HARNESS-SYNTAX`). Harness-specific syntax is generated by adapters, never written in source.

### 5.5 Skill references

- A bare `name` refers to a first-party skill at `skills/<name>/SKILL.md`.
- `<source>/<skill>` refers to skill `<skill>` from source `<source>` in `sources.yaml`, resolved through `ronin.lock`.
- A first-party skill name must not equal any source name (rule `SKILL-COLLISION`).

First-party skills use the open Agent Skills format: a `SKILL.md` with `name` (equal to its directory name) and `description` frontmatter, plus optional supporting files. They are covered by the repository license (Apache-2.0), unless the skill directory contains its own license file. Such a skill (typically a fork of a third-party skill) has its license detected and checked like a third-party skill, and is listed in `THIRD_PARTY_NOTICES.md`. Forks must keep the upstream license file.

### 5.6 Neutral tool vocabulary

This list is closed. Any other name is an error (rule `TOOL`). Harness-specific tools belong under `targets`.

| Tool | Meaning | Claude Code |
|---|---|---|
| `read` | Read file contents | `Read` |
| `write` | Create or overwrite files | `Write` |
| `edit` | Change part of an existing file | `Edit` |
| `search` | Find files by name or pattern, search file contents | `Grep`, `Glob` |
| `shell` | Run shell commands | `Bash` |
| `web-fetch` | Fetch a URL | `WebFetch` |
| `web-search` | Search the web | `WebSearch` |

### 5.7 `sources.yaml`

```yaml
sources:
  anthropic:
    repo: https://github.com/anthropics/skills.git   # any git URL
    ref: main                                        # branch, tag, or 40-hex commit
    root: skills                                     # folder holding skill directories; default "."
    licenses:                                        # optional per-skill license assertions
      some-skill:
        spdx: MIT
        reason: License stated in the upstream README; see https://example.com/notice
```

A third-party skill `<source>/<skill>` lives at `<root>/<skill>/SKILL.md` in the source repository. A license assertion replaces detection for that skill. It still has to be on the allowlist, and `reason` must be non-empty.

### 5.8 `ronin.lock`

Generated by `ronin lock` and committed. Example:

```yaml
lockVersion: 1
sources:
  anthropic:
    repo: https://github.com/anthropics/skills.git
    ref: main
    commit: 0123456789abcdef0123456789abcdef01234567
skills:
  anthropic/frontend-design:
    path: skills/frontend-design
    sha256: 9f2c…
    license: Apache-2.0
    licenseFrom: skill-file          # asserted | frontmatter | skill-file | repo-root
    licenseFile: skills/frontend-design/LICENSE.txt   # path in the upstream repo; absent when no file was used
```

- One commit per source. All skills from a source share it.
- Only skills referenced by at least one agent are locked.
- `sha256` covers the skill directory as fetched: SHA-256 over the sorted list of (relative path, executable bit, SHA-256 of file contents).

### 5.9 License detection and allowlist

Detection order, first match wins:

1. An assertion in `sources.yaml`.
2. The `license` field in the skill's `SKILL.md` frontmatter, if it is a valid SPDX identifier.
3. A file named `LICENSE`, `LICENSE.md`, `LICENSE.txt`, or `COPYING` in the skill directory.
4. The same file names at the repository root.

Steps 3 and 4 identify a license by matching its standard text. Unrecognized text counts as unknown.

**Allowlist:** MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, CC0-1.0, CC-BY-4.0. An unknown license is an error (`LICENSE-UNKNOWN`), and so is a known license that is not on the list (`LICENSE-DISALLOWED`).

## 6. Claude Code adapter

### 6.1 Output

```
.claude-plugin/marketplace.json
dist/claude-code/ronin-<pack>/
├── .claude-plugin/plugin.json
├── agents/<agent>.md
├── library/<skill-id>/…        # skill-id is "<name>" or "<source>/<skill>"
└── THIRD_PARTY_NOTICES.md      # present when the pack ships any skill with its own license
```

`library/` is not a folder Claude Code scans, so nothing inside it registers as a skill or agent. Generated plugins have no `skills/`, `commands/`, or `bin/` folder. (A top-level `bin/` also blocks installation on claude.ai and Cowork.)

### 6.2 `marketplace.json`

The marketplace name and owner come from `ronin.yaml`. There is one plugin entry per pack: name `ronin-<pack>`, source `./dist/claude-code/ronin-<pack>`, and description and version from `pack.yaml`. Users install with:

```
claude plugin marketplace add <github-owner>/<repo>
claude plugin install ronin-<pack>@ronin
```

### 6.3 `plugin.json`

`name` is `ronin-<pack>`. `version` and `description` come from `pack.yaml`.

### 6.4 Generated agent frontmatter

| Source | Claude Code output |
|---|---|
| `name` | `name`. The installed agent ID becomes `ronin-<pack>:<name>`. |
| `description` | `description` |
| `tools` given | `tools`, mapped per 5.6, plus `Read` when the agent has skills. Deduplicated and sorted. `Skill` is never included. |
| `tools` omitted | No `tools` field. `disallowedTools: Skill`, so the agent inherits every tool except `Skill`. |
| `model` | `fast` → `haiku`, `balanced` → `sonnet`, `strong` → `opus` |
| `targets.claude-code.*` | Copied as-is. `model` here overrides the tier mapping. `disallowedTools` here is merged with the build's own `Skill` entry. |

`targets.claude-code` accepts only: `model`, `effort`, `maxTurns`, `autoCompactWindow`, `memory`, `background`, `omitClaudeMd`, `isolation`, `color`, `disallowedTools`. Everything else is an error (`TARGET-FIELD`). That includes:

- `name`, `description`, `tools`, `skills`, which the build owns.
- `permissionMode`, `hooks`, `mcpServers`, `initialPrompt`, which Claude Code ignores for plugin agents, so accepting them would mislead.

### 6.5 Generated agent body

The output body is the source body, followed by this section when the agent has skills:

```markdown

## Your skill library

Library root: ${CLAUDE_PLUGIN_ROOT}/library

These skills are yours alone. Before starting a task, check the list below. When a skill applies, Read its SKILL.md in full and follow it. Paths inside a skill's files are relative to that skill's folder (the folder containing its SKILL.md). The token `<skill-dir>` in a skill's files means that folder: replace it with the folder's absolute path before using it in a command.

| Skill | Use when | File |
|---|---|---|
| react-patterns | Applies team React patterns for components, hooks, and state. | ${CLAUDE_PLUGIN_ROOT}/library/react-patterns/SKILL.md |
```

Rows are sorted by skill id. The "Use when" column is the skill's `description`, with whitespace collapsed and `|` escaped.

### 6.6 Library contents

- The library holds the union of the skills used by the pack's agents. Each skill is copied once.
- A third-party skill is copied as its directory at the locked commit.
- If a skill directory contains no license file, the build copies the repository-root license file in as `LICENSE`. If there is none, the build emits `NO-LICENSE-TEXT`.
- In UTF-8 text files, `${CLAUDE_SKILL_DIR}` is rewritten to `<skill-dir>`. Claude Code does not substitute variables in files an agent reads, so the agent resolves the token using the instruction in 6.5. Binary files are copied unchanged. Executable bits are preserved.
- `SKILL.md` frontmatter is otherwise copied unchanged.

### 6.7 `THIRD_PARTY_NOTICES.md`

There is one entry per skill that carries its own license:

- the skill id;
- its origin: repository URL, commit, and path for third-party skills, or "forked; see LICENSE" for first-party skills with a license file;
- its SPDX identifier;
- the path of its license file within the plugin.

### 6.8 Determinism

- Files are written in sorted order.
- Generated files use LF line endings.
- YAML and JSON are written with stable key order and 2-space indentation.
- No timestamps or absolute paths appear in output.
- File modes are 0644 or 0755 only.
- Pack folders under `dist/claude-code/` that no longer have a source pack are removed.

## 7. CLI

The CLI is run inside the repository as `npm run ronin -- <command>`.

| Command | Behavior |
|---|---|
| `lock [--update <source>…]` | For each source: if it is not in the lock, or its `repo` or `ref` changed in `sources.yaml`, or it is named in `--update`, resolve `ref` to a commit (`git ls-remote`; a 40-hex ref is used as-is). Otherwise keep the locked commit. Fetch each commit shallowly into `.ronin/cache/<source>/<commit>/`. Then hash and detect the license of every referenced skill, and write `ronin.lock`. |
| `validate` | Fetch any locked commit missing from the cache. Then check every rule in 7.1 except `DIST-STALE` and `VERSION-NOT-BUMPED`, including each skill's `sha256`. |
| `build` | Run `validate` and stop on errors. Write `dist/claude-code/` and `.claude-plugin/marketplace.json`. |
| `check [--base <ref>]` | Run `validate`, build into a temporary folder, and compare against the committed output (`DIST-STALE`). For each pack whose output differs from `--base` (default `origin/main`), require `pack.yaml`'s version to be a higher semver than at the base (`VERSION-NOT-BUMPED`). Packs that don't exist at the base are exempt. |

**Exit codes:** 0 means no errors (warnings may be printed). 1 means one or more errors. 2 means bad usage or an unexpected internal failure.

**Diagnostics:** every diagnostic is collected before exiting, sorted by path then line, and printed as `<path>[:<line>]: <error|warning> <RULE-ID>: <message>`.

### 7.1 Rules

**Errors:**

| Rule | Fires when |
|---|---|
| `SCHEMA` | YAML or frontmatter doesn't match its schema: a missing or unknown field, or the wrong type. |
| `NAME` | A name is invalid, or doesn't equal its file or directory name. |
| `DUPLICATE` | An agent name repeats within a pack, or a skill reference repeats within an agent. |
| `DESCRIPTION` | An agent description is empty or longer than 300 characters. |
| `TOOL` | A tool is not in the vocabulary. |
| `SKILL-UNRESOLVED` | A first-party skill is missing, a source is unknown, or a skill is missing upstream at the locked commit. The message names every agent that references it. |
| `SKILL-COLLISION` | A first-party skill name equals a source name. |
| `LOCK-STALE` | The lock lacks an entry an agent needs, or a source's `repo` or `ref` differs from the lock. |
| `LICENSE-UNKNOWN` | A skill's license could not be determined. |
| `LICENSE-DISALLOWED` | A skill's license is not on the allowlist. |
| `HASH-MISMATCH` | Fetched content differs from the lock. Re-locking is a deliberate step. |
| `HARNESS-SYNTAX` | `${CLAUDE_` appears in an agent body. |
| `TARGET-FIELD` | A key under `targets.claude-code` is unsupported or rejected. |
| `DIST-STALE` | (`check` only) Committed output differs from a fresh build. |
| `VERSION-NOT-BUMPED` | (`check` only) A pack's output changed against the base but its version didn't increase. |

**Warnings:**

| Rule | Fires when |
|---|---|
| `DROPPED-FEATURE` | A skill uses `allowed-tools`, `context`, `agent`, `paths`, or `hooks`, which do not apply when it is delivered through a library. |
| `SCRIPTS-NO-SHELL` | A skill contains a file with the executable bit set, or any file under a `scripts/` folder, but its agent's tools exclude `shell`. |
| `NO-LICENSE-TEXT` | A skill with its own license has no license file to ship. |

## 8. Code structure

TypeScript on Node 20 or later, as ES modules. Dependencies: `yaml`, `zod`, and `vitest` for development. Git is called as a child process, so private hosts and existing credentials work.

```
src/core/                 parse, resolve, validate → ResolvedLibrary (no adapter knowledge)
src/lock/                 git fetching, cache, hashing, license detection, lockfile read/write
src/adapters/claude-code/ render(ResolvedLibrary) → FileTree
src/cli/                  commands, diagnostics output, writing a FileTree to disk
```

- **`ResolvedLibrary`** is plain data: packs, their agents, and each agent's resolved skills. Each resolved skill has its id, description, file contents, license information, and feature flags.
- **`FileTree`** maps each relative path to `{ bytes, executable }`. Adapters receive file contents through the model and return a `FileTree`. They never read or write the disk. A future adapter is another `render` function, and the future runtime consumes `ResolvedLibrary` directly.
- **Diagnostics:** `core` and `lock` return lists of diagnostics instead of throwing.

## 9. Testing

| Criterion | Check | When |
|---|---|---|
| Reproducible builds | Golden-file tests: fixture packs build to expected trees, compared byte-for-byte. Building twice gives identical output. | Every PR |
| Validator catches problems | One fixture case per rule in 7.1, so every rule is proven to fire. | Every PR |
| Pinning and licenses | Lock tests against throwaway local git repositories acting as upstreams, with no network. Covers pinning, `--update`, hash mismatch, license detection order, and upstream deletion. | Every PR |
| Output is a valid plugin | `claude plugin validate` on every generated fixture plugin. | Every PR |
| No skill cost in the main session | Install fixture packs from a temporary local marketplace, then check that `claude plugin details ronin-<pack>` lists agent components and no skill components in its `Always-on` breakdown. | Every PR |
| Specialists use their skills, headless | Smoke test: fixture pack `ronin-fixture` has agent `probe` with skill `canary`. Following `canary` requires outputting a fixed marker phrase and running `<skill-dir>/scripts/token.sh`, which prints a second marker. `claude -p --agent ronin-fixture:probe "<task matching canary's description>"` runs 5 times. The job fails if fewer than 4 runs contain both markers. Requires an `ANTHROPIC_API_KEY` secret. | Nightly and on demand |

Fixture packs live in `test/fixtures/` and are never part of the public marketplace.

## 10. Neutrality rules

How each field maps to the other targets:

| Field | Claude Code (v1) | Other harnesses (later) | Standalone runtime (later) |
|---|---|---|---|
| `name`, `description`, body | Agent file | That harness's agent or instructions format | The agent's system prompt |
| `skills` | Private library plus index | Same pattern; it only needs file reading | Index plus a `read_file` tool |
| `tools` | Mapped to Claude Code tool names | Mapped, or ignored if the harness can't restrict tools per agent | The runtime implements each neutral tool |
| `model` | Tier → `haiku` / `sonnet` / `opus` | That harness's models | A configurable table per provider |
| `targets.*` | Reads `claude-code` | Reads only its own key | Ignored |

Rules that keep the format neutral:

1. The tool vocabulary is closed and documented (5.6).
2. Source files never contain harness syntax. Library paths and variables are generated by adapters (`HARNESS-SYNTAX`).
3. **Fallback for harnesses without subagents (future, not built in v1).** An agent can be built as a single Agent Skills skill: its `SKILL.md` holds the agent prompt plus the index, and its library becomes the skill's supporting files. The main session still sees one description per agent. The agent runs inside the main context, but any harness that supports Agent Skills can install packs.

Each other harness's current subagent support is unverified. It gets checked when that harness's adapter is specced.

## 11. Risks and items to verify during planning

1. **`marketplace.json` schema:** confirm the required fields and that relative-path plugin sources work, against the Claude Code marketplace reference, before implementing 6.2.
2. **Plugin commands in CI:** find out whether `claude plugin validate`, `install`, and `details` need authentication in CI, and pin down the exact `details` output to parse.
3. **`<skill-dir>` resolution:** the smoke test measures whether agents resolve the token. If the pass rate is poor, one option is a pack-level SessionStart hook that exports the library path. That would bring pack hooks into scope.
4. **Index adherence:** the smoke test also measures whether agents actually read a skill when it applies. The prompt template in 6.5 is the thing to tune.
5. **Claude-Code-only skill features:** skills that rely on them (`DROPPED-FEATURE`) may behave differently when delivered through a library.
