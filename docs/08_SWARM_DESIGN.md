# 08 — Swarm Design Doc (v1.1, PROPOSAL — NOT IMPLEMENTED)

> **Status: DESIGN DOC for lead review.** Per Phase 9-A prompt: "Do not write
> implementation code in this task. Write docs/08_SWARM_DESIGN.md covering:
> role dispatch, conflict resolution, UI implications, and how this interacts
> with the existing single-agent Approve gate." This is a design doc for
> sign-off, same process as the Phase 2 architecture doc. Expect back-and-forth
> before this gets approved. Phase 9-B (implementation) is NOT written yet —
> it gets written after 9-A is approved AND after v1.0-beta has been used
> enough to know whether swarm is even still the right next thing.

---

## 1. Why swarm?

The single-agent Plan → Approve → Execute → Verify loop (v0.1) works well for
tasks that fit in one head: "add a unit test", "refactor this function",
"fix the bug in auth.ts". It struggles when a task naturally decomposes
into independent sub-tasks that could run in parallel:

- "Add OAuth support for Google, GitHub, and Microsoft" — three independent
  provider integrations, no shared state.
- "Migrate the test suite from Jest to Vitest and update the CI config" —
  test migration + CI config are independent.
- "Add a REST API for users, posts, and comments" — three resources, mostly
  independent.

A single agent does these serially. A swarm could do them in parallel,
finishing in 1/N the wall-clock time (where N is the number of agents).

**The bet:** for users who want to throw a large task at Kovix and walk away,
swarm mode could be a 3-5x speedup. For users who want tight control over
each step, single-agent mode remains the default.

---

## 2. What the old repo (Kovix_2.0) had, and why it was wrong

Kovix_2.0 had a `MultiAgentOrchestrator` class with ~800 lines of code. The
Round 2C audit assessed it as having:
- **No role dispatch** — all agents were identical; the orchestrator just
  spawned N copies and gave each a slice of the task. No specialization.
- **No conflict resolution** — if two agents tried to edit the same file,
  the last write won silently. No detection, no locking, no merge.
- **No UI** — the swarm ran invisibly. The user had no way to see which
  agent was doing what, or to intervene.

The old design's goals were wrong because they assumed the user wanted
maximum autonomy. The v0.1-alpha experience (Plan → Approve → Execute →
Verify) suggests the opposite: users want visibility and control, especially
for tasks that touch multiple files.

**This design does NOT carry forward any code from Kovix_2.0's swarm.** It's
a clean rewrite with different goals.

---

## 3. Design questions that need lead sign-off

These are the decisions that shape the entire implementation. I'm proposing
answers, but the lead decides.

### 3.1 Role dispatch: how do tasks get assigned to agents?

**Option A: Manual role assignment.** The user (or the lead agent) explicitly
partitions the task into sub-tasks, each with a named role:
```
- Agent "auth-google": add Google OAuth provider
- Agent "auth-github": add GitHub OAuth provider
- Agent "auth-ms": add Microsoft OAuth provider
```
Pros: explicit, predictable, the user stays in control. Cons: requires the
user to think about partitioning, which is the cognitive load swarm is
supposed to eliminate.

**Option B: Automatic partitioning by the lead agent.** A single "lead"
agent runs the existing Plan → Approve loop. After approval, it partitions
the plan into independent sub-plans and spawns worker agents. Each worker
runs its own Plan → Approve → Execute → Verify loop on its sub-plan.
Pros: zero cognitive load for the user. Cons: the lead agent might
partition badly, and the user can't easily intervene mid-partition.

**Option C: Hybrid.** The lead agent proposes a partition (like Option B),
but the partition is shown to the user as a "swarm plan" card — the user
approves the partition before any workers spawn. This is the Plan → Approve
pattern applied twice: once for the partition, once per worker.

**My recommendation: Option C.** It matches the v0.1-alpha value prop
(you approve before execution) and gives the user a chance to catch bad
partitions. The cost is one extra approval click, which is acceptable.

### 3.2 Conflict resolution: what happens when two agents want to edit the same file?

**Option A: File-level locking.** When an agent starts executing a plan
that touches file X, it acquires a lock on X. Other agents that want to
touch X block until the lock is released. If two agents want X
simultaneously, one waits for the other.
Pros: simple, correct. Cons: can serialize tasks that could otherwise run
in parallel if they touch different parts of the same file.

**Option B: Edit-level merging.** Agents don't lock files — they produce
diffs, and a merge step applies all diffs at the end. If two diffs
overlap, the merge fails and the user is asked to resolve.
Pros: maximum parallelism. Cons: merge conflicts are cognitively expensive
for the user, and the agent can't help resolve them (it doesn't know which
diff is "right").

**Option C: Detect-and-warn.** No locking. If two agents try to edit the
same file, the second one to finish is flagged as a conflict, and the user
is asked to choose which version to keep (or merge manually).
Pros: simple, no blocking. Cons: wasted work (the second agent's execution
is thrown away if the user picks the first).

**My recommendation: Option A (file-level locking) for v1.1.** It's the
simplest correct option. Edit-level merging (Option B) is theoretically
nicer but the merge-conflict UX is hard. Detect-and-warn (Option C) wastes
compute. We can upgrade to Option B in v1.2 if users hit locking
bottlenecks.

### 3.3 UI: does swarm need a 3rd webview surface?

**D-012 constraint:** exactly 2 webview surfaces (agent chat + pending
changes). Adding a 3rd requires explicit reconsideration.

**Option A: Extend the existing agent panel.** The agent panel shows a
"swarm view" when swarm mode is active: a tree of agents (lead + workers),
each expandable to show its individual chat stream. The user clicks an
agent to see its messages. This reuses the existing webview.
Pros: no new surface, D-012 holds. Cons: the panel gets visually complex
with 4+ agents.

**Option B: New "Swarm" webview surface.** A separate panel (3rd surface)
that shows the swarm topology + per-agent streams. The existing agent
panel stays for single-agent mode.
Pros: clean separation. Cons: D-012 violation — needs explicit
reconsideration.

**My recommendation: Option A (extend existing panel) for v1.1.** The
swarm view is a mode of the existing panel, not a separate surface. D-012
holds. If the panel gets too complex with 4+ agents, we can reconsider
Option B in v1.2.

**D-012 reconsideration flag:** I do NOT think D-012 needs to be revisited
for v1.1. The existing panel can handle a tree-of-agents view without a
new surface. If user testing shows the tree view is unreadable, that's
the trigger to revisit — not now.

### 3.4 Approve gate: does each worker get its own approval flow?

**Option A: One unified queue.** The lead agent's plan-approval card lists
all sub-plans. The user approves once (with one click). Workers execute
in parallel, each following the approved sub-plan. No per-worker approval.
Pros: minimal clicks. Cons: if one worker's sub-plan is bad, the user
approved it without seeing it in detail.

**Option B: Per-worker approval.** Each worker presents its own plan-
approval card before executing. The user approves N times (where N is the
number of workers). Workers run in parallel after their individual approvals.
Pros: fine-grained control. Cons: N clicks for N workers, which defeats
the "walk away" value prop of swarm.

**Option C: Tiered approval.** The user approves the partition (which
workers, which files each touches) once. Then each worker runs
Plan → Execute → Verify autonomously (no per-worker plan approval), but
the user can pause/skip/abort any worker at any milestone (same controls
as single-agent mode).
Pros: one approval click + real-time control. Cons: the user approves
partitions they haven't seen in detail.

**My recommendation: Option C (tiered approval) for v1.1.** It matches the
existing autonomy-mode system (the user already chooses
every-milestone / major-milestone / selective / full-auto). In swarm mode,
the default would be "approve the partition, then each worker runs at
whatever autonomy mode the user picked". This is consistent with v0.1.

---

## 4. Architecture sketch (if the above decisions are approved)

```
User task
    ↓
[Lead Agent] — runs Plan → Approve on the full task
    ↓ (user approves the plan)
[Partitioner] — lead agent partitions the plan into N independent sub-plans
    ↓
[Swarm Plan Card] — shows the partition to the user (which agents, which files each touches)
    ↓ (user approves the partition)
[N Worker Agents] — spawn in parallel, each runs its own Plan → Execute → Verify loop
    ↓ (file-level locking prevents conflicts)
[Aggregator] — collects each worker's results, produces a final summary
    ↓
[Complete event] — user sees the final summary + per-worker breakdown
```

**New components (v1.1):**
- `src/swarm/partitioner.ts` — LLM prompt that takes a plan + asks for a
  partition into independent sub-plans. Output: array of sub-plans, each
  with the files it touches.
- `src/swarm/orchestrator.ts` — spawns worker agents, manages locks,
  aggregates results.
- `src/swarm/fileLock.ts` — async file-level lock manager. Acquire/release
  with timeout.
- `src/ui/webview/swarmView.js` — extends the existing agent panel to show
  a tree-of-agents view when swarm mode is active. Reuses the existing
  webview (D-012 holds).

**Reused components:**
- `AgentLoopService` — each worker is a full AgentLoopService instance with
  its own conversation history, tool registry, and approval flow.
- `toolRegistryService` — all workers share the same tool registry (they
  have the same tools available).
- `pendingChangesService` — file changes go through the same P0-5 pipeline.
  File locking happens BEFORE pendingChanges (a worker can't stage a change
  to a file it doesn't have the lock for).

---

## 5. Security considerations

- **SEC-4 (workspace boundary):** each worker uses the same
  `assertWithinWorkspace()` check. No new surface.
- **SEC-6 (prompt injection):** each worker sanitises its own tool outputs.
  The lead agent's partition prompt is also sanitised (the partition is
  derived from the user's task, which is trusted, but the LLM's response
  is not).
- **SEC-9 (child process env):** workers don't spawn child processes
  directly — they use the shared tool registry, which already enforces
  SEC-9.
- **Cost governor:** swarm mode multiplies LLM cost by N (number of
  workers). The cost governor (deferred to v1.0-beta per D-005) MUST be
  wired before swarm ships, or the user could accidentally spend N× their
  expected API budget.

---

## 6. Open questions for lead review

1. **Is swarm even the right next thing after v1.0-beta?** The user might
   find that single-agent mode + memory (M5) + MCP (M6) is enough for
   90% of tasks, and swarm is a nice-to-have that doesn't justify the
   complexity. **Recommendation: don't start 9-B until you've used v1.0-beta
   for 2+ weeks of real work.**

2. **How many workers is too many?** The partitioner could split a task
   into 10 sub-plans, but 10 parallel agents is a lot of cognitive load
   for the user (even with a tree view) and a lot of API cost. Cap at 4?
   5? Make it configurable?

3. **What happens if a worker fails mid-execution?** Does the lead agent
   retry, skip, or abort the whole swarm? My recommendation: the worker's
   failure is surfaced to the user (like single-agent mode), and the user
   decides whether to retry/skip/abort. Other workers continue.

4. **Memory interaction:** if M5 (memory) is wired, each worker stores its
   own memories. Does the lead agent also store a "swarm summary" memory?
   My recommendation: yes — the aggregator produces a summary that's
   stored as a single memory entry.

---

## 7. What I need from you

React to each of the 4 design questions in §3. For each:
- "Go with your recommendation"
- "Go with option X instead"
- "Need more analysis on ____ before deciding"

Once all 4 are decided, I write the implementation plan (Phase 9-B). But
per the prompt: **9-B is not written yet, and shouldn't be written until
you've used v1.0-beta enough to know whether swarm is even still the right
next thing.**

---

## Appendix: what this design deliberately does NOT do

- **No automatic task decomposition without user approval.** The partition
  is always shown to the user before workers spawn (Option C in §3.1).
- **No cross-worker communication.** Workers don't talk to each other;
  they only talk to the lead agent (via the aggregator). This avoids the
  complexity of inter-agent messaging.
- **No dynamic re-partitioning.** Once the partition is approved, workers
  are fixed. If a worker discovers its sub-plan is too big, it can't
  split itself — it just runs to completion (or fails). Dynamic
  re-partitioning is a v1.2+ feature.
- **No worker-specific tool restrictions.** All workers have access to all
  tools. Per-worker tool restrictions (e.g. "worker A can only read, worker
  B can write") are a v1.2+ feature.
