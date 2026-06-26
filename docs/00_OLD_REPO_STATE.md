# State of the Old Repo (Kovix_2.0) — Plain-Language Brief

**Date:** 2026-06-27
**Author:** Rebuild lead (agent session)
**Audience:** Project owner (non-engineer)
**Source repo:** `https://github.com/Razisafir/Kovix_2.0` (commit on `main` as of clone)
**Repo size:** ~8,194 tracked files; ~5,195 in `src/`, ~2,051 in `extensions/`

> Purpose: a one-page, jargon-light picture of what we have to work with before we decide what to keep, rewrite, or drop. Companion file `00_FILE_SUMMARIES.md` has the per-document detail (plain-language summary of each of the 12 audit docs read for this brief).

**Note on provenance:** The original Kovix codebase was vibe-coded by a non-engineer over several months (per project owner). On top of that original mess, a recent methodical audit pass (audit docs dated 2026-03 through 2026-06) mapped much of the cruft. We are picking up that audit work — not starting from scratch, and not trusting the original code either.

---

## TL;DR

Kovix_2.0 is a **fork of VS Code / Code-OSS** with a custom AI agent bolted on. The fork itself compiles, and the agent's core flow (Plan → Approve → Execute → Verify) is real, not faked. But there are real holes: three security tools are advertised but only stubbed, the offline fallback provider is dead on the desktop build, the credit-purchase flow is fake, and the `construct → kovix` rename is half-finished. The previous owner already started a serious audit pass — we are not starting from scratch, we are picking up their work and finishing it cleanly.

---

## What's Solid (worth keeping, with review)

1. **The agent core loop is real.** `AgentLoopService` (~1,833 lines, 22 dependencies) implements Plan → Approve → Execute → Verify end-to-end. Verification is harness-controlled — the agent runs the actual test/build commands and cannot lie its way past them. This is the crown jewel and the thing that should anchor the new repo.

2. **Multi-provider LLM layer works.** 13 providers (Anthropic, OpenAI, NVIDIA NIM, OpenRouter, Ollama, LM Studio, Together, Groq, Mistral, Gemini, DeepSeek, LiteLLM, Custom). API keys are stored in the OS keychain (not plaintext). This matches the README's claims.

3. **Milestone-level human approval is real.** Pause / resume / skip on every milestone, with four autonomy modes (`EveryMilestone`, `MajorMilestone`, `Selective`, `FullAuto`). Promise-based blocking, not a fake gate.

4. **Defense-in-depth security on the agent itself.** Path-traversal guard, prompt-injection sanitizer, secret redactor, terminal command blocklist, webview CSP, MCP 30-second timeout. All wired and active.

5. **The build compiles.** TypeScript 0 errors with `--max-old-space-size=8192`. Electron 42.4.1 ABI matches across `.npmrc` and `package.json`. `protobufjs` CVE patched.

6. **The previous owner left a paper trail.** 12+ audit documents at repo root (CARTOGRAPHY_SUMMARY, STUB_AUDIT, HARVEST_CANDIDATES, etc.) already map the mess. We inherit that work; we do not redo it.

7. **18 harvestable candidates identified** across 30+ recovery branches, including a tree-sitter codebase indexer, model routing by purpose, local-only usage logging, and 9 architecture stubs that drop in cleanly.

---

## What's Stub (advertised but not real)

1. **Security tools (nmap / ghidra / nuclei) — schema only, zero execution, AND not registered.** Three `*Tool.ts` files export JSON definitions but have no handlers. They are also not registered in the live tool registry, so the LLM shouldn't even see them in its tool list — but the README still markets them. CRITICAL severity per STUB_AUDIT. If execution handlers were ever added without also wiring the opt-in gate, the LLM could call them and get silent failures.

2. **Credit purchase flow is fake.** `purchaseCredits()` opens a placeholder URL (`https://construct-ide.dev/pricing`) and returns `false`. No Stripe, no backend, no webhook. The paid tier is non-functional.

3. **Xenova offline provider is dead on desktop.** In Electron builds (the primary distribution), the sandboxed renderer blocks Worker creation. The provider honestly reports `Unreachable`. The "runs locally, fully offline" pitch only works via Ollama, not via the in-process Transformers.js path.

4. **MCP marketplace reviews return `[]`.** The catalog itself is real (fetched from GitHub), but reviews are stubbed.

5. **UniversalMemoryService scoring is keyword-only.** Embeddings are generated and stored but never consulted for retrieval — the service does keyword decomposition instead. The infra for real vector search exists but is not wired in.

6. **Agent panel first-launch is unreliable.** `openView('kovix.agentPanel', false)` doesn't expand a hidden auxiliary bar. Fix is documented in HARVEST_CANDIDATES but not yet applied to main.

---

## What's Risky (needs careful handling)

1. **Security tooling requires explicit user sign-off before porting.** Per the project rules, anything under `extensions/kovix-security-tools/` (and the three `*Tool.ts` files in `src/`) cannot be migrated until you confirm intended use is defensive / owned-systems only. The README already says they require two-step opt-in (enable extension + set `kovix.enableSecurityTools = true`), but the execution handlers don't exist.

2. **Licensing is mixed and must be deliberate.** The repo is marked "Proprietary" but is built on Code-OSS (MIT). `NOTICE.md` and `ThirdPartyNotices.txt` exist and must be carried forward IF we keep Code-OSS as the base. If we move off Code-OSS (e.g. build Kovix as a VS Code extension instead of a fork), the obligations change — this is a Phase 2 decision, not a default.

3. **Secrets scan: 0 real secrets found.** gitleaks found 79 history findings — all are either VS Code's inherited Application Insights telemetry keys (low risk, write-only) or fake test fixtures in `tests/python/test_security.py`. The working tree is clean. We still must never copy any file containing real keys into fresh.

4. **Three competing design-token systems.** Teal (canonical, current), Legacy Violet (undead fallbacks), Construct (undefined vars). Plus 58 product-level naming inconsistencies where "Construct" still appears where "Kovix" should. A future contributor reading `design-system/kovix/MASTER.md` would build against the wrong palette.

5. **Half-finished `construct → kovix` rename.** 58 product-level identifiers still say "Construct" where they should say "Kovix". ~40 feature-level references correctly stay as "Construct" (it's the name of the agent feature, like "IntelliSense"). Telling them apart requires the NAMING_AUDIT table.

6. **18 npm audit vulnerabilities.** Mostly in transitive dev dependencies. Two HIGH (serialize-javascript RCE, tar arbitrary file write) should be updated when possible. Not blocking.

---

## What's Actively Broken

1. **`npm install` (without `--ignore-scripts`) fails on Linux without root.** `native-keymap` can't build without `libxkbfile-dev`. Workaround exists (manual `.deb` extraction), but on a fresh dev machine this is the first wall you hit. On Windows/macOS, system libs are bundled.

2. **`MajorMilestone` autonomy mode silently behaves like `FullAuto`.** `shouldPauseAt()` has no branch for `'major_milestone'` and falls through to `return false`. Users who pick this mode thinking they'll get major-milestone pause get fully autonomous instead. Documented in CARTOGRAPHY_SUMMARY.

3. **`skipCurrentMilestone()` is identical to `resumeFromMilestone()`.** The Skip button is a lie — both resolve the Promise and mark the milestone completed. Fix is on branch `fix/skip-milestone-real-semantics`, ready to harvest.

4. **`gitleaks` scan in CI is not running.** Phase 2 gate incomplete. The local scan was run manually and passed, but CI defense is missing.

5. **Stale settings in `kovix-build-test.yml` workflow.** The CI workflow writes settings keys that don't match what the actual code registers. If the workflow runs, it silently no-ops the agent configuration.

> Note: The `.npmrc` deprecated-keys issue (originally on this list) is **resolved** — see BUILD_STATUS §6.2. `target`/`runtime`/`ms_build_id`/`arch` migrated to `package.json` config; remaining `.npmrc` keys are not deprecated.

---

## What We Inherit From Past Audit Work (use, don't redo)

The previous owner already produced these audits at repo root. We treat them as raw material, verify against current code, and only re-derive what's stale:

| Document | What it gives us |
|---|---|
| `CARTOGRAPHY_SUMMARY.md` | The one-page map. Start here. |
| `STUB_AUDIT.md` | 14 stubs ranked CRITICAL/HIGH/MEDIUM/LOW. Most detailed audit. |
| `HARVEST_CANDIDATES.md` | 18 features across 30 recovery branches, classified HARVEST / NEEDS-REWORK / DISCARD. |
| `NAMING_AUDIT.md` | The 58 product-level vs ~40 feature-level "Construct" references, with line numbers. |
| `AGENT_CORE_MAP.md` | File-by-file map of every agent execution file, with wiring status. |
| `BUILD_STATUS.md` | What compiles, what doesn't, and the exact `npm install` workaround. |
| `BLOCKERS.md` | 5 active blockers + resolutions, with one already resolved. |
| `SECURITY_AUDIT.md` | gitleaks results, defense cross-checks, and the innerHTML safety audit. |
| `STUBS.md` | Smaller stub list (4 entries) — partially superseded by STUB_AUDIT. |
| `docs/DECISIONS-v1.8.0.md` | Three binding v1.x decisions: multi-agent IS in scope, cost governor IS in vision (but inert), GOD Mode is a launch-readiness ceremony (not a power feature). |

---

## What's Missing

1. **`AGENTS.md`** — listed in the original instructions but does not exist in the old repo. We'll create one in fresh as part of Phase 7 (Maintenance Plan) so future agent sessions have a stable entry point.

2. **A clear product scope.** The README markets 13 providers, 6 agent modes, MCP, semantic memory, security tools, design intelligence, behavioral rules, and a credit system. We don't yet know which of these are Must / Should / Won't for v1 of the new repo. That's the Phase 1 interview.

3. **A decision on the base.** Code-OSS fork is a massive maintenance burden (you rebase against upstream VS Code constantly). The previous owner chose it; we should not assume it's right for fresh. Phase 2 will examine alternatives (VS Code extension, Theia, standalone Electron + Monaco, web-only).

---

## Bottom Line for the User

The old repo is **messy but not broken**. The hard part — building a real Plan→Approve→Execute→Verify agent loop with harness-controlled verification — is done and works. The mess is in the surrounding productization: half-finished renames, fake purchase flows, stubbed security tools, dead offline fallback, three competing design systems.

For the rebuild, the right move is: **keep the agent core idea, drop the cruft, decide deliberately what product shape we want, and don't carry forward anything we can't explain in one sentence.**

Phase 1 (the requirements interview) is the next step. We need you to tell us, in plain language, what Kovix is for and which of the old repo's advertised features actually matter to you.
