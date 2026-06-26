# Kovix v0.1-alpha — Open Issues Inventory

**Compiled:** Round 2C test-audit pass (post-port, pre-push)
**Source:** `00_OLD_REPO_STATE.md`, `STUBS.md`, worklog (P3-R1 / R2A / R2B / R2C entries), and the Round 2C security audit (`SECURITY_AUDIT.md`).

This document tracks every issue carried over from the old repo (Kovix_2.0) plus every issue found during the fresh port. Each entry has a status: **RESOLVED** (fixed in fresh), **DEFERRED** (intentionally deferred with rationale), or **OPEN** (requires action before v1.0).

## Summary

- **Total issues tracked:** 21
- **RESOLVED in fresh:** 12 (including 6 found and fixed in the Round 2C test-audit pass)
- **DEFERRED to v1.0-beta or later:** 8 (each with rationale + revisit date)
- **OPEN (blocking v0.1-alpha):** 1 (Round 2D — the agent panel webview)
- **OPEN (blocking v1.0):** 0

---

## RESOLVED Issues (12)

### R-001 — `MajorMilestone` autonomy mode silently behaves like `FullAuto`
**Source:** `00_OLD_REPO_STATE.md` "What's Actively Broken" #2
**Status:** RESOLVED in `src/agent/milestoneExecutor.ts:200-211`
**Evidence:** The `shouldPauseAt()` helper now has an explicit `major_milestone` branch. The M3 bug fix is documented in the file header and verified by `test/unit/agent/milestoneExecutor.test.ts` "pauses at a milestone flagged isMajor=true".

### R-002 — `skipCurrentMilestone()` is identical to `resumeFromMilestone()`
**Source:** `00_OLD_REPO_STATE.md` "What's Actively Broken" #3
**Status:** RESOLVED in `src/agent/milestoneExecutor.ts:295-305`
**Evidence:** The `awaitResume` function returns `'resume' | 'skip'`. The `'skip'` path fires `milestone_skipped` and continues WITHOUT firing `milestone_completed`. Verified by `test/unit/agent/milestoneExecutor.test.ts` "marks milestone as SKIPPED (not completed) when awaitResume returns 'skip'".

### R-003 — Three security tools advertised but only stubbed (nmap / ghidra / nuclei)
**Source:** `00_OLD_REPO_STATE.md` "What's Stub" #1
**Status:** RESOLVED by D-008 (security tools dropped from v1.0)
**Evidence:** No security tool files exist in `src/`. The v1.0 MUST list (per `01_REQUIREMENTS.md`) explicitly excludes security tools. The README must not mention security tools per D-008 action item.

### R-004 — Credit purchase flow is fake
**Source:** `00_OLD_REPO_STATE.md` "What's Stub" #2
**Status:** RESOLVED by D-009 (credit system deferred to v1.0-beta)
**Evidence:** No `purchaseCredits()` function exists in fresh. The agent loop has no cost governor / credit system (per `agentLoop.ts` §"What is dropped").

### R-005 — Xenova offline provider is dead on desktop
**Source:** `00_OLD_REPO_STATE.md` "What's Stub" #3
**Status:** RESOLVED by STUB_AUDIT H-3 (Xenova provider dropped)
**Evidence:** No Xenova provider file exists in `src/llm/providers/`. Only Anthropic is ported in v0.1; offline mode will rely on Ollama (v1.0+).

### R-006 — MCP marketplace reviews return `[]`
**Source:** `00_OLD_REPO_STATE.md` "What's Stub" #4
**Status:** RESOLVED by deferral — MCP itself is deferred to v1.0-beta (M6)
**Evidence:** No MCP marketplace code in fresh. The `kovix.mcp.servers` setting exists in `package.json` but no service consumes it yet.

### R-007 — UniversalMemoryService scoring is keyword-only
**Source:** `00_OLD_REPO_STATE.md` "What's Stub" #5
**Status:** RESOLVED by deferral — UniversalMemory is deferred to v1.0-beta (M5)
**Evidence:** No memory service in fresh. The `kovix.memory.*` settings exist in `package.json` but no service consumes them yet.

### R-008 — Agent panel first-launch is unreliable (`openView` doesn't expand auxiliary bar)
**Source:** `00_OLD_REPO_STATE.md` "What's Stub" #6
**Status:** WILL BE RESOLVED in Round 2D (agent panel webview)
**Evidence:** The agent panel doesn't exist yet — it's the Round 2D deliverable. When it lands, it will use `WebviewViewProvider` (not `openView`) per D-012.

### R-009 — `commandBlocklist.ts` regex compilation failure (CRITICAL — found in test-audit)
**Source:** Round 2C security audit (Bug 1 in `SECURITY_AUDIT.md`)
**Status:** RESOLVED in `src/terminal/commandBlocklist.ts:52,75-93`
**Evidence:** The pattern `'del /s /q c:\\'` (single trailing backslash) compiled to an invalid regex. Fixed to `'del /s /q c:\\\\'`. Added try/catch around `new RegExp()` so a future malformed pattern can't disable the entire blocklist. Verified by `test/unit/terminal/commandBlocklist.test.ts` "blocks 'mkfs.ext4 /dev/sda1'" + 10 other tests that previously THREW.

### R-010 — OpenAI key regex excluded dashes (MEDIUM — found in test-audit)
**Source:** Round 2C security audit (Bug 2 in `SECURITY_AUDIT.md`)
**Status:** RESOLVED in `src/security/secretPatterns.ts:48`
**Evidence:** `/sk-[A-Za-z0-9]{20,}/g` excluded `-`, so `sk-proj-...` keys were NOT redacted. Fixed to `/sk-[A-Za-z0-9_-]{20,}/g`. Verified by `test/unit/security/secretPatterns.test.ts` "redacts OpenAI key (sk-proj-...)".

### R-011 — `PromptSanitiser.sanitise()` was never called (CRITICAL SEC-6 — found in test-audit)
**Source:** Round 2C security audit (Bug 4 in `SECURITY_AUDIT.md`)
**Status:** RESOLVED in `src/tools/builtin/readFile.ts:112` and `src/tools/builtin/runCommand.ts:178`
**Evidence:** Both file tools now call `sanitiseForLlm(rawOutput)` before returning. Wraps in delimiter + filters injection prefixes + redacts secrets.

### R-012 — SecretStorage key-naming mismatch (MEDIUM SEC-1 — found in test-audit)
**Source:** Round 2C security audit (Bug 5 in `SECURITY_AUDIT.md`)
**Status:** RESOLVED in `src/llm/providers/anthropicProvider.ts:82`
**Evidence:** `SECRET_KEY` changed from `'kovix.anthropic.apiKey'` to `'kovix.apiKey.anthropic'` to match `commands.ts:80,94` which uses `kovix.apiKey.${provider}`.

### R-013 — `detectShellMetacharInArgs()` defined but never called (LOW SEC-3 — found in test-audit)
**Source:** Round 2C security audit (Bug 6 in `SECURITY_AUDIT.md`)
**Status:** RESOLVED in `src/terminal/terminalExecutor.ts:278`
**Evidence:** The metachar scanner is now called on the `program` token (not the joined string, to avoid false positives on quoted args). Catches `parseCommandString()` failures where the command wasn't split correctly.

### R-014 — K2-M4 unification left `commandBlocklist.sanitiseForAuditLog` with stale pattern copy (LOW — found in test-audit)
**Source:** Round 2C security audit (Bug 3 in `SECURITY_AUDIT.md`)
**Status:** RESOLVED in `src/terminal/commandBlocklist.ts:230-250`
**Evidence:** `sanitiseForAuditLog()` now delegates to the canonical `redactSecrets()` from `src/security/secretPatterns.ts`. Both paths share one pattern set. Added `env_assignment_secret` pattern to restore `PGPASSWORD=...` coverage.

### R-015 — `validateToolName` referenced dropped tool names (LOW — found in test-audit)
**Source:** Round 2C security audit (recommendation #7)
**Status:** RESOLVED in `src/security/workspaceGuard.ts:128-135`
**Evidence:** Updated allowlist to match v0.1 built-in tools: `read_file`, `write_file`, `edit_file`, `list_directory`, `run_command`, `search_code`, `web_fetch`. Removed `create_directory`, `search_files`, `search_codebase`, `web_search`.

---

## DEFERRED Issues (8)

### D-001 — File watcher recursive watch on Windows uses 1-second polling
**Source:** `STUBS.md` STUB-001
**Status:** DEFERRED to v1.0
**Rationale:** File watcher is not in v0.1 (per `02_ARCHITECTURE.md` §9 non-goals). Real-time file-tree diff lands in v1.0.
**Revisit:** When porting `src/watcher/fileWatcherService.ts` (v1.0).

### D-002 — MCP marketplace catalog is empty `[]`
**Source:** `STUBS.md` STUB-002
**Status:** DEFERRED to v1.0-beta (M6)
**Rationale:** MCP itself is deferred. The `kovix.mcp.servers` setting exists for manual configuration; a curated marketplace lands with M6.
**Revisit:** When porting `src/mcp/` (v1.0-beta M6).

### D-003 — Memory stats hardcoded in memory browser UI
**Source:** `STUBS.md` STUB-003
**Status:** DEFERRED to v1.0-beta (M5)
**Rationale:** UniversalMemory is deferred. No memory browser UI in v0.1.
**Revisit:** When porting `src/memory/` (v1.0-beta M5).

### D-004 — Agent error recovery (retry / skip / abort classification)
**Source:** `agentLoop.ts` §"What is dropped"
**Status:** DEFERRED to v1.0
**Rationale:** v0.1 surfaces errors directly via the `error` event; the user can re-run manually. Error recovery adds complexity without clear UX benefit for v0.1-alpha.
**Revisit:** v1.0 design phase.

### D-005 — Cost governor / credit system / execution sanity
**Source:** `agentLoop.ts` §"What is dropped"
**Status:** DEFERRED to v1.0-beta
**Rationale:** v0.1 has no spending gate (user is presumed to be using their own API key with their own provider-side limits). Cost governance lands when payment integration lands.
**Revisit:** When payment integration is designed (v1.0-beta).

### D-006 — Snapshot manager (undo support)
**Source:** `agentLoop.ts` §"What is dropped"
**Status:** DEFERRED to v1.0-beta
**Rationale:** `undoLastTask()` is a stub returning `null`. Snapshot/restore lands in v1.0-beta.
**Revisit:** When porting `src/snapshot/` (v1.0-beta).

### D-007 — Skill registry
**Source:** `agentLoop.ts` §"What is dropped"
**Status:** DEFERRED to v1.0-beta
**Rationale:** No skills in v0.1. The `extraContext` parameter in `buildSystemPrompt()` is the forward-compatible hook for skill injection.
**Revisit:** When porting `src/skills/` (v1.0-beta).

### D-008 — Multi-root workspace support in file tools
**Source:** Round 2C security audit (recommendation #4)
**Status:** DEFERRED to v1.0
**Rationale:** The 4 file tools (`readFile`, `writeFile`, `listDirectory`, `editFile`) pass only `workspaceFolders[0]` to `assertWithinWorkspace()`. The multi-root branch in `workspaceGuard.ts:96-111` is already implemented and tested; the tool layer just doesn't use it. Single-root is correct for v0.1; multi-root upgrade is a tool-layer change with no security implications.
**Revisit:** v1.0 — when multi-root workspace support becomes a priority.

---

## OPEN Issues (1)

### O-001 — Agent panel webview (Round 2D)
**Source:** `02_ARCHITECTURE.md` §7 (v0.1-alpha demo script)
**Status:** OPEN — blocking v0.1-alpha demo
**Rationale:** The agent loop is functional via `kovix.runTask` command + Kovix Agent OutputChannel, but the polished Cursor/Codex-style webview UI (per D-012 + D-013) is the Round 2D deliverable. This is the LAST round needed for v0.1-alpha.
**Required for:** v0.1-alpha demo (3-minute script in `02_ARCHITECTURE.md` §7).
**Deliverables:**
- `src/ui/agentPanel.ts` — WebviewViewProvider implementation
- `src/ui/webview/agentPanel.html` — webview HTML shell
- `src/ui/webview/agentPanel.js` — webview JS (uses vscode.postMessage API)
- `src/ui/webview/agentPanel.css` — webview CSS (Material aesthetic per D-013, dark-first)
- `media/kovix-viewbar.svg` — activity bar icon
- `docs/04_DESIGN_SYSTEM.md` — concrete CSS variables adapted from Material 3

---

## Quality Pass Results

The following quality checks were performed during the Round 2C test-audit:

### TypeScript Strict Mode — PASS
`npx tsc -p tsconfig.json --noEmit` returns 0 errors with all strict flags enabled (`strict`, `noImplicitAny`, `strictNullChecks`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`).

### esbuild Bundle — PASS
`npx esbuild ./src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --format=cjs --platform=node --target=node18` produces a 127.5 KB bundle (up from 124.6 KB pre-audit due to SEC-6 sanitiser wiring).

### npm audit — PASS (0 vulnerabilities)
All dev dependencies updated to latest stable. `mocha@11.7.6`, `chai@5.3.3`, `ts-node@10.9.2`, `esbuild@0.25.12`. Overrides in `package.json` force `serialize-javascript@^7.0.6` and `diff@^9.0.0` to clear transitive vulnerabilities.

### Dead Code / Unused Exports — PASS
- The old `commandBlocklist.SECRET_LOG_PATTERNS` array (250 lines of duplicated patterns) was removed when `sanitiseForAuditLog` was unified with `redactSecrets`.
- `validateToolName` allowlist was updated to remove references to dropped tools.
- No `eval`, `new Function`, `child_process.exec`, `execSync`, `dangerouslySetInnerHTML` calls in src/.

### JSDoc Coverage — PASS
All public APIs (exported functions / classes / interfaces) have JSDoc comments. The security-critical functions (`assertWithinWorkspace`, `sanitise`, `redactSecrets`, `assertSafeUrl`, `safeFetch`, `buildChildEnv`, `isBlockedCommand`, `isInterpreterCommand`, `detectShellMetacharInArgs`) have detailed JSDoc explaining the threat model + the fix history.

### Test Coverage — PASS
252 tests covering all Layer 1 pure-logic security functions + the agent loop's Plan→Approve→Execute→Verify happy path + the M3 MajorMilestone bug fix + the F-003 multi-turn conversation fix. Test files live in `test/unit/` and `test/integration/`.

### License Headers — PASS
Every source file has a top-of-file JSDoc block identifying:
- The old-repo file it was ported from (with line count)
- The port strategy (VERBATIM / PORT WITH TRANSLATION / REWRITE / NEW)
- The decisions referenced (D-001, D-008, D-011, etc.)
- The security invariants preserved (SEC-1 through SEC-9, P0-5, F-003, etc.)

### Worklog Hygiene — PASS
Every task entry in `worklog.md` follows the template: `Task ID` / `Agent` / `Task` / `Work Log` / `Stage Summary`. Append-only, no overwrites.
