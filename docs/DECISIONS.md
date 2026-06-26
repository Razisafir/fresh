# DECISIONS.md — Kovix Rebuild Decision Log

**Started:** 2026-06-27 (Phase 1)
**Format:** One entry per decision. Newest at top. Each entry has: ID, date, decision, context, alternatives considered, tradeoffs, revisit-at.
**Rule:** Every "keep / rewrite / merge / drop" choice for code from Kovix_2.0 lands here. No silent decisions.

---

## D-007 — Phase 1 requirements locked
**Date:** 2026-06-27
**Decision:** Phase 1 requirements are locked as `docs/01_REQUIREMENTS.md` v1.0. Future scope changes require a new DECISIONS.md entry and an explicit user sign-off.
**Context:** User answered Phase 1 interview. 7 MUST features, 2 SHOULD, 3 WON'T. VS Code fork base. Windows first. Medium involvement. Budget/timeline pressure flagged.
**Alternatives considered:** Could have deferred locking requirements until OQ-1/OQ-2/OQ-3/OQ-4 answered. Chose to lock now so Phase 2 can start on M1-M6 (which don't depend on open questions), with M7/M8 architecture deferred.
**Tradeoffs:** Risk of rework if user answers change MUST scope. Mitigated by keeping M7/M8 architecture work deferred until their OQs are answered.
**Revisit at:** When user answers OQ-1 (security tools sign-off), OQ-2 (swarm scope), OQ-3 (fork base confirmation), OQ-4 (timeline pressure). Whichever answer materially changes MUST scope triggers a new decision entry.

---

## D-006 — Multi-agent swarm is MUST for v1 (with caveats)
**Date:** 2026-06-27
**Decision:** Multi-agent swarm (M7) is MUST for v1, but with explicit acknowledgment that the old repo's implementation has known limitations (no auto role dispatch, no swarm UI, no conflict resolution UI). v1 ships the role-handoff design from `recovery/phase-28-launch`.
**Context:** User marked swarm as MUST in interview. Old repo's `docs/DECISIONS-v1.8.0.md` Decision 1 ported `multiAgentExecution.ts` (141L) + `multiAgentExecutionService.ts` (595L) from phase-28-launch to main. Old repo tracks v1.9.0 work for auto role dispatch + UI as issue #140 (repurposed).
**Alternatives considered:**
- (a) Ship v1 with old repo's limitations — fastest, but users hit walls quickly
- (b) Invest 2-3 additional weeks to close auto role dispatch + minimal UI before launch
- (c) Defer swarm to v1.1 entirely (saves 3-4 weeks on critical path)
**Tradeoffs:** Option (a) creates UX debt. Option (b) delays v1. Option (c) removes a MUST feature. Lead recommends (c); user marked MUST so (a) or (b) is the default. OQ-2 asks user to pick.
**Revisit at:** When user answers OQ-2.

---

## D-005 — Security tools are MUST but BLOCKED pending sign-off
**Date:** 2026-06-27
**Decision:** Security tools (nmap/ghidra/nuclei) are MUST for v1, BUT no work begins until user provides explicit written sign-off that intended use is defensive / owned-systems only. Tracked as M8 in `docs/01_REQUIREMENTS.md` with `⚠️ PENDING SIGN-OFF` flag.
**Context:** User marked security tools as MUST in interview. Project rules §4 explicitly require sign-off before any migration of `extensions/kovix-security-tools/`. Old repo had schema-only stubs with zero execution handlers (STUB_AUDIT C-1) AND not registered in tool registry (STUB_AUDIT L-3). README still marketed them.
**Alternatives considered:**
- (a) Treat user's MUST answer as the sign-off — REJECTED. Project rules require explicit defensive-use confirmation, not implicit.
- (b) Drop security tools from v1 entirely — REJECTED. User marked MUST. Lead recommendation in OQ-1 is to drop if user isn't actively doing security work, but that's user's call.
- (c) Ship v1.0 without M8, defer to v1.1 (current plan in `01_REQUIREMENTS.md` §4 shipping order). M8 work begins only after sign-off received.
**Tradeoffs:** Deferring M8 to v1.1 means v1.0 ships without a feature the user marked MUST. But the deferral is conditional on sign-off — if user signs off before v1.0 ships, M8 can move into v1.0.
**Revisit at:** When user answers OQ-1 (security tools sign-off question).

---

## D-004 — VS Code / Code-OSS fork as base architecture (default, pending comparison)
**Date:** 2026-06-27
**Decision:** Default base architecture for `fresh` is a fresh fork of microsoft/vscode (Code-OSS), with all Microsoft telemetry stripped. This is the same choice the old repo made, done cleanly this time. The fork is into the `fresh` repo (new), NOT a fork of the `Kovix_2.0` repo.
**Context:** User picked "VS Code fork (same as old)" in interview. User's remarks were explicit: "we will not fork the kovix_2.0 repo what we will do instead is that we will follow the standard sdlc thing and go step by step and we can use files from the prevous repo but we will not copy without reading we must read each character when we are copying".
**Alternatives considered:**
- (a) VS Code extension — much lower maintenance, but limited to extension APIs. Can't deeply customize workbench.
- (b) Theia — web-first, more flexible than extension, less maintenance than fork.
- (c) Standalone Electron + Monaco editor — most flexibility, most work, we own everything.
**Tradeoffs:** Fork gives maximum power (full IDE control, can deeply retheme, can add custom UI surfaces like the agent panel as a first-class citizen). Cost: massive maintenance burden (weekly upstream rebases against microsoft/vscode), 8,000+ inherited files, MIT attribution obligations, native module compilation pain (libxkbfile-dev on Linux, etc.). Old repo's `BUILD_STATUS.md` documents the pain in detail.
**Revisit at:** Phase 2 will produce a one-page comparison matrix of all 4 options (~1 day of work). User confirmed in interview they want the comparison even though fork is the default. Decision can be reversed at Phase 2 gate if comparison reveals fork is wrong for v1 scope.

---

## D-003 — Involvement level: medium (lead decides, documents, asks only on big calls)
**Date:** 2026-06-27
**Decision:** Lead has authority to make day-to-day keep/rewrite/drop decisions and document them in DECISIONS.md without asking user. Lead asks user only on: (1) licensing ambiguity, (2) security tooling, (3) irreversible architecture choices, (4) anything explicitly flagged as "big call" by lead's judgment.
**Context:** User picked "Medium — only big calls" in interview.
**Alternatives considered:**
- (a) High — surface every keep/rewrite/drop decision. Rejected — too much overhead for solo user.
- (b) Low — just ship it, report at phase boundaries. Rejected — user wants visibility on big calls.
**Tradeoffs:** Medium means lead has to be disciplined about what counts as "big". Mitigation: DECISIONS.md is the audit trail. User can review at any time and override.
**Revisit at:** Any phase boundary if user wants to change involvement level.

---

## D-002 — Windows is the first target platform for v1.0
**Date:** 2026-06-27
**Decision:** v1.0 ships Windows first. macOS and Linux follow in v1.1 / v1.2.
**Context:** User picked "Windows first" in interview. Old repo targeted all three simultaneously, which split packaging effort.
**Alternatives considered:**
- (a) All three simultaneously — matches old repo. Rejected: splits packaging effort, delays v1.0.
- (b) macOS first — lowest friction for first launch if user is on Mac. Rejected: user picked Windows.
- (c) Linux first — best for headless/server use cases. Rejected: not aligned with solo-dev audience.
**Tradeoffs:** Windows-first means macOS/Linux users wait. But solo devs (the audience) skew Windows. Native module compilation is actually easiest on Windows (VS Code toolchain bundles system libs); Linux requires `libxkbfile-dev` etc., macOS requires Xcode.
**Revisit at:** v1.0 ship. If Windows packaging proves much harder than expected, can pivot to macOS-first.

---

## D-001 — Rebuild approach: file-by-file audit, no bulk copy
**Date:** 2026-06-27
**Decision:** No file from `Kovix_2.0` enters `fresh` without being read in full, understood, and deliberately chosen. Per-file audit template (project rules §5) is filled out for every migrated file and committed to `docs/03_MIGRATION_LOG.md`.
**Context:** User's remarks: "we will not fork the kovix_2.0 repo... we can use files from the prevous repo but we will not copy without reading we must read each character when we are copying and also there are duplicates in diffrent branches". Old repo has known duplicates across recovery branches (per `HARVEST_CANDIDATES.md`).
**Alternatives considered:**
- (a) Bulk copy from Kovix_2.0 main branch. Rejected — this is what made the old repo messy.
- (b) Cherry-pick specific commits from Kovix_2.0 branches. Rejected — branches diverge by tens of thousands of lines, cherry-picks don't apply cleanly. Per-file audit is cleaner.
- (c) Clean rewrite of everything from scratch. Rejected — too slow given timeline pressure. Some old code is genuinely good (the agent loop, the LLM provider layer) and should be ported with audit.
**Tradeoffs:** File-by-file audit is slower than bulk copy but faster than full rewrite. Produces a recoverable artifact (the migration log) that explains WHY each file was kept/rewritten/dropped.
**Revisit at:** Never. This is a foundational rule for the rebuild.

---

## How to add a new decision entry

1. Increment the D-XXX ID (highest current + 1).
2. Add the new entry at the TOP of the file (newest first).
3. Include all sections: Date, Decision, Context, Alternatives considered, Tradeoffs, Revisit at.
4. Commit with message: `decision(D-XXX): <one-line summary>`.
5. If the decision changes MUST scope in `01_REQUIREMENTS.md`, also update that doc in the same commit.
