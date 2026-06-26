# 02a_ARCH_CHOICE_MATRIX.md — Fork vs Alternatives (OQ-3)

**Date:** 2026-06-27
**Author:** Rebuild lead (agent session)
**Audience:** Project owner (non-engineer) — for sign-off
**Scope:** Exactly one page. Compares four base architectures for Kovix v1. Ends with a single explicit recommendation. **This is the most expensive-to-reverse decision in the project**, per the project lead's Phase 2 instructions — it requires explicit user sign-off before `docs/02_ARCHITECTURE.md` is written.

> **TL;DR — Recommendation:** Switch from "VS Code fork" (D-004 default) to **"VS Code extension"**. The user's starting bias is correct; the evidence below confirms it. The agent core is portable to extension form with mechanical translation work, not deep rewrite. This saves an estimated 6-10 weeks of maintenance burden over v1.0 + v1.1 and gets a demoable artifact in front of users in days, not weeks. **Awaiting user sign-off to proceed.**

---

## The four options

| # | Option | What it means in plain language |
|---|---|---|
| **A** | Continue as VS Code / Code-OSS fork | Same as old repo. Own the entire editor source tree (~8,000 files), rebase against microsoft/vscode weekly. |
| **B** | VS Code extension | Ship Kovix as a `.vsix` extension that runs inside stock VS Code / VS Code Insiders / Cursor / Windsurf. Users install it like any other extension. |
| **C** | Theia | A separate IDE framework also built on Monaco. We'd host Kovix inside Theia instead of VS Code. |
| **D** | Standalone Electron + Monaco editor | Build a custom IDE shell from scratch — we own everything: file tree, settings UI, command palette, terminal, etc. |

---

## Comparison matrix

| Dimension | (A) VS Code fork | (B) VS Code extension | (C) Theia | (D) Electron + Monaco |
|---|---|---|---|---|
| **Maintenance burden** | **HIGH.** Weekly upstream rebases against microsoft/vscode. ~8,000 inherited files to keep in sync. Native module compilation pain on Linux (`libxkbfile-dev`). Old repo's `BUILD_STATUS.md` documents this in detail. | **LOW.** Extensions API is stable and versioned. No upstream sync. Microsoft handles all editor internals. | **MEDIUM.** Theia releases are slower than VS Code but you still track upstream. Build is notoriously complex. | **HIGHEST.** You own the entire shell. Every feature (settings UI, command palette, file tree) is yours to maintain forever. |
| **Agent-core reusability from Kovix_2.0** | **HIGH as-is.** Already runs in this stack — no porting. ~6,600 LOC across `agentLoop.ts`, `construct.contribution.ts`, `constructAgentView.ts`, etc. | **MEDIUM-HIGH after mechanical port.** Agent core uses VS Code's DI pattern (`createDecorator`) and platform service interfaces (`IFileService`, `ICommandService`, `ILogService`, `IDialogService`, `IWorkspaceContextService`). Every one of those has a direct equivalent in the public `vscode` extension API. The port is mechanical: replace `IXxxService` imports with `vscode` API calls, replace `createDecorator` DI with explicit singletons, collapse `construct.contribution.ts` (2,388 lines) into `activate()`. **No deep rewrite of business logic.** Pure-logic files (`milestoneStateMachine.ts`, `agentLoopHelpers.ts`, `executionMode.ts`, all of `src/vs/platform/construct/common/`) port with zero changes. | **LOW-MEDIUM.** Theia has its own extension model (different API surface). Significant porting required. | **LOW.** Only Monaco (the editor widget itself) is reusable. The agent loop's collaborators (file system, terminal, command palette) all need to be rebuilt against your custom shell. |
| **Licensing implications** | **MIT attribution required.** `NOTICE.md` + `ThirdPartyNotices.txt` must be carried forward. Microsoft product branding / marketplace restrictions still apply. | **Clean.** Your extension, your license. VS Code is the host. You may ship a proprietary extension on top of MIT VS Code. | **EPL-2.0** (some implications for embedded / commercial redistribution — needs a lawyer read if we go this route). | **Clean (MIT for Monaco).** You own everything else. |
| **Time-to-first-demo** | **SLOW.** 3-4 weeks just to get a buildable, launchable editor with the agent panel wired in. Native module compilation, product config, splash screen, branding pass. | **FAST.** Days, not weeks. Use `vscode-extension-cli` scaffolding. Ship a working Plan→Approve→Execute→Verify panel inside stock VS Code in under 1 week. Per D-010 (timeline pressure), this is decisive. | **SLOW.** Theia setup is notoriously complex. Build times are long. Documentation is thinner than VS Code's. | **SLOWEST.** Building a usable IDE shell from scratch is months of work before the agent loop even has a home. |
| **Fit against MUST list (M1-M6)** | **FULL fit.** Can do everything. But none of the MUSTs require fork-level access. | **FULL fit.** Extensions can: register views & commands, access file system, run terminals, store secrets in OS keychain, spawn child processes (MCP servers), make HTTP requests (LLM providers), persist state, show webviews (agent panel UI). Every MUST in `01_REQUIREMENTS.md` is implementable. The only things extensions *cannot* do are deep editor chrome changes (e.g. custom title bar, custom activity bar icons) — none of which are in MUST. | **FULL fit, technically.** Overkill — Theia makes sense for cloud-hosted IDEs or deeply customized IDE products, neither of which Kovix is. | **FULL fit, technically.** Insane scope creep. Kills the timeline. |
| **Reversibility** | **LOW.** Once you ship a fork, users have Kovix-the-editor installed. Going from fork → extension means asking users to uninstall Kovix and install VS Code + the extension. Painful. | **HIGH.** Extension → fork is feasible later if you discover a hard need for fork-level access (e.g. custom editor chrome that extensions genuinely can't do). You keep the agent core code either way. | **MEDIUM.** Theia → extension is a rewrite; Theia → fork is also a rewrite. Lock-in is real. | **LOW.** You've built a custom shell; throwing it away is throwing away months of work. |

---

## The decisive evidence: agent-core coupling audit

This is the question that determines whether (B) is actually viable or just looks good on paper. I inspected the actual code in Kovix_2.0 to answer it.

**Finding: The agent core is "VS Code-shaped" but NOT deeply coupled to VS Code internals.**

What I checked:

1. **The concrete `AgentLoopService`** (`src/vs/workbench/contrib/construct/browser/services/agent/agentLoop.ts`, 1,946 lines) imports VS Code platform services via deep relative paths (`../../../../../../platform/...`). The services it imports are: `ILogService`, `IWorkspaceContextService`, `ICommandService`, `IFileService`, `IDialogService`, plus VS Code base utilities (`Emitter`, `Disposable`, `URI`, `Severity`).

2. **Every one of those services has a direct equivalent in the public `vscode` extension API**:
   - `ILogService` → `vscode.window.createOutputChannel()`
   - `IWorkspaceContextService` → `vscode.workspace.workspaceFolders`
   - `ICommandService` → `vscode.commands.executeCommand()`
   - `IFileService` → `vscode.workspace.fs`
   - `IDialogService` → `vscode.window.showErrorMessage()` + buttons
   - `Emitter` / `Disposable` / `URI` → `vscode.EventEmitter` / `vscode.Disposable` / `vscode.Uri`

3. **The DI pattern (`createDecorator`)** is VS Code's internal DI. Extensions don't use this — they use explicit instantiation. This is a **pattern translation**, not deep coupling. The code is structurally DI-heavy but functionally does what extensions do.

4. **`construct.contribution.ts` (2,388 lines)** is the central wiring file. In a fork, it registers singletons, views, commands, configurations, and contributions with the workbench. In an extension, this becomes `activate()` in `extension.ts` — same calls, different API surface (`registerCommand`, `registerWebviewViewProvider`, `registerConfiguration`).

5. **The pure-logic layer** (`src/vs/platform/construct/common/...`) — types, interfaces, state machines, helpers, sanitizers, the milestone executor — has **zero VS Code imports beyond `createDecorator` and `Event`**. These port with essentially no changes.

6. **`extensions/kovix-security-tools/extension.ts` is ALREADY a proper public-API extension** — it imports only `vscode`, nothing internal. (Note: per D-008, security tools are deferred out of v1 entirely. But this confirms the extension pattern is already proven in the old repo.)

**Conclusion:** The port from fork-shaped code to extension-shaped code is mechanical translation work, not deep rewrite. Estimated 2-4 days for the DI pattern translation across the agent core, plus 1-2 days for the contribution.ts → activate() conversion. The pure-logic layer (the bulk of the lines) ports with zero changes.

---

## Why not (A), (C), or (D)

**(A) VS Code fork — rejected.** The original justification (full IDE control, can deeply retheme, agent panel as first-class citizen) does not hold up against the MUST list. None of M1-M6 require fork-level access. The maintenance cost (weekly rebases against ~8,000 inherited files) is a permanent tax that compounds over the life of the product. Under D-010's timeline pressure, this is the wrong trade.

**(C) Theia — rejected.** Theia is the right choice when you're building a cloud-hosted IDE or a deeply customized IDE product (e.g. Gitpod, Eclipse Che). Kovix is neither. It's a desktop AI agent that needs an editor host. Theia's added flexibility is unused; its added complexity is paid for in full.

**(D) Electron + Monaco — rejected.** Building a custom IDE shell is months of work for zero product differentiation. The editor is not the differentiator; the agent loop is. This is the worst option by every measure.

---

## Recommendation

**Switch the base architecture from "VS Code fork" (D-004 default) to "VS Code extension" (option B).**

This means:
- `fresh` is a VS Code extension project, not a Code-OSS fork.
- Users install stock VS Code (or VS Code Insiders), then install the Kovix extension from the marketplace (or a `.vsix` file).
- The agent panel ships as a webview; commands ship as `vscode.commands.registerCommand`; configuration ships via `contributes.configuration`; LLM/MCP/memory/terminal all use the public `vscode` API.
- The `01_REQUIREMENTS.md` M1 ("VS Code / Code-OSS fork as base") is rewritten as M1 ("VS Code extension as base"). All other MUST items stay.
- Estimated effort to first demoable v1.0-alpha: **3-5 days** (vs. 3-4 weeks for the fork route).

This overrides D-004. A new decision entry (D-011) will be logged once the user signs off, formally replacing D-004's "VS Code fork" default.

---

## What I need from the user

**One question, one round-trip:**

> Do you approve switching the base architecture from "VS Code fork" to "VS Code extension"?
>
> - **YES** → I proceed immediately to write `docs/02_ARCHITECTURE.md` with the extension as base. Updates `01_REQUIREMENTS.md` M1 accordingly. Logs D-011.
> - **NO, stay with fork** → I proceed with the fork route as D-004 originally specified. Accept the 3-4 week delay to first demo and the ongoing maintenance burden.
> - **NO, pick a different option (C or D)** → I write a deeper analysis of that specific option before proceeding. Adds ~1 day.
>
> Per the project lead's instruction: this is the one round-trip on the architecture choice. After sign-off, Phase 2 proceeds without further architecture stalls.
