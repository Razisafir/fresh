# 02_ARCHITECTURE.md — Kovix v1 Architecture

**Date:** 2026-06-27
**Author:** Rebuild lead (agent session)
**Audience:** Project owner (non-engineer) + future contributors
**Status:** Phase 2 deliverable. Locked pending Phase 2 gate sign-off.
**Decisions referenced:** D-001 (file-by-file audit), D-002 (Windows first), D-003 (medium involvement), D-007 (Phase 1 requirements locked), D-008 (M8 dropped), D-009 (M7 deferred), D-010 (timeline pressure soft-but-real), **D-011 (base architecture = VS Code extension, supersedes D-004)**.

> **TL;DR:** `fresh` is a VS Code extension (per D-011), not a Code-OSS fork. This doc defines the module boundaries, folder structure, file mapping from Kovix_2.0, and the concrete definition of "done" for v0.1 (alpha) through v1.0. Phase 3 (Migration) will execute the mapping table in §6 with per-file audits per D-001.

---

## 1. Architecture choice (locked per D-011)

**Kovix v1 is a VS Code extension.** Users install stock VS Code (or VS Code Insiders), then install Kovix as a `.vsix` (from marketplace or direct download). The extension provides:

- A webview-based agent chat panel (right side, like Cursor's composer)
- Commands (`Kovix: ...`) for settings, modes, indexing, etc.
- Configuration contributions (`kovix.*` settings namespace)
- A local HTTP/stdio MCP server host for connecting external MCP servers
- Background services (file watcher, embedding service, vector store)

**What this is NOT:**
- NOT a fork of VS Code / Code-OSS. No upstream rebases, no inherited source tree, no native module compilation.
- NOT a standalone Electron app. We do not ship a custom editor shell.
- NOT a Theia plugin. We use VS Code's extension API directly.

**Why this is the right choice (summary — see `02a_ARCH_CHOICE_MATRIX.md` for the full matrix):** every MUST feature in M1-M6 is implementable with the public `vscode` extension API. The agent core in Kovix_2.0 is VS Code-shaped but not deeply coupled to VS Code internals — the port is mechanical translation, not deep rewrite. Time-to-first-demo drops from 3-4 weeks (fork route) to 3-5 days (extension route).

---

## 2. High-level module diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                        │
│  (provided by user's VS Code install — we don't ship this)       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │  public `vscode` API only
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│                       fresh (Kovix extension)                    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  4. Entry layer    extension.ts activate() / deactivate  │   │
│  │                     command + config + view registrations │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌────────────────────────────┴─────────────────────────────┐   │
│  │  3. UI layer        Webview providers (React or vanilla)  │   │
│  │                     agentPanel, controlCenter, memory     │   │
│  │                     browser, memoryGraph, modeEditor      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌────────────────────────────┴─────────────────────────────┐   │
│  │  2. Service layer   vscode-API-consuming singletons      │   │
│  │                     agentLoop, llm providers, tool reg,   │   │
│  │                     mcp manager, memory services,         │   │
│  │                     terminal, file watcher, secure keys,  │   │
│  │                     session, recovery, snapshot, diff     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌────────────────────────────┴─────────────────────────────┐   │
│  │  1. Pure-logic layer   types, interfaces, state machines, │   │
│  │                       sanitizers, helpers, prompt builder │   │
│  │                       (zero vscode imports beyond Event)  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Layering rules:**
- Lower layers MUST NOT import from higher layers.
- Layer 1 has zero `vscode` imports beyond `Event` / `Disposable` (and these only where needed for type compatibility). This is the layer that ports from Kovix_2.0 with essentially zero changes.
- Layer 2 imports `vscode` and Layer 1. Each service is a singleton obtained via a `getService()` factory function — no DI container (we don't need VS Code's `createDecorator` pattern in an extension).
- Layer 3 imports `vscode` (for `WebviewViewProvider`) and Layer 2 services.
- Layer 4 (entry) imports everything; this is where wiring happens.

---

## 3. Folder structure for `fresh`

```
fresh/
├── .github/                    CI workflows (Phase 6)
├── .vscode/                    launch configs, recommended extensions
├── docs/                       ← we are here
│   ├── 00_OLD_REPO_STATE.md
│   ├── 00_FILE_SUMMARIES.md
│   ├── 01_REQUIREMENTS.md
│   ├── 02_ARCHITECTURE.md      ← this file
│   ├── 02a_ARCH_CHOICE_MATRIX.md
│   ├── 03_MIGRATION_LOG.md     ← Phase 3 (per-file audit entries)
│   ├── 05_TEST_PLAN.md         ← Phase 5
│   ├── 07_MAINTENANCE.md       ← Phase 7
│   └── DECISIONS.md
├── src/
│   ├── extension.ts            Layer 4: activate(), deactivate(), command registrations
│   ├── commands.ts             Layer 4: command handler registrations (Kovix: ...)
│   ├── configuration.ts        Layer 4: kovix.* config schema
│   ├── types/                  Layer 1: shared types (no impl)
│   │   ├── agent.ts            IAgentLoop, AgentLoopEvent, IPlanResult, IPlanStep, IApprovedPlan, IMilestone, ExecutionState
│   │   ├── llm.ts              IConstructAIProvider, IChatMessage, IToolDefinition, IToolCall
│   │   ├── memory.ts           IUniversalMemoryService, IEmbeddingService, IVectorStore, MemoryRecord, RetrievalResult
│   │   ├── mcp.ts              IMCPProcess, IMCPServerManager, MCPServerConfig
│   │   ├── tools.ts            ITool, IToolResult, IConstructToolRegistry
│   │   ├── modes.ts            AgentMode, ModeDefinition
│   │   ├── session.ts          ISession, SessionEvent
│   │   └── config.ts           KovixConfig, AutonomyConfig, MemoryConfig
│   ├── agent/                  Layer 1+2: agent core (the crown jewel)
│   │   ├── agentLoop.ts        Layer 2: AgentLoopService (port from Kovix_2.0 with mechanical translation)
│   │   ├── milestoneStateMachine.ts  Layer 1: ExecutionState enum + IApprovedPlan/IMilestone (port verbatim)
│   │   ├── milestoneExecutor.ts      Layer 1: executeMilestonesWithPauses() helper (port verbatim)
│   │   ├── agentLoopHelpers.ts       Layer 1: mapToolToActionType, checkCostGate, applyCommandSanity, consumeCreditsForToolCall (port verbatim)
│   │   ├── executionMode.ts          Layer 1: ExecutionMode enum + configs (port verbatim)
│   │   ├── loadingState.ts           Layer 1: LoadingState type, FileChangeEntry (port verbatim)
│   │   ├── ideaRefinementService.ts  Layer 2: pre-planning Q&A (port with translation)
│   │   ├── agentModeService.ts       Layer 2: 6 built-in modes + custom mode CRUD (port with translation)
│   │   ├── promptBuilder.ts          Layer 1: system prompt assembly (port verbatim)
│   │   └── verification.ts           Layer 2: runs npm test / npm run build / npx tsc --noEmit, parses output
│   ├── llm/                    Layer 1+2: multi-provider LLM
│   │   ├── constructAIProvider.ts    Layer 1: IConstructAIProvider interface (port verbatim)
│   │   ├── constructAIService.ts     Layer 2: provider selection + retry + streaming (port with translation)
│   │   └── providers/
│   │       ├── anthropic.ts          Layer 2: Anthropic Claude
│   │       ├── openai.ts             Layer 2: OpenAI + OpenAI-compatible (NVIDIA NIM, Together, Groq, Mistral, DeepSeek, LiteLLM)
│   │       ├── openrouter.ts         Layer 2: OpenRouter
│   │       ├── gemini.ts             Layer 2: Google Gemini
│   │       ├── ollama.ts             Layer 2: local Ollama (default for offline)
│   │       ├── lmStudio.ts           Layer 2: local LM Studio
│   │       └── custom.ts             Layer 2: user-defined endpoint
│   ├── tools/                  Layer 1+2: tool registry + built-in tools
│   │   ├── constructToolRegistry.ts  Layer 1: IConstructToolRegistry interface (port verbatim)
│   │   ├── toolRegistryService.ts    Layer 2: registry singleton (port with translation)
│   │   └── builtin/
│   │       ├── readFile.ts           Layer 2: read_file tool (uses vscode.workspace.fs)
│   │       ├── writeFile.ts          Layer 2: write_file tool
│   │       ├── listDirectory.ts      Layer 2: list_directory tool
│   │       ├── editFile.ts           Layer 2: edit_file tool (uses diffApplier)
│   │       ├── runCommand.ts         Layer 2: run_command tool (uses terminalExecutor)
│   │       ├── searchCode.ts         Layer 2: search_code tool (ripgrep via child_process)
│   │       └── webFetch.ts           Layer 2: web_fetch tool (HTTP via node fetch)
│   ├── mcp/                    Layer 1+2: Model Context Protocol
│   │   ├── mcpTypes.ts               Layer 1: MCPServerConfig, MCPTool (port verbatim)
│   │   ├── mcpProcess.ts             Layer 2: stdio/SSE MCP client (port with translation)
│   │   ├── mcpServerManager.ts       Layer 2: server lifecycle + tool discovery (port with translation)
│   │   ├── mcpConnectionPool.ts      Layer 2: connection reuse (port with translation)
│   │   └── mcpMarketplace.ts         Layer 2: optional server catalog (port with translation)
│   ├── memory/                 Layer 1+2: semantic memory
│   │   ├── universalMemoryTypes.ts   Layer 1: MemoryRecord, RetrievalResult (port verbatim)
│   │   ├── universalMemoryService.ts Layer 2: workspace indexing + retrieval (port WITH BUG FIX per M6)
│   │   ├── embeddingService.ts       Layer 2: Ollama nomic-embed-text default (port with translation)
│   │   ├── vectorStore.ts            Layer 2: Qdrant client (port with translation)
│   │   ├── constructMemory.ts        Layer 1: IConstructMemoryService interface (port verbatim)
│   │   ├── constructMemoryService.ts Layer 2: Supermemory API (port WITH BUG FIX: route key through SecretStorage)
│   │   ├── memoryPrivacy.ts          Layer 1: privacy filters (port verbatim)
│   │   ├── autoExtractContext.ts     Layer 2: learning from conversations (port with translation)
│   │   └── bm25Fallback.ts           Layer 1: keyword fallback when embeddings unavailable (port verbatim)
│   ├── security/               Layer 1: defense-in-depth (pure logic, port verbatim)
│   │   ├── promptSanitiser.ts        SEC-6: prompt injection defense
│   │   ├── secretRedactor.ts         SEC-7: secret redaction from tool output
│   │   ├── workspaceGuard.ts         SEC-4: path traversal protection (assertWithinWorkspace)
│   │   ├── urlGuard.ts               URL allowlist/blocklist
│   │   ├── secretPatterns.ts         regex catalog for known secret formats
│   │   ├── childEnv.ts               child process env sanitization
│   │   └── secureKeyManager.ts       Layer 2: API key storage via vscode.SecretStorage
│   ├── terminal/               Layer 2: terminal execution
│   │   ├── terminalExecutor.ts       ITerminalExecutor impl (uses vscode.tasks or child_process)
│   │   └── commandBlocklist.ts       Layer 1: blocked shell patterns (port verbatim)
│   ├── session/                Layer 1+2: agent session persistence
│   │   ├── sessionTypes.ts           Layer 1: ISession, SessionEvent (port verbatim)
│   │   └── sessionService.ts         Layer 2: session CRUD (uses vscode.workspace.globalState)
│   ├── recovery/               Layer 1+2: error recovery
│   │   ├── agentErrorRecovery.ts     Layer 1: error classifier (port verbatim)
│   │   └── agentErrorRecoveryService.ts Layer 2: retry/skip/abort policy (port with translation)
│   ├── snapshot/               Layer 2: git-based snapshots
│   │   └── snapshotManager.ts        uses git CLI via child_process for checkpoint/restore
│   ├── diff/                   Layer 1+2: pending changes
│   │   ├── pendingChanges.ts         Layer 1: IPendingChangesService interface (port verbatim)
│   │   ├── pendingChangesService.ts  Layer 2: in-memory staging (port with translation)
│   │   └── diffApplier.ts            Layer 2: applies text diffs to editor (uses vscode.workspace.fs + workspace.applyEdit)
│   ├── watcher/                Layer 2: file watcher
│   │   └── fileWatcherService.ts     uses vscode.workspace.createFileSystemWatcher
│   ├── pricing/                Layer 1+2: cost governor + credits (S1, MAYBE v1.0)
│   │   ├── pricingTypes.ts           Layer 1: ICreditSystem, ICostGovernor interfaces (port verbatim)
│   │   ├── creditSystem.ts           Layer 1: ICreditSystem interface (port verbatim)
│   │   ├── creditSystemService.ts    Layer 2: local credit ledger (port with translation)
│   │   └── executionSanity.ts        Layer 1: hallucinated-success detector (port verbatim)
│   ├── skills/                 Layer 1+2: skill registry (HARVEST_CANDIDATES P3-9)
│   │   ├── skillRegistry.ts          Layer 1: ISkillRegistry interface (port verbatim)
│   │   └── skillRegistryService.ts   Layer 2: skill loader
│   ├── project/                Layer 2: project detection
│   │   └── projectService.ts         detects workspace type (node, python, etc.) for verification command selection
│   ├── ui/                     Layer 3: webview providers
│   │   ├── agentPanel.ts             Kovix: Agent webview (right-side panel)
│   │   ├── controlCenter.ts          Kovix: Control Center webview (autonomy mode, milestones, progress)
│   │   ├── memoryBrowser.ts          Kovix: Memory Browser webview
│   │   ├── memoryGraph.ts            Kovix: Memory Graph webview (optional, MAY defer to v1.0-rc)
│   │   ├── modeEditor.ts             Kovix: Mode Editor webview (custom mode CRUD)
│   │   ├── apiSettings.ts            Kovix: API Keys webview
│   │   ├── onboarding.ts             Kovix: Welcome webview (first-launch)
│   │   └── webview/
│   │       ├── agentPanel.html       webview HTML shells
│   │       ├── agentPanel.js         webview JS (uses vscode.postMessage API)
│   │       ├── agentPanel.css
│   │       └── ... (one set per panel)
│   ├── services.ts             Layer 4: service registry — exports getService<T>() factory
│   └── util/
│       ├── logger.ts           wraps vscode.OutputChannel
│       ├── uri.ts              URI helpers (wraps vscode.Uri)
│       └── event.ts            EventEmitter wrapper
├── test/                       Phase 5
│   ├── unit/                   unit tests (jest or mocha)
│   ├── integration/            integration tests (@vscode/test-electron)
│   └── e2e/                    end-to-end tests (playwright)
├── media/                      extension icons, splash images
├── webview-ui/                 (optional, if we use React) — prebuilt webview assets
├── .gitignore
├── .gitleaksignore             suppressions for known-safe test fixtures
├── .editorconfig
├── CHANGELOG.md
├── LICENSE.txt                 proprietary (per old repo) or MIT — D-014 decision needed
├── NOTICE.md                   third-party attributions
├── README.md                   user-facing readme (NO mention of nmap/ghidra/nuclei per D-008)
├── SECURITY.md
├── package.json                extension manifest (contributes: commands, views, config, activation events)
├── package-lock.json
├── tsconfig.json
├── webpack.config.js           (if we bundle — recommended for v1)
└── esbuild.config.js           (alternative to webpack — faster)
```

**Key design choices in the folder layout:**

1. **Pure-logic / service / UI / entry layering is explicit in the path.** Files in `src/types/` and the lower half of `src/agent/`, `src/llm/`, `src/tools/`, `src/security/`, `src/memory/` are pure logic. Files in `src/<module>/*Service.ts` or with vscode-API consumers are service layer. Files in `src/ui/` are UI layer. `src/extension.ts` + `src/commands.ts` + `src/configuration.ts` + `src/services.ts` are entry layer.

2. **No DI container.** Extensions don't need VS Code's `createDecorator` pattern. Each service is a singleton obtained via `getService('<name>')`. The `services.ts` file is a simple registry: lazy-init function per service name, returns the same instance on subsequent calls. This is the mechanical replacement for `createDecorator` from Kovix_2.0.

3. **Built-in tools live under `src/tools/builtin/`.** MCP tools are discovered dynamically from connected MCP servers and dispatched as `serverName__toolName` — same convention as old repo.

4. **Webview HTML/JS/CSS lives under `src/ui/webview/`.** Each panel has its own HTML shell + JS bundle + CSS. The JS uses `vscode.postMessage` to talk to the extension host. We can start with vanilla JS for v0.1 (fastest path per D-010) and migrate to React later if UI complexity warrants.

5. **Tests are separate from source.** `test/unit/` runs in node; `test/integration/` runs via `@vscode/test-electron` (downloads a real VS Code instance for testing); `test/e2e/` uses Playwright against a VS Code instance.

6. **The `package.json` is the extension manifest.** This is the single most important file in the extension — it declares commands, views, configuration schema, activation events. This replaces the role of `construct.contribution.ts` (2,388 lines) in the old repo.

---

## 4. Module-by-module breakdown

### 4.1 Agent core (M3 — the crown jewel)

**Role:** Implements Plan → Approve → Execute → Verify. The single most important module in the extension.

**Key files:**
- `src/types/agent.ts` — types (ExecutionState, IApprovedPlan, IMilestone, AgentLoopEvent, IPlanResult, IPlanStep) — port verbatim from `src/vs/platform/construct/common/agent/agentLoop.ts` + `milestoneStateMachine.ts` + `loadingState.ts`
- `src/agent/agentLoop.ts` — `AgentLoopService` (the 1,946-line concrete impl). **Port with mechanical translation**: replace `IXxxService` DI imports with `getService('xxx')` calls; replace VS Code internal utilities (`Emitter`, `Disposable`, `URI`) with their `vscode` API equivalents (`vscode.EventEmitter`, `vscode.Disposable`, `vscode.Uri`); replace `IDialogService` calls with `vscode.window.showErrorMessage()` + buttons.
- `src/agent/milestoneExecutor.ts` — `executeMilestonesWithPauses()` helper. **Port verbatim** — pure logic, no VS Code imports.
- `src/agent/agentLoopHelpers.ts` — `mapToolToActionType`, `checkCostGate`, `applyCommandSanity`, `consumeCreditsForToolCall`. **Port verbatim** — pure logic.
- `src/agent/executionMode.ts` — `ExecutionMode` enum (EveryMilestone, MajorMilestone, Selective, FullAuto) + configs. **Port verbatim**.
- `src/agent/promptBuilder.ts` — system prompt assembly with prompt sanitiser + memory context injection. **Port verbatim** (calls into security/ and memory/, both pure logic).
- `src/agent/verification.ts` — runs actual `npm test` / `npm run build` / `npx tsc --noEmit`, parses output, returns pass/fail + output. **New file** — old repo had this inline in agentLoop.ts; we extract it for testability.

**Known bugs to fix during port (per M3 success criteria):**
- `shouldPauseAt()` missing branch for `'major_milestone'` — MajorMilestone silently behaves like FullAuto. Fix: add the missing branch.
- `skipCurrentMilestone()` identical to `resumeFromMilestone()` — Skip button is a lie. Fix: harvest from `fix/skip-milestone-real-semantics` branch in Kovix_2.0 (per HARVEST_CANDIDATES P1-2).

**Dependencies:** LLM service (`src/llm/`), tool registry (`src/tools/`), MCP manager (`src/mcp/`), memory services (`src/memory/`), security (`src/security/`), terminal (`src/terminal/`), recovery (`src/recovery/`), snapshot (`src/snapshot/`), pending changes (`src/diff/`), session (`src/session/`), file watcher (`src/watcher/`), pricing (`src/pricing/` — optional in v0.1).

### 4.2 LLM provider layer (M2)

**Role:** 13 providers (Anthropic, OpenAI, NVIDIA NIM, OpenRouter, LM Studio, Together, Groq, Mistral, Gemini, DeepSeek, Ollama, LiteLLM, Custom). All configured via user-owned API keys stored in OS keychain via `vscode.SecretStorage`.

**Key files:**
- `src/types/llm.ts` — `IConstructAIProvider`, `IChatMessage`, `IToolDefinition`, `IToolCall`. **Port verbatim**.
- `src/llm/constructAIService.ts` — provider selection (by active mode + model routing), retry with exponential backoff, streaming. **Port with translation**.
- `src/llm/providers/*.ts` — one file per provider. **Port with translation** (replace HTTP layer if old repo used VS Code internals — node `fetch` is fine).

**Key design decision: model routing by purpose.** Per HARVEST_CANDIDATES P1-4, the old repo uses the same active model for every operation (wasteful — strong models for planning, cheap fast models for execution). We port the `ModelPurpose` type (autocomplete / inline-edit / agent-plan / agent-execute / chat / embedding) and routing function. Pure-logic file, zero VS Code imports, fully unit-testable.

### 4.3 Tool execution layer (M3 support)

**Role:** The agent's hands. Built-in tools + dynamic MCP tools.

**Built-in tools (v1.0):**
- `read_file`, `write_file`, `list_directory`, `edit_file` (uses diffApplier)
- `run_command` (uses terminalExecutor with command blocklist)
- `search_code` (ripgrep via child_process — bundled binary per platform)
- `web_fetch` (HTTP via node fetch, with URL guard)

**Key files:**
- `src/types/tools.ts` — `ITool`, `IToolResult`, `IConstructToolRegistry`. **Port verbatim**.
- `src/tools/toolRegistryService.ts` — registry singleton. **Port with translation**.
- `src/tools/builtin/*.ts` — one file per tool. **Mostly new** — old repo had these scattered; we consolidate.

**Not in v1:** Security tools (nmap/ghidra/nuclei) per D-008.

### 4.4 MCP (M5)

**Role:** Connect external MCP servers (e.g. Agent Reach for web research), dispatch their tools as `serverName__toolName`, 30-second timeout per tool call.

**Key files:**
- `src/types/mcp.ts` — `MCPServerConfig`, `MCPTool`, `IMCPProcess`, `IMCPServerManager`. **Port verbatim**.
- `src/mcp/mcpProcess.ts` — stdio + SSE client. **Port with translation**.
- `src/mcp/mcpServerManager.ts` — server lifecycle, tool discovery on connect. **Port with translation**.
- `src/mcp/mcpConnectionPool.ts` — connection reuse. **Port with translation**.
- `src/mcp/mcpMarketplace.ts` — optional catalog. **Port with translation** (note: old repo's marketplace reviews were stubbed per STUB_AUDIT M-1; we leave reviews empty or omit the feature).

### 4.5 Semantic memory (M6)

**Role:** Workspace indexing → file chunking → embeddings (Ollama `nomic-embed-text` default) → Qdrant vector store + BM25 keyword fallback → relevant chunks auto-injected into agent context. Four layers: working / episodic / semantic / procedural.

**Key files:**
- `src/types/memory.ts` — `MemoryRecord`, `RetrievalResult`, `IUniversalMemoryService`, `IEmbeddingService`, `IVectorStore`. **Port verbatim**.
- `src/memory/universalMemoryService.ts` — workspace indexing + retrieval. **Port WITH BUG FIX**: inject `IEmbeddingService`, compute cosine similarity, merge with keyword scores (hybrid retrieval). Old repo had embeddings generated but never consulted — keyword-only retrieval. This is M6's critical bug fix.
- `src/memory/embeddingService.ts` — Ollama `nomic-embed-text` default. **Port with translation**.
- `src/memory/vectorStore.ts` — Qdrant client (bundled as a child process or Docker dependency — TBD in Phase 3). **Port with translation**.
- `src/memory/constructMemoryService.ts` — Supermemory API (optional, for cloud memory). **Port WITH BUG FIX**: route API key through `vscode.SecretStorage` instead of plaintext `IStorageService`.
- `src/memory/bm25Fallback.ts` — keyword fallback. **Port verbatim** (pure logic).
- `src/memory/autoExtractContext.ts` — learning from conversations. **Port with richer-extraction variant per HARVEST_CANDIDATES P1-3**.

**Decision needed in Phase 3:** how to bundle Qdrant. Options: (a) require user to install Qdrant separately, (b) bundle as a Docker sidecar, (c) embed an in-process vector store (e.g. hnswlib-node) and skip Qdrant entirely. Option (c) is fastest for v1; (b) is closer to old repo's design. **Lead recommendation under D-010: option (c) for v1.0 — fewer moving parts, no Docker dependency, faster demo.**

### 4.6 Security (defense-in-depth, all v1)

**Role:** Six defenses, all pure logic, all ported verbatim from `src/vs/platform/construct/common/security/`:
- `promptSanitiser.ts` — SEC-6: prompt injection defense
- `secretRedactor.ts` — SEC-7: secret redaction from tool output
- `workspaceGuard.ts` — SEC-4: `assertWithinWorkspace()` path traversal protection
- `urlGuard.ts` — URL allowlist/blocklist for web_fetch
- `secretPatterns.ts` — regex catalog for known secret formats
- `childEnv.ts` — child process env sanitization (strips API keys from child env)

Plus `secureKeyManager.ts` — Layer 2: API key storage via `vscode.SecretStorage` (replaces VS Code's `ISecretStorageService`).

### 4.7 UI layer

**Role:** Webview providers for each user-facing panel.

**v0.1 (alpha) UI:** Only `agentPanel` (the chat panel). Minimal — message input, message list, "thinking" indicator.

**v1.0 UI:**
- `agentPanel.ts` — chat panel (right side, like Cursor composer)
- `controlCenter.ts` — autonomy mode picker, milestone list, progress, verification results
- `memoryBrowser.ts` — browse indexed memories
- `modeEditor.ts` — create/edit custom agent modes
- `apiSettings.ts` — manage API keys (per provider)
- `onboarding.ts` — first-launch welcome

**v1.0-rc (deferred):**
- `memoryGraph.ts` — visual memory graph (optional, lower priority than core memory)

**Tech choice for webviews:** vanilla JS for v0.1 (fastest path per D-010). Re-evaluate React migration at v1.0-beta if complexity warrants.

### 4.8 Entry layer (extension.ts, commands.ts, configuration.ts, services.ts)

**Role:** Wiring. Replaces the 2,388-line `construct.contribution.ts` from old repo.

- `extension.ts` — `activate()` and `deactivate()`. Registers all commands, view providers, configuration, event listeners.
- `commands.ts` — command handler table. Each `Kovix: ...` command has a registered handler.
- `configuration.ts` — `kovix.*` configuration schema (declared in `package.json` `contributes.configuration`).
- `services.ts` — service registry. `getService('<name>')` lazy-initializes and returns singletons.

**Key commands (v0.1 minimum set):**
- `kovix.openAgentPanel` — opens the agent chat panel
- `kovix.manageApiKeys` — opens API key management UI
- `kovix.setActiveMode` — quick-pick for agent mode
- `kovix.runTask` — opens input box for a task, runs the agent

**Key commands (added in v1.0-beta):**
- `kovix.approvePlan` — approves the proposed plan with chosen autonomy mode
- `kovix.pauseMilestone`, `kovix.resumeMilestone`, `kovix.skipMilestone`
- `kovix.connectMcpServer`, `kovix.disconnectMcpServer`

**Key commands (added in v1.0-rc):**
- `kovix.indexWorkspace` — kicks off workspace indexing
- `kovix.browseMemory` — opens memory browser

**Configuration schema (declared in `package.json`):**
- `kovix.llm.activeProvider` — string enum (13 providers)
- `kovix.llm.activeModel` — string (model name per provider)
- `kovix.llm.modelRouting` — object (ModelPurpose → model mapping)
- `kovix.autonomy.defaultMode` — enum (EveryMilestone / MajorMilestone / Selective / FullAuto)
- `kovix.autonomy.pauseOnVerificationFailure` — boolean, default true (always)
- `kovix.memory.embedProvider` — enum (ollama / openai / none), default ollama
- `kovix.memory.embedModel` — string, default `nomic-embed-text`
- `kovix.memory.vectorStore` — enum (in-process / qdrant), default in-process
- `kovix.mcp.servers` — array of MCPServerConfig
- `kovix.mcp.toolTimeoutMs` — number, default 30000
- `kovix.security.allowExternalTargets` — boolean, default false (URL guard)
- `kovix.cost.enabled` — boolean, default false (S1, MAYBE v1.0)
- `kovix.cost.budgetUsd` — number, default 10 (S1)
- `kovix.telemetry.enabled` — boolean, default false (we don't collect, but flag for user clarity)

---

## 5. Cross-cutting concerns

### 5.1 Logging

Single `vscode.OutputChannel` named "Kovix". All services route through `src/util/logger.ts`. Verbose mode controlled by `kovix.debug.verbose` setting. In v1.0-rc+, add a log file fallback for crash diagnosis.

### 5.2 Error handling

`src/recovery/agentErrorRecoveryService.ts` classifies errors into: retry, skip, abort. Retry has exponential backoff (max 3). Skip marks the milestone skipped and continues. Abort stops the agent loop entirely. UI surfaces the classification via the control center.

### 5.3 Configuration

All settings under `kovix.*` namespace, declared in `package.json` `contributes.configuration`. Schema in `src/types/config.ts` (TypeScript types). Validation in `src/configuration.ts`. On config change, services that depend on the changed setting re-read it (no extension restart needed for most settings).

### 5.4 Secrets

ALL API keys (LLM providers, Supermemory, MCP server auth) stored via `vscode.SecretStorage` (OS keychain). NEVER in `vscode.workspace.getConfiguration()` (plaintext) and NEVER in `globalState` (plaintext). The `secureKeyManager.ts` service is the single entry point for all secret reads/writes.

### 5.5 Activation events

Lazy activation: the extension activates on `onCommand:kovix.openAgentPanel` (or any `kovix.*` command) and on `onView:kovix.agentPanel`. We do NOT use `*` activation (slow startup, bad UX). For background indexing (v1.0-rc+), use `kovix.indexWorkspace` command — no auto-index on workspace open.

### 5.6 Bundling

Bundle with esbuild (faster than webpack, simpler config). Single `dist/extension.js` file. Webview assets copied to `dist/webview/`. This keeps the `.vsix` small and startup fast.

---

## 6. Folder mapping: Kovix_2.0 → fresh

This is the migration table Phase 3 will execute. Each row is one file (or file group). **Every row requires per-file audit per D-001 before migration — no bulk copy.**

| Kovix_2.0 source | fresh destination | Layer | Port strategy | Notes |
|---|---|---|---|---|
| `src/vs/platform/construct/common/agent/agentLoop.ts` (interface, 206L) | `src/types/agent.ts` | 1 | Port verbatim | Strip `createDecorator`; keep `AgentLoopEvent` and friends |
| `src/vs/platform/construct/common/agent/milestoneStateMachine.ts` | `src/types/agent.ts` | 1 | Port verbatim | Merge into same file as agent types |
| `src/vs/platform/construct/common/agent/loadingState.ts` | `src/types/agent.ts` | 1 | Port verbatim | Merge |
| `src/vs/workbench/contrib/construct/browser/services/agent/agentLoop.ts` (1,946L) | `src/agent/agentLoop.ts` | 2 | Port with translation | Replace DI imports with `getService()`; replace VS Code internals with `vscode` API |
| `src/vs/platform/construct/common/agent/milestoneExecutor.ts` | `src/agent/milestoneExecutor.ts` | 1 | Port verbatim | Pure logic |
| `src/vs/platform/construct/common/agent/agentLoopHelpers.ts` | `src/agent/agentLoopHelpers.ts` | 1 | Port verbatim | Pure logic |
| `src/vs/platform/construct/common/agent/executionMode.ts` | `src/agent/executionMode.ts` | 1 | Port verbatim | Pure logic |
| `src/vs/platform/construct/common/agent/ideaRefinementService.ts` + impl | `src/agent/ideaRefinementService.ts` | 2 | Port with translation | Pre-planning Q&A |
| `src/vs/workbench/contrib/construct/browser/services/agent/agentModeService.ts` | `src/agent/agentModeService.ts` | 2 | Port with translation | 6 built-in modes + custom mode CRUD; persists to `.kovix/modes.json` |
| `src/vs/platform/construct/common/agent/promptSanitizer.ts` + `src/vs/platform/construct/common/security/promptSanitiser.ts` | `src/agent/promptBuilder.ts` (uses `src/security/promptSanitiser.ts`) | 1 | Port verbatim | Merge prompt builder + sanitiser calls |
| `src/vs/platform/construct/common/llm/constructAIProvider.ts` | `src/types/llm.ts` | 1 | Port verbatim | Interface + types |
| `src/vs/platform/construct/common/llm/constructAIService.ts` | `src/llm/constructAIService.ts` (interface) + `src/llm/constructAIService.ts` (impl) | 1+2 | Port verbatim (interface) + port with translation (impl) | Split interface and impl |
| `src/vs/workbench/contrib/construct/browser/services/llm/cloudProvider.ts` | `src/llm/providers/{anthropic,openai,openrouter,gemini,...}.ts` | 2 | Port with translation | Old repo had a single CloudProvider handling 10 providers; we split per provider for clarity |
| `src/vs/workbench/contrib/construct/browser/services/llm/ollamaProvider.ts` | `src/llm/providers/ollama.ts` | 2 | Port with translation | Local Ollama |
| `src/vs/workbench/contrib/construct/browser/services/llm/xenovaProvider.ts` | — | — | **DROP** | Per STUB_AUDIT H-3, Xenova is unreachable on Electron desktop. v1 ships without in-process Transformers.js. Ollama covers the offline case. |
| `src/vs/platform/construct/common/tools/constructToolRegistry.ts` | `src/types/tools.ts` (interface) + `src/tools/toolRegistryService.ts` (impl) | 1+2 | Port verbatim (interface) + port with translation (impl) | |
| `src/vs/platform/construct/common/terminal/terminalExecutor.ts` (interface) | `src/terminal/terminalExecutor.ts` (interface + impl combined) | 1+2 | Port verbatim (interface) + new impl | Impl uses `vscode.tasks` or `child_process` (TBD in Phase 3) |
| `src/vs/workbench/contrib/construct/browser/services/terminal/terminalExecutor.ts` | merged into above | 2 | Merge with above | |
| `src/vs/workbench/contrib/construct/browser/services/editor/diffApplier.ts` | `src/diff/diffApplier.ts` | 2 | Port with translation | Uses `vscode.workspace.applyEdit` |
| `src/vs/workbench/contrib/construct/browser/services/diff/pendingChangesService.ts` | `src/diff/pendingChangesService.ts` | 2 | Port with translation | In-memory staging |
| `src/vs/platform/construct/common/diff/pendingChanges.ts` | `src/diff/pendingChanges.ts` (interface) | 1 | Port verbatim | |
| `src/vs/platform/construct/common/mcp/*.ts` (4 files) | `src/types/mcp.ts` (types) + `src/mcp/*.ts` (impls) | 1+2 | Port verbatim (types) + port with translation (impls) | |
| `src/vs/workbench/contrib/construct/browser/services/mcp/*.ts` (5 files) | merged into above | 2 | Port with translation | |
| `src/vs/platform/construct/common/memory/*.ts` (6 files) | `src/types/memory.ts` + `src/memory/*.ts` | 1+2 | Port verbatim (types) + port with translation (impls) | **M6 bug fix**: inject IEmbeddingService into UniversalMemoryService |
| `src/vs/workbench/contrib/construct/browser/services/memory/*.ts` (4 files) | merged into above | 2 | Port with translation | **M6 bug fix**: route Supermemory key through SecretStorage |
| `src/vs/platform/construct/common/security/*.ts` (8 files) | `src/security/*.ts` | 1 | Port verbatim | Pure logic |
| `src/vs/workbench/contrib/construct/browser/services/security/secureKeyManager.ts` | `src/security/secureKeyManager.ts` | 2 | Port with translation | Uses `vscode.SecretStorage` |
| `src/vs/platform/construct/common/snapshot/snapshotManager.ts` (interface) + impl | `src/snapshot/snapshotManager.ts` | 1+2 | Port verbatim (interface) + new impl | Impl uses git CLI via child_process |
| `src/vs/platform/construct/common/watcher/fileWatcherService.ts` (interface) + impl | `src/watcher/fileWatcherService.ts` | 1+2 | Port verbatim (interface) + new impl | Impl uses `vscode.workspace.createFileSystemWatcher` |
| `src/vs/platform/construct/common/recovery/agentErrorRecovery.ts` (interface) + impl | `src/recovery/agentErrorRecovery.ts` (interface) + `src/recovery/agentErrorRecoveryService.ts` (impl) | 1+2 | Port verbatim (interface) + port with translation (impl) | |
| `src/vs/platform/construct/common/session/constructSessionService.ts` (interface) + impl | `src/session/sessionService.ts` | 1+2 | Port verbatim (interface) + port with translation (impl) | Impl uses `vscode.workspace.globalState` |
| `src/vs/platform/construct/common/pricing/*.ts` (3 files) | `src/pricing/*.ts` | 1 | Port verbatim | **S1, MAYBE v1.0** — wire into agentLoop only if time allows |
| `src/vs/platform/construct/common/executionSanity.ts` (interface) + impl | `src/pricing/executionSanity.ts` (interface) + `src/pricing/executionSanityService.ts` (impl) | 1+2 | Port verbatim (interface) + port with translation (impl) | Hallucinated-success detector |
| `src/vs/platform/construct/common/skills/skillRegistry.ts` (interface) + impl | `src/skills/*.ts` | 1+2 | Port verbatim (interface) + port with translation (impl) | HARVEST_CANDIDATES P3-9 |
| `src/vs/platform/construct/common/project/*.ts` (2 files) | `src/project/projectService.ts` | 1+2 | Port verbatim (types) + port with translation (impl) | |
| `src/vs/platform/construct/common/notification/constructNotificationService.ts` | — | — | **DROP** | Use `vscode.window.showInformationMessage` directly; no need for a wrapper service |
| `src/vs/workbench/contrib/construct/browser/construct.contribution.ts` (2,388L) | `src/extension.ts` + `src/commands.ts` + `src/configuration.ts` + `src/services.ts` | 4 | Rewrite | This file IS the wiring; in extension form, it splits across 4 files. NOT a port — a re-expression. |
| `src/vs/workbench/contrib/construct/browser/constructAgentView.ts` (2,065L) | `src/ui/agentPanel.ts` + `src/ui/webview/agentPanel.{html,js,css}` | 3 | Rewrite | Old repo used VS Code's ViewPane + DOM APIs; we use webview + postMessage. Different paradigm. |
| `src/vs/workbench/contrib/construct/browser/kovixAgentControlCenter.ts` | `src/ui/controlCenter.ts` + webview assets | 3 | Rewrite | Same as above |
| `src/vs/workbench/contrib/construct/browser/constructMemoryView.ts` | `src/ui/memoryBrowser.ts` + webview assets | 3 | Rewrite | Same |
| `src/vs/workbench/contrib/construct/browser/kovixMemoryGraph.ts` | `src/ui/memoryGraph.ts` + webview assets | 3 | Rewrite (v1.0-rc, optional) | Same |
| `src/vs/workbench/contrib/construct/browser/constructStopModePicker.ts` | merged into `src/commands.ts` (`kovix.setAutonomyMode` handler) | 4 | Rewrite | Use `vscode.window.showQuickPick` |
| `src/vs/workbench/contrib/construct/browser/constructApiSettings.ts` + `constructApiConfig.ts` | `src/ui/apiSettings.ts` + webview assets | 3 | Rewrite | Webview-based settings UI |
| `src/vs/workbench/contrib/construct/browser/constructProjectWizard.ts` | — | — | **DEFER to v1.1** | Project wizard is not in M1-M6; can wait |
| `src/vs/workbench/contrib/construct/browser/constructOnboarding.ts` + `kovixWelcome.ts` | `src/ui/onboarding.ts` + webview assets | 3 | Rewrite (v1.0-beta+) | First-launch welcome |
| `src/vs/workbench/contrib/construct/browser/kovixSplash.ts` | — | — | **DROP** | No splash screen in extension form (VS Code shows its own splash) |
| `src/vs/workbench/contrib/construct/browser/kovixBrandChrome.ts` + `kovixSurfaceBranding.ts` | — | — | **DROP** | No custom chrome in extension form |
| `src/vs/workbench/contrib/construct/browser/kovixMenu.ts` | — | — | **DROP** | Use VS Code's menu contributions in `package.json` |
| `src/vs/workbench/contrib/construct/browser/kovixSlashDropdown.ts` | merged into `src/ui/agentPanel.ts` | 3 | Rewrite | Slash commands in webview |
| `src/vs/workbench/contrib/construct/browser/kovixAgentSettings.ts` + `kovixAutonomousConfig.ts` + `kovixSettingsMigration.ts` | `src/configuration.ts` | 4 | Rewrite | Migration logic not needed (fresh start) |
| `src/vs/workbench/contrib/construct/browser/kovixAccessibilityConfig.ts` + `kovixAccessibilityContribution.ts` | merged into `src/configuration.ts` | 4 | Rewrite | Accessibility settings declared in `package.json` |
| `src/vs/workbench/contrib/construct/browser/kovixCommandBridge.ts` | merged into `src/commands.ts` | 4 | Rewrite | Command bridge not needed in extension form |
| `src/vs/workbench/contrib/construct/browser/constructMemoryConfig.ts` | merged into `src/configuration.ts` | 4 | Rewrite | |
| `src/vs/workbench/contrib/construct/browser/constructProgressPanel.ts` | merged into `src/ui/controlCenter.ts` | 3 | Rewrite | |
| `src/vs/editor/contrib/construct/browser/kovixInlineCompletionProvider.ts` + `inlineAgent.ts` | — | — | **DEFER to v1.1** | Inline completions (Copilot-style) are not in M1-M6; can wait |
| `src/vs/workbench/contrib/construct/agentReachMcpServer.ts` | `src/mcp/builtin/agentReach.ts` | 2 | Port with translation | Built-in MCP server (web research) |
| `src/vs/workbench/contrib/construct/ponytailMcpServer.ts` | `src/mcp/builtin/ponytail.ts` | 2 | Port with translation | Built-in MCP server (lazy-dev review) |
| `src/vs/workbench/contrib/construct/uiuxProMaxMcpServer.ts` | `src/mcp/builtin/uiuxProMax.ts` | 2 | Port with translation | Built-in MCP server (UI/UX skill) |
| `src/vs/workbench/contrib/construct/browser/services/multiAgentExecutionService.ts` + `src/vs/platform/construct/common/multiAgentExecution.ts` | — | — | **DEFER to v1.1** per D-009 | Spec preserved in `01_REQUIREMENTS.md` §2 M7 |
| `extensions/kovix-security-tools/**` + `src/vs/workbench/contrib/construct/browser/tools/security/*.ts` | — | — | **DROP from v1** per D-008 | STUB_AUDIT note: "reviewed, deliberately excluded from v1 per D-008". Old repo NOT modified. |
| `src/vs/platform/construct/electron-sandbox/*.ts` + `src/vs/platform/construct/node/*.ts` | — | — | **DROP** | Process-split IPC not needed in extension form; everything runs in the extension host process |
| `test/unit/construct/**/*.test.ts` | `test/unit/**/*.test.ts` | — | Port with translation | Update imports to fresh paths |
| `package.json` (root) | `package.json` (fresh) | — | Rewrite | Extension manifest, not a Code-OSS product manifest |

**Totals:**
- Files to port verbatim (Layer 1, pure logic): ~30 files
- Files to port with mechanical translation (Layer 2, VS Code API): ~25 files
- Files to rewrite (Layer 3+4, UI and wiring): ~20 files
- Files to drop (deprecated, stubs, or not needed in extension form): ~15 files
- Files to defer to v1.1+ (swarm, inline completions, project wizard): ~5 files

---

## 7. Definition of "done" / "launchable" for v0.1 (alpha)

v0.1 = v1.0-alpha in the shipping order table. This is the first demoable artifact. Goal: prove the agent loop works end-to-end in extension form, in the simplest possible way.

**v0.1 is "done" when ALL of the following are true:**

1. **Extension scaffolds and installs.** `fresh` repo contains a valid `package.json` extension manifest. `npm install` succeeds. `npm run compile` succeeds with 0 TypeScript errors. The extension installs in VS Code via `code --install-extension kovix-0.0.1.vsix` (or F5 to launch a dev host).

2. **Agent panel opens.** Running `Kovix: Open Agent Panel` from the command palette opens a webview panel on the right side. The panel shows a message input and an empty message list.

3. **One LLM provider works end-to-end.** User can configure one provider (default: Anthropic, fallback: Ollama for local) via `Kovix: Manage API Keys`. The key is stored in `vscode.SecretStorage` (OS keychain). The agent panel can call the provider and stream a response back.

4. **Agent loop's simple `run()` path works.** User types a task in the agent panel. The agent runs the LLM in a multi-round loop with the 7 built-in tools (read_file, write_file, list_directory, edit_file, run_command, search_code, web_fetch). Tools execute against the workspace. The agent produces a final summary.

5. **One agent mode works.** The "General" mode is registered and active. The agent uses its system prompt. (Other 5 modes are not yet wired.)

6. **Security defenses are active.** `workspaceGuard`, `promptSanitiser`, `secretRedactor`, `urlGuard` are all wired into the agent loop's tool execution path. A test that tries to read `../../../etc/passwd` is blocked. A test that submits a prompt-injection payload is sanitized.

7. **Basic smoke test passes.** A test scenario: open a fresh workspace with a `hello.txt` file. Ask the agent "read hello.txt and tell me what it says." The agent calls `read_file`, gets the contents, and responds with the contents in its summary.

**v0.1 is NOT expected to have:**
- Milestone pausing / autonomy modes (that's v1.0-beta)
- Verification harness (that's v1.0-beta)
- MCP server support (that's v1.0-beta)
- Semantic memory / workspace indexing (that's v1.0-rc)
- Cost governor (S1, MAYBE v1.0)
- Custom agent modes (that's v1.0)
- Any UI beyond the basic agent panel (control center, memory browser, etc. come in v1.0-beta+)

**v0.1 demo script (3 minutes):**
1. Install VS Code Insiders (if not already installed).
2. Install the Kovix .vsix.
3. Open a fresh workspace with a couple of files.
4. Run `Kovix: Manage API Keys`, enter an Anthropic API key.
5. Run `Kovix: Open Agent Panel`.
6. Type: "Read README.md and write a one-paragraph summary to SUMMARY.md."
7. Watch the agent call `read_file`, then `write_file`, then summarize.
8. Open SUMMARY.md — it should exist with the summary.

**Estimated effort:** 3-5 days per the shipping order table.

---

## 8. Definition of "done" for v1.0 (full launch)

v1.0 is "done" when ALL success criteria in `01_REQUIREMENTS.md` §8 are met. The headline items:

1. All 6 MUST features (M1-M6) work end-to-end per spec.
2. All M3 bug fixes applied (MajorMilestone pauses correctly; Skip button skips).
3. All M6 bug fixes applied (cosine similarity on embeddings; Supermemory key in keychain).
4. All 6 built-in agent modes work; custom mode CRUD works.
5. MCP servers can be connected; tools dispatched with 30s timeout.
6. Extension installs cleanly on Windows 11 (primary), macOS, and Linux.
7. `gitleaks` CI passes; `npm audit` has 0 HIGH in production deps.
8. README and user-facing docs do NOT mention nmap / ghidra / nuclei (per D-008).

**v1.0 demo script (10 minutes):**
1. Install the extension.
2. Configure two providers (one cloud, one local Ollama).
3. Open a small TypeScript project.
4. Run `Kovix: Index Workspace` — watch indexing progress.
5. Open the agent panel. Pick "Architect" mode.
6. Type: "Add a /health endpoint to the Express server. Plan it, then ask me to approve."
7. Agent plans, presents milestones. Pick "MajorMilestone" autonomy mode. Approve.
8. Agent executes milestone-by-milestone. After each milestone, verification runs (`npx tsc --noEmit`). Watch the "Verifying" chip.
9. After completion, the agent has written `src/routes/health.ts` and added the route registration. Tests pass.
10. Open Control Center — see the milestone history, verification results, and token usage.

---

## 9. What's intentionally NOT in v1.0 architecture

These are explicit non-goals. Listing them so they don't creep back in.

- **No fork.** We do not maintain a VS Code / Code-OSS fork. (D-011)
- **No native modules.** All dependencies are pure JavaScript / TypeScript or platform-bundled binaries (ripgrep). No `node-gyp`, no `libxkbfile-dev`, no native module compilation pain.
- **No security tools.** nmap / ghidra / nuclei are not in v1, v1.1, or any v1.x. (D-008)
- **No multi-agent swarm.** Single-agent Plan→Approve→Execute→Verify only. (D-009)
- **No inline completions.** Copilot-style inline suggestions are deferred to v1.1. The agent panel is the only agent surface in v1.0.
- **No custom IDE chrome.** We use VS Code's stock title bar, activity bar, and command palette. The only UI we own is webview content.
- **No DI container.** Plain singletons via `getService()`. The old repo's `createDecorator` pattern is gone.
- **No process split.** No `electron-sandbox` / `node` / `main` separation. Everything runs in the extension host process. (This simplifies IPC dramatically.)
- **No splash screen, no brand chrome, no custom menus.** VS Code provides all of these.
- **No telemetry, ever.** Even error reporting is opt-in and local-only (per old repo's `local-only usage log` harvest candidate P1-5).
- **No payment integration.** No Stripe, no credits purchase. v1 is user-owned keys only. (W1)
- **No air-gap installer, no Kali integration.** (W2, W3)

---

## 10. Open architecture questions (to resolve in Phase 3)

These are small decisions that don't rise to "big call" level (per D-003) but need answers during migration:

1. **Terminal executor implementation.** Use `vscode.tasks` (integrated terminal, visible to user) or `child_process` (hidden, faster, no UI)? **Lead recommendation:** `child_process` for `run_command` tool (agent runs commands silently, captures output); `vscode.tasks` only for verification harness (user sees the test/build output). Resolve in Phase 3 file audit of `terminalExecutor.ts`.

2. **Vector store: in-process vs Qdrant.** Per §4.5, lead recommends in-process (`hnswlib-node`) for v1.0 to eliminate Docker dependency. Confirm during Phase 3 `vectorStore.ts` audit.

3. **Webview framework: vanilla JS vs React.** Lead recommends vanilla JS for v0.1 (fastest path per D-010); revisit at v1.0-beta if UI complexity warrants React. No decision needed now.

4. **Bundler: esbuild vs webpack.** Lead recommends esbuild (faster, simpler). No decision needed now.

5. **License for `fresh`.** Old repo is "Proprietary" but built on Code-OSS (MIT). With extension route, we don't redistribute Code-OSS, so the MIT attribution chain doesn't apply to our source. **Lead recommendation:** MIT for the extension itself (encourages community contribution, matches VS Code ecosystem norms). This is a "big call" per D-003 — will surface to user before `LICENSE.txt` is finalized. D-014 will be logged.

6. **Test framework.** Lead recommends `mocha` + `@vscode/test-electron` (the standard VS Code extension test stack). Resolve in Phase 5.

---

## 11. Phase 3 (Migration) prep

Phase 3 begins after Phase 2 gate sign-off. It will:

1. Initialize the `fresh` repo as an extension project (scaffold from `npm init -y` + `yo code` or hand-rolled `package.json`).
2. Execute the folder mapping in §6, one file at a time, in dependency order:
   - Layer 1 first (types, interfaces, state machines) — these have no dependencies and unblock everything else
   - Layer 2 next (services) — depend on Layer 1
   - Layer 3 next (UI) — depend on Layer 2
   - Layer 4 last (entry/wiring) — depends on everything
3. For each file, fill out the per-file audit template (project rules §5) and commit to `docs/03_MIGRATION_LOG.md`.
4. After each layer is complete, run a smoke test (compile + activate + basic command).
5. v0.1 (alpha) is the Phase 3 exit gate: the demo script in §7 must work end-to-end.

**Phase 3 entry criteria (all met):**
- ✅ Phase 2 architecture doc (this file) complete and signed off
- ✅ Phase 1 requirements locked (`01_REQUIREMENTS.md` v1.1 per D-008/D-009/D-010)
- ✅ Decision log current through D-011

**Phase 3 exit criteria:**
- [ ] `fresh` repo initialized as VS Code extension project
- [ ] Layer 1 files ported (per §6 mapping table)
- [ ] Layer 2 files ported
- [ ] Layer 3 files (v0.1 subset: agent panel only) ported
- [ ] Layer 4 files (entry, commands, configuration, services) ported
- [ ] v0.1 demo script (§7) passes end-to-end
- [ ] `docs/03_MIGRATION_LOG.md` populated with per-file audit entries
- [ ] `npm run compile` passes with 0 TypeScript errors
- [ ] Basic smoke test passes

---

## 12. End of Phase 2 — gate request

Phase 2 deliverables complete:
- ✅ `docs/02a_ARCH_CHOICE_MATRIX.md` (OQ-3 comparison, one page)
- ✅ `docs/02_ARCHITECTURE.md` (this file — module boundaries, folder mapping, definition of done)
- ✅ `docs/01_REQUIREMENTS.md` v1.1 (updated per D-008/D-009/D-010/D-011)
- ✅ `docs/DECISIONS.md` current through D-011

**Request to proceed to Phase 3 (Migration).** No further architecture stalls anticipated. The next user-facing checkpoint is the v0.1 demo (per §7), targeted at 3-5 days of focused work after Phase 3 begins.
