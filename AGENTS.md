# AGENTS.md — fresh (Kovix rebuild)

> Entry point for any AI agent session working in this repo. Read this first.

## What this repo is

`fresh` is the **new** Kovix codebase, under controlled rebuild from `Kovix_2.0`. The shipped product name is **Kovix**. The repo name is `fresh` because we are starting clean.

Kovix is an AI-native development environment (VS Code / Code-OSS fork with an agent panel, multi-provider LLM support, agent modes, MCP servers, semantic memory, and security tooling). The old repo has the ideas and partial implementations; this repo is where reviewed code lands.

## Prime directive

**Nothing enters `fresh` without being reviewed first.** No bulk copy-paste, no "just move the folder over." Every file that ends up here must have been read, understood, and deliberately chosen.

## Two repos, two roles

- **`Kovix_2.0`** = reference only. Read-only. Never edit it. Treat as raw material to mine, not a codebase to copy.
- **`fresh`** (this repo) = the only place code gets written. Every commit should be something you could explain in one sentence.

## Working agreement

1. **File-by-file audit before migration.** For every file you pull from `Kovix_2.0`, produce an audit entry in `docs/03_MIGRATION_LOG.md` (template in the project instructions, Section 5) before any code from it lands in `fresh`. No audit entry = no migration.
2. **Decision log, not memory.** Keep `docs/DECISIONS.md` (to be created in Phase 2) updated every time you choose to keep, rewrite, merge, or drop something.
3. **Small, reversible steps.** Commit per logical unit. No "big bang" merges.
4. **Stop and ask when you hit:** licensing ambiguity, security-relevant code (nmap/Ghidra/nuclei), anything that looks like a secret/credential, or any decision that would be expensive to reverse (database choice, core architecture).
5. **Plain-language status reports.** After each phase, summarize progress for a non-engineer.

## Where to find things

| Path | Purpose |
|---|---|
| `docs/00_OLD_REPO_STATE.md` | One-page state-of-old-repo brief. Start here. |
| `docs/00_FILE_SUMMARIES.md` | Plain-language summary of each of the 12 audit docs read from Kovix_2.0. |
| `docs/01_REQUIREMENTS.md` | Phase 1 output (to be produced). Scoped feature list with Must / Should / Won't for v1. |
| `docs/02_ARCHITECTURE.md` | Phase 2 output (to be produced). Architecture + folder skeleton. |
| `docs/03_MIGRATION_LOG.md` | Phase 3 running log. One entry per file/module reviewed. |
| `docs/05_TEST_PLAN.md` | Phase 5 output (to be produced). Test suite + smoke checklist. |
| `docs/07_MAINTENANCE.md` | Phase 7 output (to be produced). CONTRIBUTING, CHANGELOG, "definition of reviewed" checklist. |
| `docs/DECISIONS.md` | Running decision log. Started in Phase 1. Every keep/rewrite/drop choice lands here. |

## SDLC phase status

- [x] Phase 0 — Repos cloned, fresh initialized, old repo audited (`docs/00_OLD_REPO_STATE.md` + `docs/00_FILE_SUMMARIES.md`).
- [x] Phase 1 — Discovery & Requirements complete (`docs/01_REQUIREMENTS.md` v1.1 + `docs/DECISIONS.md` through D-011).
- [x] Phase 2 — Architecture & Planning complete (`docs/02_ARCHITECTURE.md` + `docs/02a_ARCH_CHOICE_MATRIX.md`). Base architecture locked to VS Code extension per D-011 (supersedes D-004 fork decision).
- [x] Phase 3 — Source Audit & Migration COMPLETE (Rounds 2A, 2B, 2C, 2D — see `docs/03_MIGRATION_LOG.md`). Round 2D landed the agent panel webview (the last v0.1-alpha deliverable). v0.1-alpha is feature-complete.
- [x] Phase 4 — Implementation (covered incrementally by Phase 3 rounds — each round shipped production code, not stubs). The agent loop, tool registry, security layer, terminal executor, pending changes service, LLM provider (Anthropic), and agent panel webview are all live.
- [x] Phase 5 — Testing & Verification (279 automated tests across 13 test files; security audit complete; quality pass clean). See `docs/SECURITY_AUDIT.md` + `docs/ISSUES.md` Quality Pass Results.
- [ ] Phase 6 — Packaging & Deployment (NEXT — `vsce package`, marketplace metadata, smoke-test on Windows/macOS/Linux).
- [ ] Phase 7 — Maintenance Plan.

## Security tooling policy

Anything under `extensions/kovix-security-tools/` in the old repo (and the three `*Tool.ts` files in `src/`) **cannot be migrated** until the project owner confirms intended use is defensive / owned-systems only. This is non-negotiable per the project instructions.

## Secrets policy

Never copy any file containing real keys, tokens, or `.env`-style values into `fresh`. If you find one during audit, flag it and strip immediately. The old repo's `SECURITY_AUDIT.md` confirmed 0 real secrets in working tree and 0 real secrets in git history (79 findings are all VS Code inherited telemetry keys or test-fixture fake keys) — but verify again as you touch files.

## Licensing note

Per D-011, `fresh` is built as a VS Code extension (NOT a Code-OSS fork). The old repo's "Proprietary on MIT base" licensing chain doesn't apply to our source — we don't redistribute Code-OSS. The extension's own license is a separate decision (D-014, to be logged before `LICENSE.txt` is finalized). Lead recommendation under D-011: MIT for the extension itself. The `LICENSE.txt` file in `fresh/` is currently a placeholder pending D-014.
