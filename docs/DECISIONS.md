# DECISIONS.md — Kovix Rebuild Decision Log

**Started:** 2026-06-27 (Phase 1)
**Format:** One entry per decision. Newest at top. Each entry has: ID, date, decision, context, alternatives considered, tradeoffs, revisit-at.
**Rule:** Every "keep / rewrite / merge / drop" choice for code from Kovix_2.0 lands here. No silent decisions.

---

## D-015 — All scanned repos are original work, relicensable as MIT
**Date:** 2026-06-29
**Decision:** All repos scanned during the account audit (Kovix_2.0, Real-vibecode, Aegis, construct-ai-agent) are the project lead's original work. Most were private repos. They can be relicensed to MIT (or any license) without attribution concerns. No third-party code licensing conflicts exist for harvesting patterns from these repos into `fresh`.
**Context:** Hard Stop #2 required the project lead to confirm whether Aegis (and by extension, all other scanned repos) was completely original or reference-only. The user confirmed: "all the repos scanned were mine plus most of them were private and not public hence i can make it mit or whatever u want."
**Alternatives considered:** N/A — this was a factual gate.
**Tradeoffs:** None — this is the best-case outcome. All harvest work is on solid legal footing.
**Action items:** None — gate is cleared.
**Revisit at:** N/A.

## D-014 — Electron Stage 1 Smoke Test PASSED
**Date:** 2026-06-29
**Decision:** Hard Stop #1 (Electron Stage 1 smoke test) is **PASSED**. The standalone Electron app was run by the project lead on Windows 10 (build 26200.8737), branch `harvest/full-run`. The user: (1) launched the app via `npm start`, (2) selected a workspace folder (`C:\Users\Lenovo\Desktop\Kovix trial folder`), (3) entered the task "Create a file called test-smoke.txt with the content 'smoke test passed'" in Chat mode, (4) saw a plan proposed, (5) approved it, (6) confirmed the file was written to disk. The full terminal log confirms: `[PendingChanges] Accepted and written to disk: C:\Users\Lenovo\Desktop\Kovix trial folder\test-smoke.txt`.
**Context:** The harvest plan required a human-run smoke test before any harvest work could be considered verified. This was Hard Stop #1 — could not be inferred or bypassed.
**Bug discovered during test:** The OpenRouter API key (`sk-or-v1-...`) was accidentally submitted as a chat message. Log line: `[AgentLoop] Chat mode started: sk-or-v1-[REDACTED]`. This is a UI/input-handling bug — the API key field and the chat input field may share focus or the key was pasted into the wrong field. Filed as ISSUE O-002.
**Alternatives considered:** N/A — this was a pass/fail gate.
**Tradeoffs:** N/A
**Action items:**
1. Investigate the API-key-as-chat-message bug. Likely a focus or event-handling issue in the renderer.
2. Hard Stop #2 (Aegis license) remains open — needs user answer.
**Revisit at:** N/A — gate is passed.

## D-013 — UI design direction: Cursor/Codex polish with Material aesthetic
**Date:** 2026-06-27
**Decision:** The Kovix webview UI will be designed to **Cursor / Codex CLI quality** — sleek, modern, dark-first, with a **Google Material aesthetic** (layered surfaces, soft shadows, rounded corners, restrained color use, clear typographic hierarchy). The default theme is dark; light theme support is deferred. No pixel-for-pixel clone of Cursor or Codex — we take the *quality bar* and *overall feel*, not the specific layout.
**Context:** User flagged during Round 2C kickoff: "i was thinking like can we have like 2 sorta UI's one for the agent chat thing one the vs code sorta thing like the file manager typa thing" + "like codex and cursor i want something like that also a google antigracty type ui". The first part is captured in D-012 (UI surface scope — 2 webviews: agent chat + pending changes; everything else stays stock VS Code). This entry captures the *visual design direction* for those 2 webviews.
**Alternatives considered:**
- VS Code theme token only (no custom CSS) — REJECTED. Matches user's theme automatically but looks like every other webview extension. Doesn't meet the "Cursor/Codex quality" bar the user explicitly asked for.
- Tailwind UI / shadcn aesthetic — DEFERRED. Great for web apps, but adds a build step and a 200KB+ CSS payload to the webview. We can revisit at v1.0-beta if the vanilla CSS approach hits complexity limits.
- Hand-drawn / skeuomorphic — REJECTED. Wrong register for a developer tool.
**Tradeoffs:**
- *Positive:* Design direction is locked, so when the UI phase opens we don't burn a day debating "what should this look like". The Cursor/Codex bar is concrete and referenceable.
- *Positive:* Material aesthetic is well-documented (Material 3 design tokens are public) — gives us a ready-made color/elevation/typography system to adapt.
- *Negative:* Dark-first means light-theme users get a worse experience until v1.0-beta. Acceptable per D-010 (fastest path to demoable v1).
- *Negative:* "Material aesthetic" is a guideline, not a spec — there's still design work to translate it into actual CSS variables. That work happens in the UI phase, not now.
**Action items:**
1. When the UI phase opens: produce a `docs/04_DESIGN_SYSTEM.md` with concrete CSS variables (color tokens, elevation, typography scale, spacing, radius) adapted from Material 3 to fit a developer tool's density.
2. The agent chat webview and the pending changes webview share the same design system.
3. Stock VS Code surfaces (file explorer, editor, terminal) are NOT re-themed — they keep the user's chosen VS Code theme. Only our 2 webviews get the Material treatment.
4. Logo design (referenced in user's question about "logo and design and branding") is a separate task, scheduled for the same UI phase. Old repo's fork-era logos (`repos/Kovix_2.0/resources/{linux,win32,server}/kovix-*.png`) are NOT reused — they were app-window icons for the fork, not extension marketplace icons.
**Revisit at:** When the UI phase opens (after Round 2D or Round 3, depending on what's needed to ship v0.1 alpha). If the Material direction proves to clash with VS Code's webview theming constraints in practice, we may need to soften to "Material-influenced VS Code theme tokens" — but that's a tactical adjustment, not a reversal.

---

## D-012 — UI surface scope: 2 webviews (agent chat + pending changes), everything else stock VS Code
**Date:** 2026-06-27
**Decision:** The v1.0 UI surface is exactly **2 webviews**: (1) the **Kovix Agent Chat panel** (right-side, Cursor-composer-style — message list, thinking indicator, input box, plan display, execution stream), and (2) the **Pending Changes / Approval panel** (collapsible section inside the chat panel for v0.1, can split into its own panel in v1.0). The VS Code file explorer, editor tabs, integrated terminal, search panel, Git panel, and debug panel are **NOT replaced** — users keep all their VS Code muscle memory.
**Context:** User asked during Round 2C kickoff: "can we have like 2 sorta UI's one for the agent chat thing one the vs code sorta thing like the file manager typa thing". This entry codifies that the "VS Code sorta thing / file manager" half is **already there** (stock VS Code), and we only build the chat half. The `02_ARCHITECTURE.md` §4.7 UI layer spec already implied this, but D-012 makes it an explicit decision so we don't accidentally scope-creep into building a duplicate file explorer.
**Alternatives considered:**
- Build our own file explorer webview — REJECTED. Massive scope creep, duplicates VS Code's best-in-class file tree, no differentiation. The `read_file` / `write_file` / `list_directory` tools already operate on the same workspace the user sees in the stock explorer.
- Single combined webview (chat + explorer + terminal all in one) — REJECTED. This is the Cursor model, but it requires forking VS Code (D-011 explicitly chose extension route). The extension API does not let us replace the file explorer; we work *with* it, not against it.
- 3+ webviews (chat + pending changes + control center + memory browser + mode editor + API settings + onboarding) — DEFERRED. The full set is in `02_ARCHITECTURE.md` §4.7 for v1.0. v0.1-alpha ships only the agent chat panel + the pending changes inline section. The other webviews land in v1.0-beta+ as their backing services land.
**Tradeoffs:**
- *Positive:* Smallest possible UI surface for v0.1. The Plan→Approve→Execute→Verify flow is fully demonstrable with just these 2 webviews.
- *Positive:* Users keep all VS Code muscle memory (keybindings, snippets, other extensions). No "learn a new IDE" tax.
- *Positive:* The approval gate (Pending Changes panel) is visually adjacent to the chat — the user can see the agent's plan, watch it execute, and approve changes without context-switching.
- *Negative:* We cannot do deep editor chrome customization (custom title bar, custom activity bar icons). Already accepted per D-011.
- *Negative:* The "Kovix is its own IDE" framing is weaker — we're explicitly a VS Code extension. Marketing copy will reflect this. Already accepted per D-011.
**Action items:**
1. v0.1-alpha ships ONLY: `src/ui/agentPanel.ts` + `src/ui/webview/agentPanel.{html,js,css}`. The pending-changes section is a collapsible `<section>` inside the same webview, NOT a separate file.
2. The 6 v0.1 commands registered in Round 2C (openAgentPanel, manageApiKeys, setActiveMode, runTask, viewPendingChanges, resumeMilestone, skipMilestone) currently use stock VS Code UI primitives (InputBox, QuickPick, OutputChannel, modal InformationMessage). These get replaced by webview UI in the next round. The current command-based flow is the headless / power-user / test path; the webview is the friendly path.
3. The `viewsContainers` and `views` entries in `package.json` already declare the activity-bar icon + the agentPanel webview container. The icon (`media/kovix-viewbar.svg`) needs to be created in the UI phase — currently a placeholder path.
**Revisit at:** v1.0-beta when the control center / memory browser / mode editor webviews land. The split of "pending changes as inline section" vs "pending changes as its own webview" is revisited at the same time based on real usage.

---

## D-011 — Base architecture: VS Code extension (not fork). Supersedes D-004.
**Date:** 2026-06-27
**Decision:** The base architecture for `fresh` is a **VS Code extension** (`.vsix`), NOT a VS Code / Code-OSS fork. Users install stock VS Code (or VS Code Insiders), then install the Kovix extension. This formally supersedes D-004 ("VS Code / Code-OSS fork as base architecture"). D-004 is retained in this log for history but is no longer the active architecture decision.
**Context:** Phase 2 OQ-3 comparison matrix (`docs/02a_ARCH_CHOICE_MATRIX.md`) evaluated four options — (A) fork, (B) extension, (C) Theia, (D) Electron+Monaco — across six dimensions. Recommendation was (B) extension. Project lead delegated the decision to rebuild lead with directive to "choose the smartest options and act as a project lead". Decision: approve (B).
**Evidence supporting the switch (from matrix §"decisive evidence"):**
1. The concrete `AgentLoopService` (1,946 LOC) imports VS Code platform services (`IFileService`, `ICommandService`, `ILogService`, `IDialogService`, `IWorkspaceContextService`). Every one has a direct equivalent in the public `vscode` extension API.
2. The DI pattern (`createDecorator`) is VS Code-internal but structurally simple — replaces with explicit singletons. Pattern translation, not deep rewrite.
3. The 2,388-line central wiring file (`construct.contribution.ts`) collapses into the extension's `activate()` function — same calls, different API surface (`registerCommand`, `registerWebviewViewProvider`, `contributes.configuration`).
4. The pure-logic layer (`src/vs/platform/construct/common/...`, the bulk of the lines) has zero VS Code imports beyond `createDecorator` and `Event` — ports with essentially no changes.
5. The old repo's `extensions/kovix-security-tools/extension.ts` is ALREADY a proper public-API extension — only imports `vscode`, nothing internal. The extension pattern is already proven in the codebase. (Note: security tools are themselves excluded from v1 per D-008, but the pattern proof stands.)
**Alternatives considered:**
- (A) VS Code fork (D-004 default) — REJECTED. Maintenance burden (weekly upstream rebases against ~8,000 inherited files, native module compilation pain) is a permanent tax that compounds. None of the v1 MUST features (M1-M6) require fork-level access. Under D-010's timeline pressure, this is the wrong trade.
- (C) Theia — REJECTED. Theia is right for cloud-hosted IDEs or deeply customized IDE products. Kovix is neither. Theia's added flexibility is unused; its added complexity is paid in full.
- (D) Electron + Monaco — REJECTED. Building a custom IDE shell is months of work for zero product differentiation. The editor is not the differentiator; the agent loop is.
**Tradeoffs:**
- *Positive:* v1.0-alpha demo in 3-5 days (vs. 3-4 weeks for fork). Total v1.0 in 5-8 weeks (vs. 11-15). No upstream rebases. Clean licensing (no MIT attribution chain from Code-OSS source tree). High reversibility — extension → fork is feasible later if a hard need for fork-level access emerges.
- *Negative:* Users must install stock VS Code first, then install Kovix. Slightly different framing from "Kovix is its own app" — marketing copy will reflect this. Not a blocker.
- *Negative:* Cannot do deep editor chrome customization (custom title bar, custom activity bar icons, etc.). None of the v1 MUST features require this. If a future MUST emerges that needs it, we revisit at that time.
**Action items:**
1. `docs/02_ARCHITECTURE.md` is written with extension as base.
2. `docs/01_REQUIREMENTS.md` M1 is updated from "VS Code / Code-OSS fork as base" to "VS Code extension as base".
3. `docs/01_REQUIREMENTS.md` constraints table is updated: the "MIT attribution carried forward" constraint is REMOVED (we are not forking Code-OSS source; the VS Code extension host is the user's own VS Code install, not our redistributable).
4. Phase 3 (Migration) will port agent-core files using the mapping in `02_ARCHITECTURE.md` §6, with per-file audit per D-001.
**Revisit at:** If a future MUST feature requires fork-level access (deep editor chrome, custom language server, etc.) that the extension API genuinely cannot deliver, this decision is reversed at that time. Until then, this is locked for v1.0 and v1.1.

---

## D-010 — Timeline framing: soft-but-real pressure, optimize for fastest path to demoable v1
**Date:** 2026-06-27
**Decision:** Treat the user's flagged budget/timeline pressure as soft-but-real. Every remaining tradeoff in Phase 2+ is optimized for "fastest path to a usable, demoable v1" over feature completeness. When in doubt between extending the timeline and cutting scope, cut scope.
**Context:** OQ-4 answer from project lead. User flagged pressure in Phase 1 interview; this entry codifies how that pressure translates to day-to-day decisions.
**Alternatives considered:**
- (a) Treat timeline as hard (funding runs out) — REJECTED. User did not signal a hard cutoff.
- (b) Treat timeline as preference only — REJECTED. User explicitly said "soft-but-real", not "ignore".
- (c) Cut scope unilaterally without telling user — REJECTED. Scope cuts above a single MUST feature still require user sign-off per D-003's "big call" rule. This decision just establishes the bias.
**Tradeoffs:** Bias toward cutting scope means some SHOULD features will be deferred past v1.1. That's acceptable per the user's framing. Bias does NOT authorize skipping the file-by-file audit (D-001) or the security sign-off gate (D-005/D-008) — those are foundational rules, not scope.
**Revisit at:** If the user clarifies a hard deadline, this entry is superseded by a new entry with the actual date.

---

## D-009 — Multi-agent swarm (M7) deferred to v1.1
**Date:** 2026-06-27
**Decision:** Multi-agent swarm (M7) moves out of v1 MUST into a clearly labeled "v1.1 — Planned Next" section in `01_REQUIREMENTS.md`. v1 ships only the single-agent Plan→Approve→Execute→Verify loop.
**Context:** OQ-2 answer from project lead. The old repo's swarm implementation has no role dispatch, no UI, no conflict resolution — finishing it properly costs 3-4 weeks against a single-agent loop that is already the actual differentiator. Per D-010 (timeline pressure), this is exactly the kind of cut to make.
**Alternatives considered:**
- (a) Ship v1 with old repo's swarm limitations — REJECTED. Users hit walls immediately; UX debt.
- (b) Invest 2-3 weeks to close auto role dispatch + minimal UI — REJECTED. Delays v1, doesn't change the differentiator.
- (c) Defer to v1.1 — ACCEPTED. Saves 3-4 weeks on v1.0 critical path; swarm ships complete in v1.1.
**Tradeoffs:** v1.0 ships without a feature the user originally marked MUST. The single-agent loop remains the differentiator. The shipping order table in `01_REQUIREMENTS.md` §4 is updated accordingly.
**Revisit at:** v1.0 ship. If v1.0 ships faster than estimated, M7 work can begin immediately as v1.1 work.

---

## D-008 — Security tools (M8) dropped from v1, deferred to v2.0-maybe
**Date:** 2026-06-27
**Decision:** Security tools (nmap/ghidra/nuclei, M8) are removed from v1 MUST. They move to a new "Deferred / Not in v1" section in `01_REQUIREMENTS.md`. The v1.1 placeholder is also removed — M8 is now v2.0-maybe, not v1.x. Any v1-facing README/marketing language that implies these tools are available must be stripped.
**Context:** OQ-1 answer from project lead. The reasoning: not core to the product's value proposition; highest legal/liability surface for least payoff; and the README-markets-it-but-it's-unwired situation flagged in `00_OLD_REPO_STATE.md` is itself a problem to fix by removing the claim, not by rushing the wiring.
**Action items:**
1. `01_REQUIREMENTS.md` — move M8 out of MUST, into "Deferred / Not in v1" (new §6.x subsection). Update shipping order table.
2. `README.md` (in `fresh`) — must NOT market nmap/ghidra/nuclei. When the fresh README is written, it omits these tools entirely.
3. Old repo — DO NOT DELETE. The two security-tools folders (`extensions/kovix-security-tools/` and `src/vs/workbench/contrib/construct/browser/tools/security/`) get a `STUB_AUDIT` note: "reviewed, deliberately excluded from v1 per D-008". The old repo stays as-is; we just don't migrate this code into `fresh`.
4. D-005 (security tools MUST but blocked pending sign-off) — superseded by this entry. The sign-off gate is no longer needed because v1 doesn't ship these tools at all. If v2.0-maybe becomes real, the sign-off requirement revives at that time per project rules §4.
**Alternatives considered:**
- (a) Keep M8 as MUST, wait for sign-off — REJECTED. Even with sign-off, building real handlers (Docker+Ghidra, terminal+nmap, etc.) is significant new work that delays v1.
- (b) Ship M8 as SHOULD in v1.1 — REJECTED. Defers the legal/liability surface but doesn't eliminate it. Lead wants it off the v1.x roadmap entirely.
- (c) Drop M8 entirely, never revisit — REJECTED. The capability might make sense for a future security-focused product tier; v2.0-maybe preserves the option without committing.
**Tradeoffs:** v1 ships without a feature the user originally marked MUST. This is a big-call override per D-003, and the user explicitly authorized it in this decision. The positive tradeoff is significant: v1.0 has zero legal exposure to security-tooling misuse, zero opt-in UX complexity, and ~2-3 weeks of saved implementation work (real handlers, not stubs).
**Revisit at:** v2.0 planning. If by then there's user demand for a "Kovix Security Edition" or similar, M8 can be scoped properly with sign-off, real handlers, and dedicated UX. Until then, the old repo's security-tools folders remain untouched in Kovix_2.0 as reference material.

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
