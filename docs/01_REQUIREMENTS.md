# 01_REQUIREMENTS.md — Kovix v1 Requirements

**Date:** 2026-06-27 (last revised 2026-06-27 per D-008/D-009/D-010)
**Author:** Rebuild lead (agent session)
**Audience:** Project owner (non-engineer) + future contributors
**Source:** Phase 1 requirements interview + `docs/00_OLD_REPO_STATE.md` + binding decisions D-008 / D-009 / D-010 from project lead

> Scope: what `fresh` (the new Kovix repo) must ship for v1. Every feature listed here came from the user's interview answers. TheMust/Should/Won't structure is the standard software-engineering way to make scope explicit so we can defend it later.

---

## TL;DR

Kovix v1 is an AI-native IDE for **solo developers and tinkerers** who want a Cursor/Claude Code-style agent they fully own — their keys, their cost, their machine, no subscription, no telemetry. **Per binding decisions D-008 / D-009 / D-010 from the project lead, scope has been reduced from the original Phase 1 interview answers.** The MUST list now contains 6 features (down from 8): multi-provider LLM, agent core loop, agent modes, MCP, semantic memory, plus the editor base. **Multi-agent swarm (M7) is deferred to v1.1** (D-009). **Security tools (M8) are dropped from v1 entirely, deferred to v2.0-maybe** (D-008). The base architecture (originally "VS Code fork" per D-004) is being re-evaluated in `docs/02a_ARCH_CHOICE_MATRIX.md`; recommendation is to switch to a VS Code extension, pending user sign-off. Windows remains the first target platform.

**Timeline framing (per D-010):** the user's flagged budget/timeline pressure is treated as soft-but-real. Every remaining tradeoff in Phase 2+ is optimized for "fastest path to a usable, demoable v1" over feature completeness. When in doubt between extending the timeline and cutting scope, cut scope. §4 reflects this with a tighter shipping order and reduced v1.0 estimates.

---

## 1. User Decisions (from Phase 1 interview)

| Dimension | Decision | Notes |
|---|---|---|
| **Audience** | Solo developers and tinkerers | Cursor/Claude Code-like, fully user-owned, no subscription, no telemetry |
| **Base architecture** | VS Code / Code-OSS fork (same as old repo) | New repo (`fresh`), not a fork of Kovix_2.0. Rebuild from scratch using files from old repo only after character-by-character review |
| **Platforms** | Windows first | Then macOS, then Linux |
| **Involvement** | Medium — only big calls | Default: lead decides and documents in DECISIONS.md. Ask user only on: licensing ambiguity, security tools, irreversible architecture choices |
| **Constraint flagged** | Budget / timeline pressure | Affects harvest-vs-rewrite tradeoff. §4 sub-prioritizes MUST to ship a usable slice early |
| **Workflow** | Standard SDLC, step-by-step | No bulk copy from Kovix_2.0. Every file reviewed before migration (per-file audit template in project instructions §5). Acknowledged duplicates across branches — will reconcile during Phase 3 |

### Personal context acknowledged

The user has ADHD and the previous codebase grew in multiple directions simultaneously, leading to confusion. To support this:
- Documents will be scannable (tables, checklists, short paragraphs)
- Each phase will have explicit entry/exit criteria
- Decision log will be a single source of truth — no need to remember across sessions
- Next steps will always be explicit at the end of each report

---

## 2. MUST Ship in v1

These are non-negotiable for v1 launch. Listed in proposed shipping order (critical path first), not alphabetical.

### M1. VS Code extension as base (revised per D-011)
**What:** Kovix ships as a VS Code extension (`.vsix`), NOT a Code-OSS fork. Users install stock VS Code (or VS Code Insiders), then install Kovix from the marketplace or via direct `.vsix` download. The extension provides webview-based UI panels, commands (`Kovix: ...`), configuration contributions (`kovix.*` namespace), and background services (file watcher, embedding service, vector store).
**Why:** Per D-011, the agent core in Kovix_2.0 is VS Code-shaped but not deeply coupled — portable to extension form with mechanical translation. Extension route cuts v1.0 timeline from 11-15 weeks (fork) to 5-8 weeks, eliminates upstream rebase burden, and removes native module compilation pain. See `docs/02a_ARCH_CHOICE_MATRIX.md` for the full comparison.
**Carries:** No MIT attribution chain from Code-OSS source tree (we don't redistribute Code-OSS). Extension's own license TBD (D-014 will be logged).
**Source:** Fresh extension project scaffolded in `fresh/`. Port agent-core files from Kovix_2.0 per the mapping table in `docs/02_ARCHITECTURE.md` §6, with per-file audit per D-001.
**Supersedes:** D-004 (VS Code fork as base). D-004 retained in DECISIONS.md for history but no longer active.

### M2. Multi-provider LLM layer
**What:** 13 providers — Anthropic, OpenAI, NVIDIA NIM, OpenRouter, LM Studio, Together, Groq, Mistral, Gemini, DeepSeek, Ollama, LiteLLM, Custom. All configured via user-owned API keys stored in OS keychain (not plaintext).
**Why:** Core differentiator vs Cursor (subscription) and Claude Code (Anthropic-only). Matches old repo's working implementation.
**Source for porting:** `src/vs/platform/construct/common/llm/` + `src/vs/workbench/contrib/construct/browser/services/llm/` — audited in AGENT_CORE_MAP.md §2.2 as fully wired and functional.

### M3. Agent core loop (Plan → Approve → Execute → Verify)
**What:** Single canonical `AgentLoopService` implementing:
- Plan (LLM multi-round loop with read-only tools)
- Approve (user picks autonomy mode + can deselect steps)
- Execute (milestone-by-milestone, LLM + tools, staged writes)
- Verify (harness-controlled: runs actual `npm test` / `npm run build` / `npx tsc --noEmit`)
- Four autonomy modes: EveryMilestone, MajorMilestone, Selective, FullAuto
- Milestone pause/resume/skip with Promise-based blocking
- Verification failure always pauses (overrides mode)
**Why:** Crown jewel of old repo. The thing that makes Kovix different from a chat bot. Fully implemented in old repo's `AgentLoopService` (1,833 lines, 22 deps) — needs careful port, not rewrite.
**Known bugs to fix during port (NOT carry forward):**
- MajorMilestone mode silently behaves like FullAuto (`shouldPauseAt()` missing branch for `'major_milestone'`)
- `skipCurrentMilestone()` is identical to `resumeFromMilestone()` (Skip button is a lie) — fix is on `fix/skip-milestone-real-semantics` branch, ready to harvest

### M4. Agent modes (built-in + custom)
**What:** 6 built-in modes (General, Architect, Coder, Reviewer, Debugger, Ask), each with role, tool group, and optional per-mode model selection. User can create custom modes via `Kovix: Create Custom Agent Mode`.
**Why:** Different tasks need different tools and different models (e.g. strong model for planning, cheap fast model for execution).
**Modes persist to:** `.kovix/modes.json`, sync across windows.

### M5. MCP (Model Context Protocol) support
**What:** Connect external MCP servers (e.g. Agent Reach for web research), dispatch their tools as `serverName__toolName`, auto-discover available tools on server connect. 30-second timeout on tool calls (defense in depth).
**Why:** Lets users extend the agent without us shipping every integration. The old repo has this fully working.
**Source for porting:** `src/vs/workbench/contrib/construct/browser/services/mcp/` — audited as functional.

### M6. Semantic memory
**What:** Workspace indexing → file chunking → embeddings (Ollama `nomic-embed-text` default) → Qdrant vector store + BM25 keyword fallback → relevant chunks auto-injected into agent context. Four layers: working / episodic / semantic / procedural.
**Why:** Without this, the agent forgets everything between sessions and can't reason about large codebases.
**Known stubs to fix during port (NOT carry forward):**
- `UniversalMemoryService` scoring is keyword-only — embeddings are generated but never consulted. The `IEmbeddingService` is wired in DI but `UniversalMemoryService` doesn't inject it. **Fix:** inject `IEmbeddingService`, compute cosine similarity, merge with keyword scores (hybrid retrieval). Estimated 1-2 days.
- `ConstructMemoryService` stores Supermemory API key in plaintext via `IStorageService`. **Fix:** route through `ISecretStorageService` (OS keychain) like LLM keys.

---

### ~~M7. Multi-agent swarm~~ — **DEFERRED TO v1.1 per D-009**

> **Status change (2026-06-27, D-009):** Multi-agent swarm is **no longer MUST for v1.0**. It moves to §4.1 "v1.1 — Planned Next". v1.0 ships only the single-agent Plan→Approve→Execute→Verify loop, which is the actual differentiator. See DECISIONS.md D-009 for full reasoning.
>
> The text below is preserved as a spec for v1.1 work; it is NOT v1.0 scope.

**What (v1.1 scope):** Parallel multi-agent execution with role-handoff design (Planner → Coder → Verifier → Repairer → MemoryManager). `kovix.openSwarm` command prompts for goal, assigns Planner, opens Control Center, spawns first sub-agent. Handoffs flow through coordinator. Config: `kovix.autonomous.parallelSwarm` (boolean) + `kovix.autonomous.swarmSize` (default 3).

**Why deferred:** Old repo's implementation has no auto role dispatch, no swarm UI, no conflict resolution. Finishing it properly costs 3-4 weeks against a single-agent loop that is already the actual differentiator. Under D-010's timeline pressure, this is exactly the kind of cut to make.

**Source for porting (when v1.1 work begins):** `multiAgentExecution.ts` (141 lines) + `multiAgentExecutionService.ts` (595 lines) ported verbatim from `recovery/phase-28-launch` per old repo's `docs/DECISIONS-v1.8.0.md` Decision 1.

**Known limitations in old repo (must be closed before v1.1 ships):**
- No automatic role dispatch (Planner runs, but Coder/Verifier/Repairer/MemoryManager tasks must be created by Planner agent's output via agent loop reading swarm coordinator state)
- No swarm UI in Control Center (live sub-agents shown, but no task/handoff/conflict state rendering)
- No conflict resolution UI (conflicts detected and stored, but user can't approve queue/merge/override/manual)

### ~~M8. Security tools (nmap / ghidra / nuclei)~~ — **DROPPED FROM v1, DEFERRED TO v2.0-MAYBE per D-008**

> **Status change (2026-06-27, D-008):** Security tools are **no longer in v1 scope at all**, not even as v1.1. They move to §6 "Deferred / Not in v1". v1.0 has zero legal exposure to security-tooling misuse, zero opt-in UX complexity, and ~2-3 weeks of saved implementation work. The sign-off gate (previously D-005) is no longer needed. See DECISIONS.md D-008 for full reasoning.
>
> The text below is preserved as a spec for v2.0-maybe; it is NOT v1.x scope.

**What (v2.0-maybe scope):** Three security scanning tools behind two-step opt-in: (1) enable the `kovix-security-tools` extension, (2) set `kovix.enableSecurityTools = true`. Without both, agent never offers these tools to LLM.

**Why dropped from v1:** Not core to the product's value proposition (the differentiator is the agent loop, not security scanning). Highest legal/liability surface for least payoff. The README-markets-it-but-it's-unwired situation flagged in `00_OLD_REPO_STATE.md` is itself a problem to fix by removing the claim, not by rushing the wiring. If a future "Kovix Security Edition" makes sense, it gets scoped properly at v2.0 planning with real handlers and dedicated UX.

**Action re: old repo:** DO NOT DELETE. The two security-tools folders (`extensions/kovix-security-tools/` and `src/vs/workbench/contrib/construct/browser/tools/security/`) get a `STUB_AUDIT` note: "reviewed, deliberately excluded from v1 per D-008". Old repo stays as-is; we just don't migrate this code into `fresh`.

---

## 3. SHOULD Ship in v1 (nice to have, not blocking launch)

### S1. Cost governor + credit system (interfaces + wiring)
**What:** Wire the existing-but-inert `ICreditSystem` and `ICostGovernor` interfaces into `agentLoop.ts`. Per old repo's `docs/DECISIONS-v1.8.0.md` Decision 2, the interfaces exist but have zero call sites — agent makes LLM calls without debiting credits, runs milestones without checking cost governor.
**Why SHOULD not MUST:** Nice for cost control on cloud providers, but doesn't block core functionality. Local Ollama users don't need it.
**Effort:** ~3-5 days. Track via old repo's issues #140 (debit), #141 (checkBudget), #142 (executionSanity.validateMilestoneCompletion).

### S2. GOD Mode (launch-readiness ceremony)
**What:** NOT a power feature — a launch-readiness ceremony. Two components:
1. `ILaunchChecklist` — 15 automated pre-launch validation checks
2. `IGodModeActivator` — credit-gated autonomous session with state machine (Inactive → Countdown → Active → Paused → Stopped), git checkpoint before activation, automatic rollback on stop
**Why SHOULD not MUST:** Nice for confidence, but launch checks can be run as a standalone command (`Kovix: Run Launch Checks`) without the ceremony.
**Decision per old repo's `docs/DECISIONS-v1.8.0.md` Decision 3:** document real behavior, do NOT port as-is in v1.x. Extract launch checklist as separate feature. Rename "GOD Mode" before any user-facing surface ships.
**Effort:** ~5-7 days if we port as-is; ~2-3 days if we extract just the launch checklist as a standalone command.

---

## 4. Proposed Shipping Order Within MUST (critical path)

Revised 2026-06-27 per D-008 / D-009 / D-010. The order below assumes the user signs off on the architecture recommendation in `docs/02a_ARCH_CHOICE_MATRIX.md` (switch from VS Code fork to VS Code extension). If the user overrides and keeps the fork route, all estimates roughly double.

Given D-010's "fastest path to demoable v1" bias, here's the order so we have a usable product as early as possible. Each phase produces a demoable artifact.

| Phase | Scope | Demoable outcome | Est. effort (extension route) |
|---|---|---|---|
| **v1.0-alpha** | M1 (VS Code extension scaffold) + M2 (LLM providers) + M3 (agent loop, simple `run()` path only, no milestones) + M4 (General mode only) | "Install extension in VS Code, type a task, agent does it, no approval flow" — minimal Cursor clone | **3-5 days** |
| **v1.0-beta** | + M3 full (milestone pausing, all 4 autonomy modes, verification harness) + M4 all 6 modes + M5 (MCP) | "Agent plans, you approve milestones, agent verifies its own work" — full crown jewel | 2-3 weeks |
| **v1.0-rc** | + M6 (semantic memory, with the keyword-only bug fixed) | "Agent remembers your codebase across sessions" | 1-2 weeks |
| **v1.0** | + Windows installer packaging (`.vsix` is platform-agnostic, but we still need to verify Windows-specific paths, terminal integration, keychain access) + S1 (cost governor, IF time allows) | "Ship to marketplace + .vsix download" | 1-2 weeks |
| **v1.1** | + M7 (multi-agent swarm, with auto role dispatch + minimal UI + conflict resolution) + S2 (launch checks, extracted from GOD Mode) | "Multi-agent swarm + launch readiness ceremony" | 4-6 weeks |

**Total v1.0 estimate (extension route): 5-8 weeks of focused work.** Compare to the fork route's original 11-15 weeks. The saving comes from skipping the fork-and-rebase overhead, native module compilation, and product-config / branding work — VS Code handles all of that.

**v1.1 adds another 4-6 weeks** for the now-deferred swarm work plus launch checks.

If timeline pressure is severe, the **next highest-leverage cut** (after M7/M8 which are already cut) is S1 (cost governor). Local Ollama users don't need it; cloud-provider users can self-impose limits via their provider dashboard.

---

## 5. Open Questions / Pending Sign-offs — ALL RESOLVED 2026-06-27

All four Phase 1 open questions have been answered by the project lead. Binding decisions logged in `docs/DECISIONS.md`.

### ✅ OQ-1: Security tools — RESOLVED by D-008
**Original question:** Do you confirm defensive use of nmap/ghidra/nuclei, allowing porting to begin?
**Resolution:** Moot. M8 is dropped from v1 entirely (deferred to v2.0-maybe). The sign-off gate is no longer needed because v1 doesn't ship these tools. If v2.0-maybe becomes real, the sign-off requirement revives at that time per project rules §4.

### ✅ OQ-2: Swarm scope — RESOLVED by D-009
**Original question:** Ship incomplete, invest in completion, or defer?
**Resolution:** Option (c) — defer to v1.1. Swarm's known limitations (no auto role dispatch, no UI, no conflict resolution) cost 3-4 weeks to close against a single-agent loop that is already the actual differentiator. v1.0 ships without swarm; v1.1 ships it complete.

### ✅ OQ-3: VS Code fork base — RESOLVED by D-004 + pending sign-off on `docs/02a_ARCH_CHOICE_MATRIX.md`
**Original question:** Are you OK with the fork's maintenance burden, or do we evaluate alternatives?
**Resolution:** Comparison matrix produced. **Recommendation: switch from VS Code fork to VS Code extension.** The agent core is portable to extension form with mechanical translation work (see matrix §"The decisive evidence"). Awaiting user sign-off on the matrix before `docs/02_ARCHITECTURE.md` is written. This is the most expensive-to-reverse decision in the project, so it gets one explicit round-trip.

### ✅ OQ-4: Budget / timeline — RESOLVED by D-010
**Original question:** Soft or hard pressure? Specific deadline?
**Resolution:** Soft-but-real. No specific deadline cited. Bias is established: optimize every remaining tradeoff for "fastest path to a usable, demoable v1" over feature completeness. When in doubt between extending timeline and cutting scope, cut scope. This does NOT authorize skipping the file-by-file audit (D-001) or any other foundational rule.

---

## 6. WON'T Ship in v1 (explicitly out of scope)

These are dropped or deferred to v2.0+. Listing them explicitly so they don't creep back in.

### Deferred from MUST per project lead decisions

#### ~~M7~~ Multi-agent swarm — deferred to v1.1 per D-009
Originally MUST. Now v1.1 scope. See §2 M7 entry above for the spec. v1.0 ships only the single-agent Plan→Approve→Execute→Verify loop.

#### ~~M8~~ Security tools (nmap / ghidra / nuclei) — dropped from v1, deferred to v2.0-maybe per D-008
Originally MUST (blocked pending sign-off). Now: not in v1 or v1.1 at all. The old repo's `extensions/kovix-security-tools/` and `src/vs/workbench/contrib/construct/browser/tools/security/` folders get a STUB_AUDIT note "reviewed, deliberately excluded from v1 per D-008" and are NOT migrated into `fresh`. The old repo is NOT deleted. If v2.0-maybe becomes real, it gets scoped properly with sign-off + real handlers + dedicated UX.

### Originally WON'T — unchanged

### W1. Credit purchase flow
**What:** Stripe integration, payment backend, webhook handler, real pricing page.
**Why out:** Old repo's `purchaseCredits()` is fake (opens placeholder URL, returns `false`). Building real payment infrastructure is a separate project. v1 is user-owned keys only — no Kovix-side billing.
**Future:** Revisit at v2.0 if there's demand for a hosted Kovix cloud tier.

### W2. Air-gap installer
**What:** Bundling Ollama + models for fully offline use in regulated environments.
**Why out:** Niche use case. Solo dev audience doesn't need this. Old repo had only an architecture stub (`airgapInstaller.ts`, 111 lines, interface only).
**Future:** Revisit if a regulated-industry user asks for it.

### W3. Kali / WSL2 integration
**What:** Windows-only Kali Linux terminal integration via WSL2.
**Why out:** Was tied to security tools (M8). With M8 dropped from v1, this is doubly out of scope. Adds Windows-specific complexity. Old repo had only an architecture stub (`kaliIntegrationPack.ts`, 132 lines, interface only).
**Future:** Revisit only if M8 ships at v2.0 AND users specifically ask for Kali (vs. native Windows security tooling).

---

## 7. Constraints (carried forward to all phases)

| Constraint | Source | Applies to |
|---|---|---|
| **No bulk copy from Kovix_2.0** | User remarks + project rules §5 | All phases — every file gets per-file audit before migration |
| **No Microsoft telemetry** | User constraint (matches old repo) | All phases — extension does not phone home |
| ~~**MIT attribution carried forward**~~ | ~~User constraint~~ | **REMOVED per D-011** — extension route does not redistribute Code-OSS source; MIT attribution chain does not apply. Extension's own license is a separate decision (D-014 will be logged). |
| **No real keys/tokens in fresh** | Project rules §4 | All phases — secrets policy in `AGENTS.md` |
| **Standard SDLC, step by step** | User remarks | All phases — no skipping |
| **Plain-language status reports** | Project rules §6 | All phase boundaries |

---

## 8. Success Criteria for v1.0

A v1.0 release is shippable when ALL of the following are true (revised 2026-06-27 per D-008/D-009 — M7 and M8 removed):

- [ ] M1: `fresh` repo contains a VS Code extension (per D-011) that builds cleanly with `npm install` + `npm run compile` on a fresh dev machine, installs via `code --install-extension`, and activates without errors
- [ ] M2: User can configure any of 13 LLM providers via `Kovix: Manage API Keys`, keys stored in OS keychain, no plaintext
- [ ] M3: User can submit a task, agent plans it, user approves with chosen autonomy mode, agent executes milestone-by-milestone with verification after each, verification failure pauses (not auto-skips)
- [ ] M3 bug fixes: MajorMilestone mode actually pauses at major milestones; Skip button actually skips (not duplicates Resume)
- [ ] M4: All 6 built-in modes work; user can create custom mode via `Kovix: Create Custom Agent Mode`; modes persist to `.kovix/modes.json`
- [ ] M5: User can add an MCP server via settings, agent auto-discovers its tools, can call them as `serverName__toolName`, 30s timeout enforced
- [ ] M6: `Kovix: Index Workspace` produces real embeddings in local Qdrant; agent retrieves relevant chunks during planning AND execution (not just keyword fallback)
- [ ] M6 bug fix: `UniversalMemoryService` uses cosine similarity on embeddings (not keyword-only); Supermemory API key (if used) stored in OS keychain (not plaintext)
- [ ] ~~M7 (if in v1.0): `kovix.openSwarm` works end-to-end~~ — REMOVED per D-009, deferred to v1.1
- [ ] ~~M8: security tools opt-in works~~ — REMOVED per D-008, deferred to v2.0-maybe
- [ ] Extension installs cleanly on a fresh VS Code install on Windows 11 (and macOS / Linux for the extension route, since `.vsix` is platform-agnostic)
- [ ] `gitleaks` scan in CI passes (no real secrets)
- [ ] `npm audit` has 0 HIGH vulnerabilities in production dependencies (transitive dev deps are OK)
- [ ] All Phase 1-7 SDLC deliverables complete and committed to `fresh`
- [ ] README and any user-facing docs do NOT mention nmap / ghidra / nuclei (per D-008 action item)

---

## 9. What's Next

**Phase 2 (Architecture & Planning)** is now in progress. It will produce:
1. ✅ One-page comparison matrix for base architecture — DONE: `docs/02a_ARCH_CHOICE_MATRIX.md`. Recommendation: switch from VS Code fork to VS Code extension. **Awaiting user sign-off.**
2. ⏳ `docs/02_ARCHITECTURE.md` — written only after user signs off on the matrix. Will cover: folder skeleton for `fresh`, module boundaries, folder mapping for `fresh`, concrete definition of "done" / "launchable" for v0.1.
3. ⏳ Module breakdown for each MUST feature (M1-M6), with explicit "rewrite" vs "port from Kovix_2.0 with audit" decisions.
4. ✅ `docs/DECISIONS.md` — D-008 / D-009 / D-010 logged above D-007.
5. ✅ `docs/01_REQUIREMENTS.md` — updated per D-008/D-009/D-010 (this revision).

**Status of Phase 1 open questions:** ALL RESOLVED (see §5 above). No further blockers.

**The single item blocking Phase 2 completion:** user sign-off on `docs/02a_ARCH_CHOICE_MATRIX.md`'s recommendation. Per the project lead's instruction, this is the one round-trip on the architecture choice. Once the user responds YES / NO / pick-other, Phase 2 proceeds without further architecture stalls.
