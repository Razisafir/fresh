# Per-File Summaries — Kovix_2.0 Audit Docs

**Date:** 2026-06-27
**Author:** Rebuild lead (agent session)
**Audience:** Project owner (non-engineer)
**Purpose:** Plain-language summary of each of the 12 documents the rebuild lead was asked to read in full before producing `00_OLD_REPO_STATE.md`. Use this as a reference when a section of the state brief references a specific finding — you can come here to see what the source document actually said.

The 12 files were specified in the project instructions. 11 of them exist in Kovix_2.0; 1 (`AGENTS.md`) does not. Each summary below is ~150–250 words and avoids jargon where possible.

---

## 1. `README.md` (318 lines)

**What it is:** The public-facing readme of the old repo. This is what a GitHub visitor sees first.

**Plain-language summary:** Kovix is described as an "AI-native development environment" built on a VS Code fork. The headline feature is an autonomous coding agent in a right-side panel — like Cursor's composer or Claude Code, but embedded in the IDE. The agent can read/write files, run terminal commands, search the codebase semantically, browse the web, call MCP servers, and spawn sub-agents, all with human approval before applying changes.

The readme markets 13 LLM providers (Anthropic, OpenAI, NVIDIA NIM, OpenRouter, LM Studio, Together, Groq, Mistral, Gemini, DeepSeek, Ollama, LiteLLM, Custom), all configured with user-owned API keys stored in the OS keychain. It advertises 6 built-in agent modes (General, Architect, Coder, Reviewer, Debugger, Ask), MCP server support, semantic memory via Qdrant + BM25 fallback, internet research via Agent Reach, a UI/UX design skill called "UI-UX Pro Max", a "Ponytail" behavioral rules system (lazy senior dev mindset), and three security tools (nmap, ghidra, nuclei) behind a two-step opt-in.

The readme links to releases for Windows, macOS, and Linux. It mentions v1.8.0 is "in development" with a verification-gap fix, cost governor + credit system, and the construct→kovix rename. It says multi-agent swarm is **not** in v1.x — but per DECISIONS-v1.8.0.md, this was later reversed and swarm IS in v1.8.0. The readme is stale on that point.

---

## 2. `AGENTS.md` — **DOES NOT EXIST**

**What it is:** Listed in the project instructions as a file to read, but it does not exist in Kovix_2.0.

**Plain-language summary:** N/A. The previous owner never created an `AGENTS.md`. The project instructions call this out implicitly: "AGENTS.md — listed in the original instructions but does not exist in the old repo" (per the existing state brief). We will create one in `fresh` as part of Phase 7 (Maintenance Plan) so future agent sessions have a stable entry point that documents how to work in this codebase, what conventions to follow, and where to find things.

---

## 3. `AGENT_CORE_MAP.md` (513 lines)

**What it is:** A file-by-file map of every piece of code that implements the agent's execution logic. The most detailed technical audit doc.

**Plain-language summary:** This document confirms the agent's core loop — Plan → Approve → Execute → Verify — is **real, not faked**. The single canonical implementation is `AgentLoopService` (1,833 lines of code, 22 injected dependencies). It runs the LLM in multi-round loops (max 50 rounds per milestone), calls tools, and verifies its own work by running the actual test/build commands in the workspace (not by asking the LLM whether it succeeded).

The map walks through the full execution flow: user types a task → agent plans it → user approves the plan with one of four autonomy modes (EveryMilestone, MajorMilestone, Selective, FullAuto) → agent executes milestone by milestone → after each milestone, the harness runs verification → if verification fails or the mode says to pause, the agent blocks on a Promise until the user clicks Resume or Skip.

It confirms three layers of defense against hallucinated success: (1) harness-controlled verification that the LLM cannot bypass, (2) an "execution sanity" service that catches things like "exit code 0 but stderr says 'error'", and (3) per-tool-call sanity checks. It also confirms all 13 registered services are actually wired in and used — no dead agent-execution code was found.

The map documents the **MajorMilestone bug**: the `shouldPauseAt()` function has no branch for `'major_milestone'` — it falls through to `return false`, making MajorMilestone behave identically to FullAuto. The bug is in how the string values are checked (`'pause_at_every'` and `'selective'`) vs. how they're defined in the enum (`'every_milestone'`, `'major_milestone'`, `'selective'`, `'full_auto'`). The strings don't align.

---

## 4. `BLOCKERS.md` (229 lines)

**What it is:** A list of things blocking progress on the old repo's `feature/grand-redesign` branch, with resolutions.

**Plain-language summary:** Five blockers were tracked. Two were resolved during the audit window, three remain open.

**Resolved:** `npm run compile` + `npx tsc --noEmit` now pass with 0 errors (using `--ignore-scripts` for native modules and `--max-old-space-size=8192` for heap). The TypeScript compiles cleanly. This is no longer a blocker for code changes — only for native module packaging on Linux without root.

**Still open:**
1. **Desktop boot verification cannot run in this environment.** The audit was done in a headless Linux container with no display server. The Verifying chip UI has never been observed live. Needs a real desktop (Windows or macOS) to confirm.
2. **Stale setting names in `kovix-build-test.yml` CI workflow.** The workflow writes settings keys that don't match what the code registers. If the workflow runs, it silently no-ops agent configuration.
3. **Conflicting design-system docs.** Two design-system docs disagree on the accent color: teal `#14B8A6` (current, shipped in v1.7.1) vs. green `#22C55E` (older, superseded). A future contributor reading the wrong doc would build against the wrong palette.
4. **`gitleaks` scan not running in CI.** The local scan ran manually and passed (0 real secrets), but CI defense is missing.

The doc explicitly follows an "Iron Law" — never claim a gate passes without showing real command output. This is the discipline the rebuild inherits and should preserve.

---

## 5. `BUILD_STATUS.md` (256 lines)

**What it is:** A precise technical report on what compiles, what doesn't, and the exact workaround for getting a build to succeed.

**Plain-language summary:** The build **works**, but only with workarounds. Here's the bottom line:

- **TypeScript compilation:** ✅ 0 errors with `NODE_OPTIONS=--max-old-space-size=8192 npm run compile`. Takes about 2 minutes.
- **Full `npm install`:** ⚠️ Fails on Linux without root because `native-keymap` needs `libxkbfile-dev` system library. Workaround: `npm install --ignore-scripts` succeeds but leaves native modules unbuilt. Then manually install each extension's deps, then compile.
- **Native modules (5 of them):** ✅ All build successfully against Electron ABI 146, but `native-keymap` requires manual extraction of `libxkbfile-dev` headers from a `.deb` package and a symlink to `libxkbfile.so.1` (only without root access; on a normal dev machine, `sudo apt-get install libxkbfile-dev` and standard `npm install` works).
- **Electron version match:** ✅ `.npmrc` correctly pins Electron 42.4.1, matching `package.json`. ABI 146.
- **`.npmrc` deprecated keys:** ✅ MIGRATED. `target`, `runtime`, `ms_build_id`, `arch` moved to `package.json` config and injected as env vars by `postinstall.js` and `rebuild-native-modules.js`. Remaining `.npmrc` keys (`disturl`, `build_from_source`, `legacy-peer-deps`, `timeout`) are not deprecated.
- **`protobufjs` CVE-2023-36665:** ✅ Patched (pinned to 7.6.4 via `overrides`).
- **`npm audit`:** 18 vulnerabilities (2 low, 11 moderate, 5 high). Mostly in transitive devDependencies. Two HIGH (`serialize-javascript` RCE, `tar` arbitrary file write) should be updated but are not blocking.

The full build command sequence is documented in section 4c. The output artifacts (`out/main.js`, `out/cli.js`, `out/server-main.js`, `out/vs/`, all extension `out/` dirs) are 150 MB and confirmed present.

---

## 6. `STUBS.md` (115 lines)

**What it is:** The smaller, original stub list. Mostly superseded by the more thorough `STUB_AUDIT.md`.

**Plain-language summary:** Four stubs were originally tracked. As of the last update:

1. **FileWatcher polling fallback on Windows** — still uses 1-second polling instead of `ReadDirectoryChangesW`. Only affects real-time file-tree diff updates during test runs. Not blocking.
2. **MCP marketplace catalog is empty `[]`** — OUTDATED. The marketplace now fetches from a real GitHub registry URL.
3. **Memory stats hardcoded in memory browser UI** — RESOLVED. Stats are now computed from real data.
4. **MCP tool execution 30s timeout** — RESOLVED. The timeout is in place with `Promise.race` against a 30-second timeout. A hung MCP server rejects after 30s and the error is caught and returned as a tool failure.

The `STUB_AUDIT.md` doc explicitly verifies each of these against current code (see "STUBS.md Accuracy Check" section of STUB_AUDIT). Use STUB_AUDIT as the source of truth; this file is kept for historical context only.

---

## 7. `STUB_AUDIT.md` (258 lines)

**What it is:** The detailed, current stub audit. 14 stubs ranked by severity. The most thorough audit doc.

**Plain-language summary:** 14 stubs total. Severity breakdown: 1 CRITICAL, 3 HIGH, 5 MEDIUM, 5 LOW.

**CRITICAL (1):**
- **C-1 — Security tool definitions are schema-only with zero execution.** Three files (`nmapTool.ts`, `ghidraTool.ts`, `nucleiTool.ts`) export JSON tool definitions but have no execution handlers. They're also not registered in the tool registry (see L-3), so the LLM shouldn't see them — but the README still markets them.

**HIGH (3):**
- **H-1 — EmbeddingService returns zero vectors when no backend is available.** Memory search silently degrades from semantic to keyword-only with no clear user indication. The UI badge says "Keyword fallback" which is technically accurate, but the quality cliff is steep.
- **H-2 — CreditSystemService.purchaseCredits() is fake.** Opens placeholder URL `https://construct-ide.dev/pricing` and returns `false`. No Stripe, no backend, no webhook. Paid tier is non-functional.
- **H-3 — XenovaProvider is unreachable on Electron desktop.** Sandbox blocks Worker creation. Honestly reports `Unreachable`. The "offline fallback" is permanently dead on the primary distribution channel.

**MEDIUM (5):** MCP marketplace reviews return `[]` (placeholder); UniversalMemoryService uses keyword decomposition not cosine similarity on embeddings; `upgradeFlow()` opens placeholder URL; `ConstructMemoryService` stores API key in plaintext via `IStorageService` (not OS keychain); `FileWatcherService` has dual debounce pipelines causing 400ms latency.

**LOW (5):** `CloudProvider.checkAnthropicStatus()` validates key format not connectivity; AgentLoop tests mock all dependencies instead of exercising real code; security tools not registered in `ToolRegistry`; `ConstructMemoryService.getProfile()` and `searchMemories()` return empty arrays when not initialized; MCP marketplace fetches from public GitHub raw URL with no integrity check.

Each stub includes: file & lines, what it claims, what's actually there, what real implementation needs, and severity justification. This is the document to consult when deciding whether to port a specific feature.

---

## 8. `SECURITY_AUDIT.md` (219 lines)

**What it is:** Fresh security audit run against the `feature/grand-redesign` branch. Required by Phase 2.2 of the old repo's grand launch prompt.

**Plain-language summary:** **Audit result: PASS.** No real secrets leaked.

The audit ran gitleaks v8.21.2 as a static Linux binary (the `npx gitleaks` approach failed because gitleaks is a Go binary, not an npm package). Two scans were run:

- **Working tree (no git history):** 82 findings, ALL inside `vendor-skills/` (gitignored, not committed). These are example payloads in cybersecurity-skill documentation — sample JWTs, sample API keys like `kismet:kismet`, sample tokens. Not real secrets.
- **Full git history (495 commits):** 79 findings. All 79 fall into two accepted categories:
  - **SEC-1:** ~30 findings are Microsoft Application Insights `aiKey` values in inherited VS Code extension `package.json` files. LOW risk — these are write-only telemetry ingestion keys, shipped in the clear by VS Code itself, and identical across all VS Code forks. Microsoft controls read access via Azure RBAC.
  - **SEC-2:** 3 findings are test-fixture fake API keys in `tests/python/test_security.py` (`sk-1234567890abcdef`, `sk-test-12345678`, `sk-secret-12345`). Clearly fake, would not authenticate against any real provider. Suppressed via `.gitleaksignore`.

The audit also cross-checked Kovix's own defenses against the prompt-injection and LLM-guardrails skill checklists. All 6 defenses match: prompt injection sanitiser, secret redactor, workspace guard, URL guard, terminal blocklist, webview CSP. **No new attack surface** was introduced by the Phase 1 verification harness code.

The `constructOnboarding.ts` `innerHTML` audit (SEC-8) confirmed all `innerHTML` assignments are static HTML templates with zero dynamic interpolation. Safe by construction.

---

## 9. `HARVEST_CANDIDATES.md` (316 lines)

**What it is:** A list of every commit on non-main branches that has value for the rebuild. Each candidate is classified HARVEST, NEEDS-REWORK, or DISCARD.

**Plain-language summary:** 30 candidates reviewed across multiple recovery branches. 18 are worth harvesting (5 high-priority, 3 medium-priority with rework, 9 low-priority drop-in stubs, 1 manual-apply). 12 are discarded (superseded or already on main).

**Priority 1 — High-Value, Ready to Harvest (5):**
1. **Tree-sitter codebase indexing** — Most valuable single feature. Regex-based parser for 10+ languages, semantic chunking, hybrid vector+keyword search, dependency graph. NEEDS-REWORK: depends on a deleted `ISemanticMemoryService` interface; must rewire to `IUniversalMemoryService`. ~2-3 days rework. The pure-logic files (`treeSitterParser.ts`, `indexingTypes.ts`) can be harvested with zero changes.
2. **Skip milestone real semantics** — Critical behavioral fix. On main, `skipCurrentMilestone()` is identical to `resumeFromMilestone()`. The Skip button is a lie. Clean cherry-pick.
3. **Richer auto-extract for UniversalMemory** — Currently only learns from the 500-char task summary. This enriches extraction with full conversation history, failed tool results, and repeatedly-read files. Clean cherry-pick.
4. **Model routing by purpose** — Currently every AI operation uses the same active model (wasteful). This adds `ModelPurpose` type (autocomplete/inline-edit/agent-plan/agent-execute/chat/embedding) and a routing decision function. Pure-logic file, no VS Code imports, fully unit-testable.
5. **Local-only usage log** — Fills critical observability gap. Writes usage events to `~/.kovix/logs/usage.jsonl` as JSON Lines — never sends data anywhere. 15 typed event names.

**Priority 3 — Architecture stubs (9):** Background agent scheduler, composer multi-file review panel, plugin system, air-gap installer, Kali integration pack, local RAG helpers, MCP marketplace helpers, ponytail review helpers, onboarding provider test helpers. All pure-logic, zero-dependency, can be dropped in as placeholders.

**Discard (12):** Mostly phase-1→5 fix branches already merged to main, monolithic recovery stacks incompatible with main's modular architecture, and Dependabot bumps.

Estimated effort: P1 = 3-4 days, P2 = 7-10 days, P3 = 1-2 days.

---

## 10. `CARTOGRAPHY_SUMMARY.md` (73 lines)

**What it is:** The one-page map. Start here when orienting.

**Plain-language summary:** The old repo has **7 active UI surfaces** (agent chat panel, memory browser, memory graph, control center dashboard, agent settings, inline agent, onboarding/welcome) and 0 orphaned ones. 48 registered commands. 10 workbench contributions (status bar, brand chrome, splash, autocomplete, etc.).

**One canonical agent core** exists: `AgentLoopService`. No dead agent code found — everything registered is wired and consumed. The previous concern about multi-agent swarms being disconnected from the primary loop is intentional: the swarm coordinator exists for the `kovix.openSwarm` parallel-swarm feature, separate from the primary Plan→Approve→Execute→Verify loop.

**The three biggest blockers to launch right now:**
1. `npm install` failure on `native-keymap` (needs `libxkbfile-dev`) — biggest blocker for fresh dev environments.
2. Three competing design token systems + 58 naming inconsistencies — the product presents itself incorrectly to users (purple fallbacks where it should be teal, dead brand references, broken self-referential links).
3. `MajorMilestone` bug — one of the four advertised autonomy modes is silently broken.

The doc lists 7 Phase 1 audit documents at repo root as the inheritance: `NAMING_AUDIT`, `UI_SURFACE_MAP`, `AGENT_CORE_MAP`, `STUB_AUDIT`, `BUILD_STATUS`, `DESIGN_TOKEN_INVENTORY`, and itself. All marked Complete.

---

## 11. `NAMING_AUDIT.md` (428 lines)

**What it is:** The 58 product-level vs ~40 feature-level "Construct" references, with line numbers.

**Plain-language summary:** Two distinct concepts share the word "Construct" in the old repo:
- **KOVIX** = the product/application name (should replace "CONSTRUCT" / "CONSTRUCT IDE" everywhere it appears as a product reference).
- **Construct** = ONE feature inside Kovix: the agent panel that implements the plan→approve→execute→verify loop (like "IntelliSense" inside VS Code). The `construct.*` command IDs, feature references, and service decorators must NOT be renamed.

**58 product-level issues** were identified across 17 file groups: CLI Rust source, Windows installer config, Windows i18n messages (13 locale files), Electron build config, Azure Pipelines YAMLs, Darwin signing, build gulpfiles, extension branding, source code product references, file header comments, shell scripts, theme extensions. Most are user-visible strings ("Updating CONSTRUCT IDE..." → "Updating Kovix IDE..."), broken self-referential links (`CONSTRUCT-VSCODE` → `KOVIX`), or stale domain references (`construct-ide.com` / `construct-ide.dev` / `construct.dev` → `kovix.dev`).

**~40 feature-level references are correctly kept as "Construct"**: all `construct.*` command IDs and setting keys, service decorator IDs (`'construct.agentLoop'`, etc.), storage keys, URI scheme identifiers (`construct`, `construct-remote`, etc. — 24 internal protocol handlers, deferred as breaking changes), file paths under `contrib/construct/` and `platform/construct/`, CSS class names (`.construct-file-tree-diff`), and the `.construct-workspace` file extension.

A Phase 6 re-triage addendum (2026-06-26) found an additional ~4,875 references in the `--construct-*` CSS theme variable namespace (543 unique variables) that the original audit missed because it only covered CSS class names, not CSS custom properties. All Bucket (B) items are now FIXED.

**3 broken self-referential links** remain: `extensions/microsoft-authentication/media/index.html`, `extensions/github-authentication/media/index.html`, and `docs/archive/internal-pre-launch/GROUND_TRUTH_DESKTOP.md` all link to `Razisafir/CONSTRUCT-VSCODE` (a non-existent repo) instead of `Razisafir/KOVIX`.

---

## 12. `docs/DECISIONS-v1.8.0.md` (223 lines)

**What it is:** Three binding v1.x architecture decisions, with full reasoning grounded in actual code reading.

**Plain-language summary:** Three questions were answered:

**Decision 1 — Multi-agent IS in scope for v1.x.** The phase-28-launch implementation is REAL (3,123 lines across 4 files: `AgentRole` enum with 5 roles, `AgentTask` lifecycle, `AgentHandoff` between roles, `AgentConflict` detection, `SharedMemory` keyed store). It was ported to main: `multiAgentExecution.ts` (141 lines) + `multiAgentExecutionService.ts` (595 lines) = 736 lines ported verbatim. The `kovix.openSwarm` command was rewritten to use it. `parallelSwarm` and `swarmSize` config flags were undeprecated. **Limitations in v1.8.0:** no automatic role dispatch, no swarm UI in Control Center, no conflict resolution UI — all deferred to v1.9.0.

**Decision 2 — Cost governor / credit system IS part of v1.x vision, but currently inert.** The interfaces are on main (`creditSystem.ts`, `pricingTypes.ts`, `creditSystemService.ts`, `executionSanity.ts`, `executionSanityService.ts`) but **zero call sites in `agentLoop.ts`**. The agent loop makes LLM calls without debiting credits, executes milestones without checking the cost governor, and runs verification without consulting execution sanity. The services are registered as singletons but never invoked. Three issues (#140, #141, #142) were filed to track wiring. **GOD Mode depends on these being real**, so porting GOD Mode forces the wiring.

**Decision 3 — GOD Mode is a launch-readiness ceremony, not a power feature.** Despite the name, GOD Mode is NOT "all-powerful agent mode". It has two components: (1) `ILaunchChecklist` — 15 automated pre-launch validation checks; (2) `IGodModeActivator` — a credit-gated autonomous session with state machine (Inactive → Countdown → Active → Paused → Stopped), git checkpoint before activation, automatic rollback on stop. The name was chosen for marketing impact, not technical accuracy. **Decision: document the real behavior, do NOT port to main in v1.x.** The launch checklist should be extracted as a separate smaller feature (`Kovix: Run Launch Checks` command), and "GOD Mode" should be renamed before any user-facing surface ships.

These three decisions are binding for v1.x and should be revisited at v2.0 planning.
