# 01_REQUIREMENTS.md — Kovix v1 Requirements

**Date:** 2026-06-27
**Author:** Rebuild lead (agent session)
**Audience:** Project owner (non-engineer) + future contributors
**Source:** Phase 1 requirements interview (this session) + `docs/00_OLD_REPO_STATE.md`

> Scope: what `fresh` (the new Kovix repo) must ship for v1. Every feature listed here came from the user's interview answers. TheMust/Should/Won't structure is the standard software-engineering way to make scope explicit so we can defend it later.

---

## TL;DR

Kovix v1 is an AI-native IDE for **solo developers and tinkerers** who want a Cursor/Claude Code-style agent they fully own — their keys, their cost, their machine, no subscription, no telemetry. The base is a fresh VS Code / Code-OSS fork (same choice as the old repo, done cleanly this time). The agent loop (Plan→Approve→Execute→Verify) is the crown jewel and must ship. Multi-provider LLM, agent modes, MCP, semantic memory, and **multi-agent swarm** are all MUST. Security tools (nmap/ghidra/nuclei) are MUST but **require explicit sign-off** before any porting — see §5. Windows is the first target platform.

**The honest scope warning:** this is an ambitious v1, especially under the timeline pressure the user flagged. With a VS Code fork base (huge), 7 MUST features including a fresh swarm implementation, and Windows-first shipping, the critical path is long. §4 proposes a sub-prioritization within MUST so we ship a usable slice early and layer on the rest.

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

### M1. VS Code / Code-OSS fork as base
**What:** Fresh fork of Code-OSS in the `fresh` repo, with all Microsoft telemetry stripped (the old repo already did this; we replicate).
**Why:** User's explicit choice. Same base as old repo, done cleanly this time.
**Carries:** MIT attribution obligations (`NOTICE.md`, `ThirdPartyNotices.txt`) — see Constraints.
**Source:** Fork microsoft/vscode upstream, NOT Kovix_2.0.

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

### M7. Multi-agent swarm
**What:** Parallel multi-agent execution with role-handoff design (Planner → Coder → Verifier → Repairer → MemoryManager). `kovix.openSwarm` command prompts for goal, assigns Planner, opens Control Center, spawns first sub-agent. Handoffs flow through coordinator. Config: `kovix.autonomous.parallelSwarm` (boolean) + `kovix.autonomous.swarmSize` (default 3).
**Why:** User explicitly marked MUST.
**Source for porting:** `multiAgentExecution.ts` (141 lines) + `multiAgentExecutionService.ts` (595 lines) ported verbatim from `recovery/phase-28-launch` per old repo's `docs/DECISIONS-v1.8.0.md` Decision 1.
**Known limitations in old repo (must be honest about scope):**
- No automatic role dispatch (Planner runs, but Coder/Verifier/Repairer/MemoryManager tasks must be created by Planner agent's output via agent loop reading swarm coordinator state)
- No swarm UI in Control Center (live sub-agents shown, but no task/handoff/conflict state rendering)
- No conflict resolution UI (conflicts detected and stored, but user can't approve queue/merge/override/manual)
**Decision needed in Phase 2:** ship v1 with these limitations explicitly documented, OR invest in closing them before launch. Recommend shipping with limitations documented — see DECISIONS.md.

### M8. Security tools (nmap / ghidra / nuclei) — ⚠️ PENDING SIGN-OFF
**What:** Three security scanning tools behind two-step opt-in: (1) enable the `kovix-security-tools` extension, (2) set `kovix.enableSecurityTools = true`. Without both, agent never offers these tools to LLM.
**Why:** User explicitly marked MUST.
**Source for porting:** `extensions/kovix-security-tools/` + three `*Tool.ts` files in `src/vs/workbench/contrib/construct/browser/tools/security/`.
**Critical caveats — these were stubs in the old repo:**
- Schema-only definitions, ZERO execution handlers (CRITICAL per STUB_AUDIT C-1)
- Not registered in live tool registry (STUB_AUDIT L-3) — LLM never saw them
- For v1 we'd need to **actually build** the handlers (nmap: terminal integration + XML output parsing; ghidra: Docker container + analyzeHeadless + decompilation parsing; nuclei: terminal integration + JSON output parsing)
- This is significant new work, not a port

**🛑 BLOCKED — explicit sign-off required per project rules §4:**
> *"Anything under `extensions/kovix-security-tools/` cannot be migrated until you confirm intended use is defensive / owned-systems only."*

The user marked this MUST but per the project's own rules, I cannot begin any work on it until the user provides explicit written confirmation that intended use is defensive / owned-systems only. See §5 Open Questions.

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

Given the user's timeline pressure, here's the proposed order so we have a usable product as early as possible. Each phase produces a demoable artifact.

| Phase | Scope | Demoable outcome | Est. effort |
|---|---|---|---|
| **v1.0-alpha** | M1 (Code-OSS fork) + M2 (LLM providers) + M3 (agent loop, simple `run()` path only, no milestones) + M4 (General mode only) | "Type a task, agent does it, no approval flow" — minimal Cursor clone | 3-4 weeks |
| **v1.0-beta** | + M3 full (milestone pausing, all 4 autonomy modes, verification harness) + M4 all 6 modes + M5 (MCP) | "Agent plans, you approve milestones, agent verifies its own work" — full crown jewel | 3-4 weeks |
| **v1.0-rc** | + M6 (semantic memory, with the keyword-only bug fixed) | "Agent remembers your codebase across sessions" | 2-3 weeks |
| **v1.0** | + M7 (swarm, with limitations documented) + Windows packaging | "Multi-agent swarm + Windows installer" | 3-4 weeks |
| **v1.1** | + M8 (security tools, IF sign-off received) + S1 (cost governor) + S2 (GOD Mode / launch checks) | "Security tools + cost controls + launch readiness" | 4-6 weeks |

**Total v1.0 estimate: 11-15 weeks of focused work.** This is honest — a VS Code fork + 6 MUST features + Windows packaging is genuinely that much work. v1.1 adds another 4-6 weeks.

If timeline pressure is severe, the **single highest-leverage cut** is defer M7 (swarm) to v1.1. That saves 3-4 weeks and removes the riskiest piece. Swarm's known limitations (no auto role dispatch, no UI, no conflict resolution) mean it would ship incomplete anyway.

---

## 5. Open Questions / Pending Sign-offs

### 🛑 OQ-1: Security tools — explicit sign-off required
**Question for user:** Do you confirm that intended use of nmap_scan, ghidra_decompile, and nuclei_scan in Kovix is **defensive security testing on systems you own or have explicit written permission to test**?

This confirmation is required by project rules §4 before any work on M8 can begin. Until then, M8 is blocked and the v1.1 timeline assumes it.

**My recommendation:** If you're not actively doing security work yourself, drop M8 entirely and ship security tools as a v2.0 feature. The implementation cost is significant (real handlers, not stubs), and the opt-in UX needs to be very carefully designed to prevent misuse.

### OQ-2: Swarm scope — ship incomplete or invest in completion?
**Question for user:** For M7 (multi-agent swarm), do you want to:
- (a) Ship v1 with the old repo's current limitations (no auto role dispatch, no swarm UI, no conflict resolution UI) — fastest, but users will hit the limitations quickly
- (b) Invest 2-3 additional weeks to close at least auto role dispatch + minimal swarm UI before launch
- (c) Defer swarm to v1.1 entirely (saves 3-4 weeks on v1.0 critical path)

**My recommendation:** Option (c) — defer to v1.1. Swarm is the riskiest MUST item, the old repo's implementation has known gaps, and shipping it incomplete creates UX debt. Without swarm, v1.0 still has the full Plan→Approve→Execute→Verify loop, which is the actual differentiator.

### OQ-3: VS Code fork base — are you OK with the maintenance burden?
**Question for user:** A VS Code fork means we'll be rebasing against microsoft/vscode upstream constantly (they ship weekly). The old repo had 8,194 files; most are inherited VS Code, not Kovix code. Alternatives we should at least consider in Phase 2:
- VS Code extension (much lower maintenance, but limited to extension APIs)
- Theia (web-first, more flexible than extension, less maintenance than fork)
- Standalone Electron + Monaco (most flexibility, most work)

You picked "VS Code fork (same as old)" — I'll honor that as the default, but I want to flag that Phase 2 should produce a one-page comparison matrix before we commit. The matrix itself is ~1 day of work.

**My recommendation:** Stick with VS Code fork IF you want Kovix to feel like a real IDE (not just an extension panel). If you mainly care about the agent experience, VS Code extension is dramatically less work.

### OQ-4: Budget / timeline — how hard is the pressure?
**Question for user:** You flagged "Budget / timeline pressure" as a constraint. Can you share:
- Is there a specific deadline? (e.g. "ship by end of Q3 2026")
- Is the budget monetary (cloud costs, dev time) or just time?
- Is this a "soft" pressure (preference for speed) or "hard" (funding runs out)?

This affects how aggressive the harvest-vs-rewrite tradeoff is. With hard pressure, we lean more on harvesting audited code from Kovix_2.0. With soft pressure, we lean more on clean rewrites.

---

## 6. WON'T Ship in v1 (explicitly out of scope)

These are dropped or deferred to v2.0+. Listing them explicitly so they don't creep back in.

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
**Why out:** Tied to security tools (W3/M8). Adds Windows-specific complexity. Old repo had only an architecture stub (`kaliIntegrationPack.ts`, 132 lines, interface only).
**Future:** Revisit if M8 ships and users want Kali specifically (vs. native Windows security tooling).

---

## 7. Constraints (carried forward to all phases)

| Constraint | Source | Applies to |
|---|---|---|
| **No bulk copy from Kovix_2.0** | User remarks + project rules §5 | All phases — every file gets per-file audit before migration |
| **No Microsoft telemetry** | User constraint (matches old repo) | M1 — strip all telemetry on fork |
| **MIT attribution carried forward** | User constraint | M1 — `NOTICE.md` + `ThirdPartyNotices.txt` required if we keep Code-OSS base |
| **No real keys/tokens in fresh** | Project rules §4 | All phases — secrets policy in `AGENTS.md` |
| **Standard SDLC, step by step** | User remarks | All phases — no skipping |
| **Plain-language status reports** | Project rules §6 | All phase boundaries |

---

## 8. Success Criteria for v1.0

A v1.0 release is shippable when ALL of the following are true:

- [ ] M1: `fresh` repo contains a Code-OSS fork that compiles on Windows with `npm install` + `npm run compile` (no `--ignore-scripts` workaround needed on a properly-configured dev machine)
- [ ] M2: User can configure any of 13 LLM providers via `Kovix: Manage API Keys`, keys stored in OS keychain, no plaintext
- [ ] M3: User can submit a task, agent plans it, user approves with chosen autonomy mode, agent executes milestone-by-milestone with verification after each, verification failure pauses (not auto-skips)
- [ ] M3 bug fixes: MajorMilestone mode actually pauses at major milestones; Skip button actually skips (not duplicates Resume)
- [ ] M4: All 6 built-in modes work; user can create custom mode via `Kovix: Create Custom Agent Mode`; modes persist to `.kovix/modes.json`
- [ ] M5: User can add an MCP server via settings, agent auto-discovers its tools, can call them as `serverName__toolName`, 30s timeout enforced
- [ ] M6: `Kovix: Index Workspace` produces real embeddings in local Qdrant; agent retrieves relevant chunks during planning AND execution (not just keyword fallback)
- [ ] M6 bug fix: `UniversalMemoryService` uses cosine similarity on embeddings (not keyword-only); Supermemory API key (if used) stored in OS keychain (not plaintext)
- [ ] M7 (if in v1.0): `kovix.openSwarm` works end-to-end — user enters goal, Planner runs, hands off to Coder, etc. Limitations explicitly documented in user-facing docs
- [ ] Windows installer builds and installs cleanly on a fresh Windows 11 machine
- [ ] `gitleaks` scan in CI passes (no real secrets)
- [ ] `npm audit` has 0 HIGH vulnerabilities in production dependencies (transitive dev deps are OK)
- [ ] All Phase 1-7 SDLC deliverables complete and committed to `fresh`

---

## 9. What's Next

**Phase 2 (Architecture & Planning)** will produce `docs/02_ARCHITECTURE.md` covering:
1. Folder skeleton for `fresh`
2. One-page comparison matrix for base architecture (VS Code fork vs extension vs Theia vs Electron+Monaco) — even though user picked fork, we owe ourselves the comparison
3. Module breakdown for each MUST feature (M1-M7/M8), with explicit "rewrite" vs "port from Kovix_2.0 with audit" decisions
4. `docs/DECISIONS.md` initial entries (started in this phase, will grow)

**Before Phase 2 begins**, the user needs to answer OQ-1 (security tools sign-off), OQ-2 (swarm scope), OQ-3 (fork-vs-alternatives comparison), and OQ-4 (timeline pressure specifics). OQ-1 is a hard blocker per project rules.

If the user prefers, I can proceed with Phase 2 architecture work in parallel on M1-M6 (which don't depend on the open questions) and defer M7/M8 architecture until the questions are answered.
