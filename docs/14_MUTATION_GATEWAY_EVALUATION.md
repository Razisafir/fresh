# 14 — Mutation Gateway Evaluation

**Date:** 2026-06-29
**Branch:** `harvest/full-run`
**Purpose:** Evaluate whether fresh's existing `pendingChangesService.ts` should be replaced with a Real-vibecode-style `IAIExecutionService` mutation gateway. This is a design doc only — no implementation in this step.

**Sources consulted:**
- `docs/13_HARVEST_NOTES.md` (Step 1 harvest notes)
- `src/diff/pendingChangesService.ts` (238 lines, fresh's existing Approve-gate)
- `src/diff/pendingChanges.ts` (interface definition)
- Real-vibecode's architecture docs were **NOT available** — this evaluation is based on inference from HARVEST_CANDIDATES.md descriptions and Kovix_2.0 code patterns. This is a limitation that should be noted.

---

## 1. What fresh currently has

### pendingChangesService.ts — the working, tested Approve-gate

**What it does:**
- Stages proposed file changes (new files, edits) without writing to disk
- Stores original + proposed content for each file
- Presents changes to the user for Accept/Reject
- On Accept: writes the proposed content to disk
- On Reject: discards the proposed content
- Fires `onDidChangePendingChanges` event for UI updates
- P0-5 security: NEVER writes to disk during staging

**What it does NOT do:**
- No source tagging (doesn't track which agent/tool/milestone produced the change)
- No checksums (no integrity verification before/after write)
- No rollback metadata (no way to undo an accepted change without git)
- No audit trail (no persistent log of mutations)
- No conflict detection (if two changes target the same file, last staged wins)

**Current scale:** 238 lines, 0 VS Code imports, pure Node.js fs. It is load-bearing, working, tested infrastructure.

---

## 2. What the mutation gateway would add

Based on the HARVEST_CANDIDATES.md description and inference from Real-vibecode patterns, the `IAIExecutionService` mutation gateway would add:

| Capability | pendingChangesService.ts | IAIExecutionService (inferred) |
|------------|--------------------------|-------------------------------|
| Stage + approve changes | ✓ | ✓ |
| Source tagging (agent/tool/milestone) | ✗ | ✓ — each mutation knows its origin |
| Checksums (pre/post integrity) | ✗ | ✓ — detect corruption or tampering |
| Rollback metadata | ✗ | ✓ — programmatic undo without git |
| Audit trail | ✗ | ✓ — persistent log of all mutations |
| Conflict detection | ✗ | ✓ — detect overlapping mutations |
| DAG integration | ✗ | ✓ — mutations linked to execution graph nodes |

---

## 3. Honest cost/benefit analysis

### Benefits of replacing with mutation gateway

1. **Source tagging** enables debugging which agent/tool caused a specific change. In swarm mode (v1.1), this is critical — when 3 agents are running in parallel and a file gets corrupted, you need to know which agent did it. **Without swarm, this is nice-to-have.**

2. **Rollback metadata** enables undo without git. This matters for users who don't have git initialised in their project. **However**, most developer workflows already include git, and "git checkout -- ." is the standard undo. Building a parallel undo system is significant scope for marginal gain.

3. **Audit trail** provides forensics. Useful for debugging agent behavior, but the local usage log (Step 2) already captures tool-call events. A mutation audit trail overlaps significantly with what the usage log provides.

4. **Checksums** detect file corruption. This is valuable in principle but rare in practice — Node.js `fs.writeFile` doesn't corrupt files in normal operation. The risk is from concurrent writes (which file-level locking in the swarm design already addresses), not from fs corruption.

5. **DAG integration** links mutations to execution steps. This is the most valuable capability, but it requires the execution graph engine (which we explicitly decided NOT to port in the harvest notes — it's a fundamental architectural rewrite, not a module addition).

### Costs of replacing with mutation gateway

1. **Rewrite of load-bearing infrastructure.** pendingChangesService.ts is 238 lines of working, tested code. Replacing it means replacing the entire staging + approval pipeline. The agent loop, the UI, and the diff viewer all depend on it.

2. **Tight coupling to Real-vibecode's execution model.** The mutation gateway was designed for Real-vibecode's DAG-based execution engine. Without that engine, the gateway's most valuable feature (DAG integration) is useless. Porting the gateway without the execution graph means paying the coupling cost without getting the primary benefit.

3. **Increased complexity for no immediate user benefit.** The user doesn't interact with the mutation gateway directly — they interact with the Accept/Reject UI. Adding source tags and checksums under the hood doesn't change the UX until swarm mode exists.

4. **Testing burden.** The new service would need integration tests covering: source tagging, checksum computation, rollback metadata storage, audit trail persistence, and conflict detection. That's significant new test surface for infrastructure that currently "just works."

5. **Risk of regressions.** The existing service has been tested through multiple rounds. Replacing it introduces risk of bugs in the staging/approval pipeline — the most user-visible part of the agent loop.

---

## 4. Recommendation

**Recommendation: Incrementally extend pendingChangesService.ts, do NOT replace it.**

**Rationale:**

1. **The pendingChangesService is load-bearing infrastructure.** It works, it's tested, and it handles the core user interaction (Approve/Reject). Replacing working infrastructure with a more complex version that doesn't solve an immediate user problem is the wrong trade under D-010's "fastest path to demoable v1" framing.

2. **The mutation gateway's primary value (DAG integration) requires the execution graph engine.** We explicitly decided NOT to port the execution graph (see docs/13_HARVEST_NOTES.md §3: "Tight coupling risk: HIGH — not a 'port a module' task, it's an architectural rewrite"). Without the execution graph, the gateway is a more complex version of pendingChangesService with features that don't yet have consumers.

3. **The features the gateway adds can be layered onto pendingChangesService incrementally:**
   - Source tagging: add a `source` field to `PendingChangeEntry` (1-line interface change + callers pass the source)
   - Audit trail: the local usage log (Step 2) already captures tool-call events; add a `mutation_logged` event type
   - Checksums: add pre/post hash computation in `stageFile()` and `accept()` — ~20 lines
   - Rollback metadata: store the original content hash + content in a rollback log on accept — ~30 lines

4. **When swarm mode lands (v1.1), we can revisit.** Swarm introduces concurrent writes, which makes conflict detection and source tagging immediately valuable. At that point, extending pendingChangesService to handle conflict detection (file-level locking, as designed in 08_SWARM_DESIGN.md §3.2) is a natural incremental step.

5. **The "replace with mutation gateway" path should be re-evaluated at v1.2** if and only if:
   - Swarm mode is in production use
   - The incremental extensions prove insufficient for the use cases that emerge
   - The execution graph engine is ported (or reimplemented) to provide DAG integration

---

## 5. Caveats

1. **This evaluation is based on INFERRED behavior of IAIExecutionService** — the Real-vibecode repo was not available for reading. If the actual implementation is significantly different from what I've inferred, the cost/benefit analysis may change.

2. **The execution graph engine is the key dependency.** If someone ports it (or reimplements it from scratch for fresh's architecture), the mutation gateway becomes much more valuable because it can link mutations to graph nodes.

3. **This recommendation is input to the lead's decision, not a unilateral choice.** The lead may have use cases I'm not aware of that make the mutation gateway more valuable than my analysis suggests.

---

## 6. What incremental extension looks like

If the recommendation is accepted, here's the rough scope for adding gateway-like capabilities to pendingChangesService:

| Feature | Effort | When needed |
|---------|--------|-------------|
| Source tagging on PendingChangeEntry | ~2 hours | v1.1 (swarm) |
| Checksum computation (pre/post) | ~4 hours | v1.0-rc (integrity) |
| Rollback log (accept-time) | ~1 day | v1.0-rc (undo without git) |
| Conflict detection (swarm locking) | ~2 days | v1.1 (swarm) |
| DAG integration (requires graph engine) | ~1 week | v1.2+ (post-graph) |

Total incremental: ~3.5 days for v1.0-rc features, ~4.5 more days for v1.1 swarm features. This compares favorably to the ~2-3 weeks estimated for a full mutation gateway replacement.
