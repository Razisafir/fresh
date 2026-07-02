# Kovix

![Status](https://img.shields.io/badge/status-v0.1--alpha-blue)
![License](https://img.shields.io/badge/license-MIT-green)

An AI-native desktop development environment. Kovix runs an autonomous
agent inside a three-pane IDE (file explorer + code editor + chat) that can
read, write, edit, and run files in your workspace — but only after you
approve each plan.

The core idea is the **Plan → Approve → Execute → Verify** loop: the agent
proposes a plan, you approve (or reject) it, the agent executes one milestone
at a time, and each milestone's output is verified before the next one runs.
You can pause, skip, or abort at any milestone boundary.

> **Project status: v0.1-alpha.** This is an early preview. The core
> Plan → Approve → Execute → Verify loop works end-to-end with multiple
> LLM providers. Memory recall, MCP server hosting, and some UI features
> are scaffolded and will land in v1.0-beta.

---

## What works today

- **Plan → Approve → Execute → Verify agent loop.** Send a task in natural
  language, get back a structured plan, approve it, watch it execute one
  milestone at a time with verification between milestones.
- **8 built-in tools**, each security-hardened:
  - `read_file` — read workspace files (path-traversal protected)
  - `write_file` — create or overwrite files (workspace-boundary enforced)
  - `edit_file` — surgical string replacement in existing files
  - `create_directory` — create directories (workspace-boundary enforced)
  - `list_directory` — enumerate workspace contents
  - `run_command` — execute shell commands (no-shell `spawn` only, blocklist
    enforced, shell-metachar detection, env sanitisation)
  - `search_code` — ripgrep-based content search
  - `web_fetch` — fetch external URLs (SSRF-defended)
- **11 LLM providers**: Anthropic (Claude), OpenAI, NVIDIA NIM, OpenRouter,
  Google Gemini, Mistral, Groq, DeepSeek, Ollama (local, free), LM Studio
  (local), and xAI. API keys stored in the OS keychain via Electron
  safeStorage — never written to disk in plaintext.
- **Three-pane IDE**: File explorer (left), Monaco code editor with diff
  view and pending changes (center), AI chat with streaming output
  (right). Collapsible tool-call cards, plan-approval card, milestone
  pause banner, Accept/Reject for pending changes.
- **Agent Activity Panel**: Live feed of everything the agent is doing —
  tool calls, file operations, commands, milestones, verifications.
  Clickable file paths open them in the editor. Filter by All/Important/Files.
- **Idea Refinement Pipeline**: 6-phase flow from raw idea to structured
  spec, plan, pre-flight check, execution, and completion.
  Refine → Plan → Pre-flight → Execute → Swarm → Completion.
- **Multi-agent Swarm**: Parallel agents with role dispatch and conflict
  resolution.
- **Four autonomy modes**: every-milestone pause, major-milestone pause,
  selective (user picks which milestones to pause at), full-auto.
- **Security invariants enforced mechanically**:
  - `SEC-1` credentials in OS keychain, never plaintext
  - `SEC-3` no shell execution — `spawn()` only, with command blocklist
  - `SEC-4` workspace path-traversal defence on all file tools
  - `SEC-6` prompt-injection filtering on all tool outputs
  - `SEC-7` secret redaction + SSRF URL defence
  - `SEC-9` child-process env sanitisation
  - `no-eval` / `no-new-func` / `no child_process.exec` enforced by ESLint

---

## What's planned (not in v0.1-alpha)

- **v1.0-beta — Semantic memory.** Recall context from prior tasks using
  local embeddings (Ollama + `hnswlib-node`).
- **v1.0-beta — MCP server host.** Connect external Model Context Protocol
  servers and surface their tools alongside the 8 built-ins.
- **v1.1 — Virtualized file tree.** Viewport virtualization for large
  workspaces (1000+ files).

---

## Install

### From source (current — v0.1-alpha)

```bash
git clone https://github.com/Razisafir/fresh.git
cd fresh
npm ci
npm run compile
npm run dev
```

This launches the Kovix Electron app. On first run, you'll see a welcome
card prompting you to configure an API key.

### From pre-built binary (later)

Download the installer from the
[releases page](https://github.com/Razisafir/fresh/releases).
Windows (NSIS), macOS (DMG), and Linux (AppImage) builds will be
available once v1.0 ships.

---

## Quick start

1. Launch Kovix (`npm run dev` after compiling).
2. Open a folder: **File → Open Folder** or click the folder icon in the
   chat panel.
3. Configure an API key: Click **Configure API Key** in the welcome card,
   or use **File → Manage API Keys**. Paste your key — it's stored in the
   OS keychain via Electron safeStorage.
4. Type a task in the chat input. For example:
   > Create a file called hello.txt with the text "hi"
5. The agent proposes a plan. Review it, then click **Approve**.
6. Watch the agent execute the plan in the Activity Panel (bottom of
   the editor pane). Tool calls, file writes, and verifications appear
   in real-time.
7. Files the agent writes appear as pending changes. Review them in the
   editor's diff view, then Accept or Reject.

---

## Configuration

Kovix stores configuration in `~/.kovix/kovix.config.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `workspaceRoots` | `[]` | Workspace folders. Set via File → Open Folder. |
| `llmActiveProvider` | `anthropic` | LLM provider. One of: `anthropic`, `openai`, `nvidia-nim`, `openrouter`, `gemini`, `mistral`, `groq`, `deepseek`, `ollama`, `lm-studio`, `xai`. |
| `llmActiveModel` | _(empty)_ | Model name, e.g. `claude-sonnet-4-20250514`. |
| `autonomyDefaultMode` | `major_milestone` | When to pause: `every_milestone`, `major_milestone`, `selective`, `full_auto`. |
| `autonomyPauseOnVerificationFailure` | `true` | Always pause if verification fails. |
| `debugVerbose` | `false` | Verbose logging. |

API keys are stored in the OS keychain (not in the config file).

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Toggle file explorer panel |
| `Ctrl+J` | Toggle chat panel |
| `Ctrl+Shift+I` | Open developer tools |

---

## Project status

**v0.1-alpha** — feature-complete for the core agent loop with 8 built-in
tools, 11 LLM providers, Monaco editor, file explorer, agent activity
panel, idea refinement pipeline, and swarm mode. 493 unit tests passing.
TypeScript clean.

---

## Contributing

Open an issue at <https://github.com/Razisafir/fresh/issues> with:
- What you were trying to do
- What you expected
- What actually happened (open DevTools with Ctrl+Shift+I and check the console)

---

## License

MIT. See [LICENSE.txt](./LICENSE.txt).
