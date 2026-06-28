# Kovix

![Status](https://img.shields.io/badge/status-v0.1--alpha-blue)
![License](https://img.shields.io/badge/license-MIT-green)

A standalone Electron desktop app that runs an autonomous AI agent in a chat
interface — it can read, write, edit, and run files in your workspace, but
only after you approve each plan.

The core idea is the **Plan → Approve → Execute → Verify** loop: the agent
proposes a plan, you approve (or reject) it, the agent executes one milestone
at a time, and each milestone's output is verified before the next one runs.
You can pause, skip, or abort at any milestone boundary.

> **Project status: v0.1-alpha.** This is an early preview. It works end-to-end
> for the basic task loop described below, but several features advertised in
> the configuration surface (memory, MCP) are scaffolded-but-not-yet-wired and
> will land in v1.0-beta. See [Project Status](#project-status).

---

## What works today

- **Standalone Electron app.** Launch Kovix as its own desktop application — no
  VS Code, no extension host, no `.vsix`. The app opens a chat window with a
  built-in renderer (plain HTML/CSS/JS) that communicates with the main process
  via Electron IPC.
- **Plan → Approve → Execute → Verify agent loop.** Send a task in natural
  language, get back a structured plan, approve it, watch it execute one
  milestone at a time with verification between milestones. Two interaction
  modes: **Chat** (freeform conversation) and **Plan** (structured task
  automation).
- **8 built-in tools**, each security-hardened:
  - `readFile` — read workspace files (path-traversal protected)
  - `writeFile` — create or overwrite files (workspace-boundary enforced)
  - `editFile` — surgical string replacement in existing files
  - `listDirectory` — enumerate workspace contents
  - `runCommand` — execute shell commands (no-shell `spawn` only, blocklist
    enforced, shell-metachar detection, env sanitisation)
  - `searchCode` — ripgrep-based content search
  - `webFetch` — fetch external URLs (SSRF-defended: blocks private ranges,
    cloud metadata, link-local)
  - `index` — workspace indexing for context-aware retrieval
- **3 LLM providers**:
  - **Anthropic** (Claude) — direct API access
  - **NVIDIA NIM** — free-tier access (1,000 credits/day at
    [build.nvidia.com](https://build.nvidia.com))
  - **OpenRouter** — multi-model gateway (Claude, GPT-4o, Gemini, Llama, and
    more via [openrouter.ai](https://openrouter.ai))
  API keys are stored using Electron's `safeStorage` encryption — never written
  to disk in plaintext.
- **Agent chat UI** with streaming token display, provider/model selectors,
  pending-changes bar with Accept All / Reject All, and auto-growing input.
- **Four autonomy modes**: every-milestone pause, major-milestone pause,
  selective (user picks which milestones to pause at), full-auto.
- **Security invariants enforced mechanically** (not just by code review):
  - `SEC-1` credentials encrypted via Electron `safeStorage`, never plaintext
  - `SEC-3` no shell execution — `spawn()` only, with command blocklist
  - `SEC-4` workspace path-traversal defence on all file tools
  - `SEC-6` prompt-injection filtering on all tool outputs returned to the LLM
  - `SEC-7` secret redaction (Anthropic/OpenAI/NVIDIA/GitHub/etc.) + SSRF URL
    defence
  - `SEC-9` child-process env sanitisation (strips `NODE_OPTIONS`,
    `LD_PRELOAD`, `PYTHONPATH`, etc.)
  - `no-eval` / `no-new-func` / `no child_process.exec` enforced by ESLint

---

## What's planned (not in v0.1-alpha)

- **v1.0-beta — Semantic memory.** Recall context from prior tasks using
  local embeddings (Ollama + `hnswlib-node`). The embedding service
  (`src/memory/embeddingService.ts`) and vector store
  (`src/memory/vectorStore.ts`) exist today but no agent-path consumer is
  wired yet.
- **v1.0-beta — MCP server host.** Connect external Model Context Protocol
  servers (stdio transport) and surface their tools alongside the 8 built-ins.
  The `McpManager` and `McpClient` exist today; server configuration and
  tool registration are functional but not yet exposed in the UI.
- **v1.1 — Multi-agent swarm.** Multiple agents working in parallel with
  role dispatch and conflict resolution. Design doc pending.

---

## Architecture

```
kovix/
├── electron/              # Electron shell
│   ├── main.ts            # Main process: app lifecycle, IPC handlers, service init
│   └── preload.ts         # Context-isolation bridge (ipcRenderer → renderer)
├── renderer/              # Chat UI (plain HTML/CSS/JS)
│   ├── index.html         # Main window layout
│   └── chat/
│       ├── chat.js        # UI logic, IPC client, event rendering
│       └── chat.css       # Styling
├── src/                   # Core modules (framework-agnostic)
│   ├── agent/             # Agent loop, milestones, verification, prompts
│   ├── llm/               # AI service + providers (Anthropic, NVIDIA NIM, OpenRouter)
│   ├── mcp/               # MCP client, manager, types (stdio transport)
│   ├── memory/            # Embedding service, vector store, memory service
│   ├── security/          # Workspace guard, prompt sanitiser, secret redaction,
│   │                      # URL guard, child-env sanitiser
│   ├── tools/             # Tool registry + 8 built-in tools
│   ├── terminal/          # Command executor, blocklist
│   ├── diff/              # Pending changes service
│   ├── platform/          # App state, config, secrets, URIs, prompts (Electron shim)
│   ├── types/             # Shared TypeScript interfaces
│   └── util/              # Logger
├── scripts/               # Build, test, smoke-test scripts
└── docs/                  # Architecture, requirements, decisions, design system
```

All core modules under `src/` are framework-agnostic — they use platform
interfaces (`IFileSystem`, `ISecretStorage`, `IWorkspace`) rather than
Electron APIs directly. The `src/platform/` directory provides the Electron
implementations of those interfaces.

---

## Install

### From source (current — v0.1-alpha)

**Prerequisites:** Node.js ≥ 18, npm, [Ollama](https://ollama.ai) (optional,
for semantic memory).

```bash
git clone https://github.com/Razisafir/fresh.git
cd fresh
npm install
npm start
```

`npm start` compiles TypeScript and launches the Electron app. The first time
you run it, you'll be prompted to enter an API key for your chosen provider.

### Pre-built binaries (later)

Not yet available. Will ship as DMG (macOS), NSIS installer (Windows), and
AppImage (Linux) once v1.0 ships. The `electron-builder` config is already in
`package.json`.

---

## Quick start

1. **Install and launch** Kovix (see above).
2. **Set your API key.** On first launch, the API key modal appears. Choose a
   provider and paste your key:
   - **Anthropic** — `sk-ant-…` from
     [console.anthropic.com](https://console.anthropic.com)
   - **NVIDIA NIM** — `nvapi-…` from
     [build.nvidia.com](https://build.nvidia.com) (free tier available)
   - **OpenRouter** — `sk-or-…` from
     [openrouter.ai/keys](https://openrouter.ai/keys)
   Your key is encrypted with Electron `safeStorage` and never touches disk in
   plaintext.
3. **Open a workspace folder.** Click the 📂 button in the header and select a
   directory. This becomes the root for all file operations.
4. **Switch to Plan mode** (click the "Plan" button in the header) and type a
   task. For example:
   > Create a file called hello.txt with the text "hi"
5. The agent will propose a plan. Review it, then click **Approve**.
6. The agent executes the plan one milestone at a time. Watch the tool-call
   cards for what it's doing. When done, the file appears in your workspace.
7. Use **Chat mode** for freeform questions — the agent responds without
   creating a structured plan.

---

## Configuration

Open Settings (⚙️ button in the header) to manage API keys. Additional
configuration is stored in the app's user data directory and managed via the
`appState` module:

| Setting | Default | Description |
|---------|---------|-------------|
| `llm.activeProvider` | `anthropic` | LLM provider: `anthropic`, `nvidia-nim`, or `openrouter`. |
| `llm.activeModel` | _(empty)_ | Model name, e.g. `claude-sonnet-4-20250514`. |
| `autonomy.defaultMode` | `major_milestone` | When to pause for approval: `every_milestone`, `major_milestone`, `selective`, `full_auto`. |
| `autonomy.pauseOnVerificationFailure` | `true` | Always pause if a milestone's verification fails, regardless of autonomy mode. |
| `memory.embedProvider` | `ollama` | _(v1.0-beta)_ Embedding provider. `none` disables memory. |
| `memory.embedModel` | `nomic-embed-text` | _(v1.0-beta)_ Embedding model name. |
| `memory.vectorStore` | `in-process` | _(v1.0-beta)_ Vector store backend. `in-process` uses `hnswlib-node` (no Docker). |
| `mcp.servers` | `[]` | _(v1.0-beta)_ MCP server configurations. |
| `mcp.toolTimeoutMs` | `30000` | _(v1.0-beta)_ Per-tool-call timeout for MCP tools. |
| `security.allowExternalTargets` | `false` | Allow `webFetch` to hit non-allowlisted external URLs. |
| `debug.verbose` | `false` | Verbose logging to the console. |

---

## Security invariants

Kovix enforces the following security invariants mechanically — through
runtime checks, build-time lint rules, or both — not just by code review:

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| SEC-1 | Credentials encrypted at rest (Electron `safeStorage`), never plaintext | Runtime: safeStorage.encryptString / decryptString |
| SEC-3 | No shell execution — `child_process.spawn()` only, with command blocklist | Runtime: `terminalExecutor.ts` + `commandBlocklist.ts`; Build: ESLint `no-exec` rule |
| SEC-4 | Workspace path-traversal defence on all file tools | Runtime: `workspaceGuard.ts` resolves and validates all paths |
| SEC-6 | Prompt-injection filtering on all tool outputs returned to the LLM | Runtime: `promptSanitiser.ts` strips injection markers |
| SEC-7 | Secret redaction (API keys, tokens, auth headers) + SSRF URL defence | Runtime: `secretPatterns.ts` (canonical pattern registry) + `urlGuard.ts` |
| SEC-9 | Child-process env sanitisation — strips `NODE_OPTIONS`, `LD_PRELOAD`, `PYTHONPATH`, etc. | Runtime: `childEnv.ts` (allowlist + denylist) |

Additionally, the following are enforced at the **build level** via ESLint:

- **No `eval()`** — `no-eval` rule
- **No `new Function()`** — `no-new-func` rule
- **No `child_process.exec()`** — custom rule (only `spawn` allowed)

All secret-redaction patterns live in a single canonical registry
(`src/security/secretPatterns.ts`). Both the prompt-sanitiser and the
secret-redactor import from this module, closing the audit finding that the
two paths could drift.

---

## Project status

**v0.1-alpha** — feature-complete for the basic Plan → Approve → Execute →
Verify loop with the 8 built-in tools and all 3 LLM providers. The Electron
shell, IPC bridge, and renderer chat UI are functional. All automated gates
green: typecheck, lint (with security rules), compile, 279 tests, 0 npm audit
vulnerabilities. CI runs on every push (Node 20.x and 22.x matrix).

**Not yet done:** memory recall (embedding service + vector store wired into
agent loop), MCP server host (manager + client functional but not exposed in
UI), multi-agent swarm, pre-built installers for macOS/Linux/Windows. See the
roadmap in `docs/` for the full plan.

---

## Contributing

This project is currently single-maintainer. If you find a bug, please open
an issue at <https://github.com/Razisafir/fresh/issues> with:
- What you were trying to do
- What you expected
- What actually happened (paste the console output — the main process logs to
  stdout/stderr)

See `docs/10_MAINTENANCE.md` for the issue-triage convention and
`docs/09_RELEASE_CHECKLIST.md` for the release process.

---

## License

MIT. See [LICENSE.txt](./LICENSE.txt).
