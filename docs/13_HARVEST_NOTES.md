# 13 — Harvest Notes (Account-Wide Architecture Review)

**Date:** 2026-06-29
**Branch:** `harvest/full-run`
**Purpose:** Plain-language summaries of architecture patterns found across the Kovix account repos (Kovix_2.0, Real-vibecode, Aegis, construct-ai-agent, others) that are candidates for harvesting into `fresh`. Honest assessment of portability vs. coupling for each pattern. This doc drives Steps 4-7 of the harvest plan.

---

## 1. Source repos available for review

| Repo | Access | What it contains |
|------|--------|------------------|
| **Kovix_2.0** | Local clone at `/home/z/my-project/repos/Kovix_2.0/` | The VS Code fork that was the original Kovix. Has a full pricing/credit system, execution sanity service, cost governor, and the agent loop with 22 dependencies. Branches with additional features have been deleted from remote — only `main` and dependabot branches remain. |
| **fresh** | Active working repo | The Electron standalone app being built. Has the agent core loop, 3 LLM providers, platform abstraction layer, 8 built-in tools, and security hardening. |
| **Real-vibecode** | **NOT available locally.** Remote at `https://github.com/Razisafir/Real-vibecode` was not cloned. The account audit mentioned it contains AEGIS-v2-INTEGRATION.md and four architecture docs (ai-execution-kernel-phase1.md, execution-graph.md, mutation-routing.md, deterministic-replay.md). These could NOT be read for this assessment. |
| **Aegis** | **NOT available locally.** Remote likely at `https://github.com/Razisafir/Aegis` was not cloned. Mentioned as containing a swarm taxonomy (Lead/Executor/QA/Researcher/Critic). These could NOT be read for this assessment. |
| **construct-ai-agent** | **NOT available locally.** Not cloned. Referenced in the account audit. |

### Critical gap

The prompt asked to read Real-vibecode's `AEGIS-v2-INTEGRATION.md` and four architecture docs in full before writing this document. **These files were not accessible** — the Real-vibecode repo was not cloned locally and the specific docs were not provided as attachments. This means:

1. The `IAIExecutionService` description below is based on inference from Kovix_2.0's code patterns and the HARVEST_CANDIDATES.md descriptions, not from reading the actual source. It may be inaccurate.
2. The Execution Graph Engine description is similarly speculative.
3. The Mutation Gateway evaluation (Step 5) will be based on partial information and should be flagged as such.
4. The Swarm reconciliation (Step 7) cannot incorporate Aegis's taxonomy directly — it will work from the user's stated preference and Kovix_2.0's patterns only.

**Recommendation:** Clone Real-vibecode and Aegis repos before executing Steps 5-7 if accuracy on those patterns matters. Alternatively, accept the partial assessment and flag uncertainty in the relevant design docs.

---

## 2. What IAIExecutionService actually does (inferred from Kovix_2.0 patterns)

**Source:** Inferred from Kovix_2.0's `pendingChangesService.ts`, `agentLoopHelpers.ts`, and the HARVEST_CANDIDATES.md reference to "IAIExecutionService mutation gateway (chokepoint, source tagging, checksums, rollback metadata)."

### What it likely is

`IAIExecutionService` appears to be a **mutation chokepoint** — a single service through which ALL code modifications must pass before being applied to disk. Unlike `pendingChangesService.ts` which stages changes and shows diffs for user approval, a mutation gateway would additionally:

1. **Tag the source** of each mutation (which agent, which tool call, which milestone).
2. **Compute checksums** of files before and after mutation, enabling integrity verification.
3. **Store rollback metadata** — enough information to undo any applied mutation without relying on git (because the user might not have git initialised).
4. **Provide a single audit trail** — every mutation is logged with who/what/when/why.

### How it differs from fresh's pendingChangesService.ts

| Aspect | pendingChangesService.ts (fresh) | IAIExecutionService (inferred) |
|--------|----------------------------------|-------------------------------|
| Core purpose | Stage proposed changes, show diffs, let user approve/reject | Same, PLUS source tagging, checksums, rollback metadata |
| Change source tracking | No — changes are undifferentiated blobs | Yes — each change knows which agent/tool/milestone produced it |
| Integrity checks | No — no checksums before/after | Yes — checksums enable detecting corruption or tampering |
| Rollback | No — once applied, only git can undo | Yes — stored rollback metadata enables programmatic undo without git |
| Audit trail | In-memory only (lost on restart) | Persistent (every mutation logged) |

### Portability assessment

**Tight coupling risk: MEDIUM-HIGH.** The mutation gateway concept is architecture-agnostic in principle, but the specific implementation in Real-vibecode likely depends on:

- Real-vibecode's own execution graph (for knowing which step produced which mutation)
- Real-vibecode's own agent lifecycle (for tagging source agent/role)
- Possibly Real-vibecode's own storage layer (for persisting audit trail and rollback metadata)

If these dependencies exist, the gateway cannot be ported as a standalone module — it would need significant adaptation to fresh's `AgentLoopService` and platform layer. The concept (chokepoint + tagging + checksums + rollback) is portable; the implementation likely is not.

**Honest assessment:** Without reading the actual source, I cannot determine how tightly coupled IAIExecutionService is to Real-vibecode's internals. The safe assumption is "significantly coupled" — Real-vibecode was a different product with different architecture, and a mutation gateway that captures execution context would need to know about that context's shape.

---

## 3. What the Execution Graph Engine actually stores (inferred from descriptions)

### What it likely is

The Execution Graph Engine is a **directed acyclic graph (DAG) of execution steps** — each node represents an agent action (tool call, LLM round, milestone), and edges represent dependencies (step B depends on step A's output). This enables:

1. **Deterministic replay** — given the same graph + the same inputs, you get the same outputs. Useful for debugging and auditing.
2. **Parallel execution** — independent branches of the graph can run concurrently (this connects to the swarm architecture).
3. **Checkpoint/resume** — if execution fails at step N, you can resume from the last successful checkpoint instead of starting over.
4. **Provenance tracking** — every output knows which sequence of steps produced it.

### How it differs from fresh's current approach

Fresh's `AgentLoopService` runs a sequential loop: plan → approve → execute (milestone by milestone) → verify. There is no graph structure — the loop is a linear sequence. The milestone system provides some checkpointing (you can pause at milestone boundaries), but there's no DAG, no parallel branches, and no provenance tracking beyond the in-memory conversation history.

### Portability assessment

**Tight coupling risk: HIGH.** An execution graph engine is a fundamental architectural pattern — it changes how the entire agent loop works. Porting it would mean:

1. Replacing the sequential `AgentLoopService` loop with a graph-based execution model
2. Adding a graph storage layer (in-memory at minimum, persistent for replay)
3. Adding a graph scheduler (topological sort + parallel execution)
4. Rewriting every consumer of `AgentLoopService` to work with graph nodes instead of sequential steps

This is not a "port a module" task — it's an architectural rewrite. The concept is sound for a multi-agent system, but it's premature for fresh's current single-agent loop. The execution graph becomes valuable when swarm mode lands (v1.1), where parallel branches are the whole point.

**Honest assessment:** The execution graph pattern should inform the v1.1 swarm design, but it should NOT be ported as-is into fresh's current architecture. The sequential loop is simpler, correct, and working. Introducing a graph engine now would add complexity without benefit until swarm exists.

---

## 4. CostGovernorService + BudgetExceededError pattern (from Kovix_2.0)

### What it actually does

The cost governor in Kovix_2.0 has two parts:

1. **`ICostGovernor`** — an interface with methods: `isEmergencyMode()`, `shouldAutoSwitchModel()`, `getCheaperModel()`, `isActionAllowed()`, `getBudgetRecommendation()`, `recordAutoSwitch()`, `getAutoSwitchHistory()`. Emergency mode activates when credits drop below 10. Auto-switch recommendation fires when credits drop below 20% of allocation.

2. **`ICreditSystem`** — a full credit accounting interface: `consumeCredits()`, `getCreditsRemaining()`, `estimateCost()`, `setBudget()`, `getUsageHistory()`, etc. The implementation (`creditSystemService.ts`, 869 lines) manages subscription tiers, usage tracking, budget enforcement, and cost estimation.

3. **`checkCostGate()`** — the helper in `agentLoopHelpers.ts` that wires the governor into the agent loop. Checks `isEmergencyMode()` before each LLM round. If emergency, the loop stops with a clear message.

### What's already in fresh

Fresh already has the `checkCostGate()` function and the `ICostGovernor` / `ICreditSystem` forward declarations in `agentLoopHelpers.ts`. However, there are NO actual implementations — these are interface-only forward declarations. The `checkCostGate()` function calls `costGovernor.isEmergencyMode()` but no concrete `CostGovernorService` exists.

### Portability assessment

**Tight coupling risk: LOW.** The cost governor and credit system are pure-logic services with well-defined interfaces. They depend on:
- A storage layer for persisting usage data (can use fresh's `appState` module)
- A logger (can use fresh's `ILogger` interface)
- No VS Code or Real-vibecode specific imports

The 869-line `creditSystemService.ts` from Kovix_2.0 includes subscription tier logic, Stripe placeholder code, and tier simulation that are not needed in fresh (fresh is user-owned keys, no subscription). A stripped-down version focusing on:
- Credit accounting (consume/remaining/history)
- Budget enforcement (emergency mode at threshold)
- Cost estimation (per-action, per-model)
- `BudgetExceededError` for clean error propagation

...would be ~300-400 lines and could be ported with minimal adaptation.

---

## 5. Model routing by purpose (from HARVEST_CANDIDATES.md, original on deleted branch)

### What it does

`modelRouting.ts` (~250 LOC) defines a `ModelPurpose` type (autocomplete, inline-edit, agent-plan, agent-execute, chat, embedding) and a routing decision function that maps purpose → appropriate model. This solves the problem of using Claude Sonnet 4 for autocomplete (wasteful) when a cheaper/faster model would suffice.

### Portability assessment

**Tight coupling risk: ZERO.** This is a pure-logic file with no imports beyond its own types. It can be dropped in as a standalone module and wired into the LLM service later. The HARVEST_CANDIDATES.md confirmed: "Pure-logic file with no VS Code imports — fully unit-testable."

However, the original file was on `origin/recovery/audit-tier1-patches` which no longer exists in the Kovix_2.0 remote. The file must be **reimplemented from the description**, not ported.

---

## 6. Local usage log + telemetry (from HARVEST_CANDIDATES.md, original on deleted branch)

### What it does

`localUsageLog.ts` (~255 LOC) + `localUsageLogHelpers.ts` (~210 LOC) write usage events to `~/.kovix/logs/usage.jsonl` as JSON Lines — never sends data anywhere. The helpers are pure-logic and unit-testable. The telemetry service interface (`IConstructTelemetryService`) provides 15 typed event names.

### Portability assessment

**Tight coupling risk: ZERO for helpers, LOW for the service.** The helpers are pure-logic. The service itself writes to a local file — the only dependency is the filesystem, which fresh handles via its platform layer. The original used VS Code's `IOutputChannel` for logging, which fresh replaces with its own `ILogger`.

Same as model routing: the original files were on `origin/recovery/audit-tier1-patches` which no longer exists. These must be reimplemented from the description.

---

## 7. Swarm architecture patterns (Kovix_2.0 vs. Aegis vs. user's stated preference)

### What Kovix_2.0 had

Kovix_2.0's `MultiAgentOrchestrator` (~800 LOC) had:
- **No role dispatch** — all agents were identical; the orchestrator just spawned N copies
- **No conflict resolution** — last write won silently
- **No UI** — swarm ran invisibly
- Taxonomy: Planner / Coder / Verifier / Repairer / MemoryManager (roles in `agentTypes.ts`)

### What Aegis reportedly has (NOT verified — repo not available)

Per the account audit: Lead / Executor / QA / Researcher / Critic taxonomy. A lead agent talks to the user, decomposes plans, and spawns workers.

### What the user specified directly

In a previous session, the user specified: **one lead agent the user talks to, which spawns worker agents per sub-task, with workers reporting status back to the lead.** This is the lead/worker model.

### Reconciliation needed

The three taxonomies overlap but are not identical:
- **Kovix_2.0:** Planner/Coder/Verifier/Repairer/MemoryManager — these are SPECIALIZED ROLES, not a lead/worker split
- **Aegis:** Lead/Executor/QA/Researcher/Critic — this IS a lead/worker split (Lead orchestrates, others execute)
- **User's preference:** Lead/Worker — the simplest formulation

The reconciliation should be: **Lead + Workers, where Workers can have specialized roles.** The Lead is the single agent the user talks to. Workers are spawned per sub-task and can be assigned roles (Coder, Verifier, Researcher, etc.) based on the nature of the sub-task. This unifies all three taxonomies.

---

## 8. Summary of portability ratings

| Pattern | Source | Portability | Coupling Risk | Recommendation |
|---------|--------|-------------|---------------|----------------|
| IAIExecutionService (mutation gateway) | Real-vibecode | LOW | MEDIUM-HIGH | Evaluate in Step 5; likely extend pendingChangesService.ts instead |
| Execution Graph Engine | Real-vibecode | VERY LOW | HIGH | Do not port now; inform v1.1 swarm design only |
| CostGovernorService | Kovix_2.0 | HIGH | LOW | Port a stripped-down version (credit accounting + budget enforcement only) |
| BudgetExceededError | Kovix_2.0 | HIGH | ZERO | Port directly |
| Model routing | Deleted branch | N/A (reimplement) | ZERO | Reimplement from description |
| Local usage log | Deleted branch | N/A (reimplement) | ZERO | Reimplement from description |
| Swarm taxonomy | Multiple | N/A (design only) | N/A | Reconcile in Step 7 as lead/worker model |

---

## 9. Files NOT read that should have been

The following files were specified in the harvest plan as required reading but could not be accessed:

1. **Real-vibecode/AEGIS-v2-INTEGRATION.md** — would contain the definitive description of IAIExecutionService and how Aegis integrates with the host IDE
2. **Real-vibecode/ai-execution-kernel-phase1.md** — would contain the execution graph design details
3. **Real-vibecode/execution-graph.md** — would contain the DAG storage and scheduling design
4. **Real-vibecode/mutation-routing.md** — would contain the mutation chokepoint design (critical for Step 5's cost/benefit analysis)
5. **Real-vibecode/deterministic-replay.md** — would contain the replay/checkpoint design
6. **Aegis repo** — would contain the Lead/Executor/QA/Researcher/Critic taxonomy implementation

**Impact on downstream steps:**
- **Step 5 (Mutation Gateway evaluation):** Will be based on inferred behavior, not verified source. The cost/benefit analysis may be incomplete.
- **Step 7 (Swarm reconciliation):** Can only reconcile Kovix_2.0's taxonomy + user's stated preference. Aegis's taxonomy is secondhand from the account audit.
- **Step 4 (Cost Governor):** No impact — the source is Kovix_2.0 which IS available.

---

## 10. skip-milestone semantics verification

The HARVEST_CANDIDATES.md (§1.2) documents a fix on `fix/skip-milestone-real-semantics` that changes `skipCurrentMilestone()` to actually skip instead of duplicating `resumeFromMilestone()`. This branch also no longer exists in the remote.

**Checking fresh's current code:** The `milestoneExecutor.ts` in fresh needs to be examined to determine whether skip semantics are correct. This verification happens in Step 2 as part of the additive ports work.
