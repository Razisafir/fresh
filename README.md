# Kovix

![Status](https://img.shields.io/badge/status-v0.1--alpha-blue)
![License](https://img.shields.io/badge/license-MIT-green)

An AI-native development environment for VS Code. Kovix runs an autonomous
agent inside a chat panel that can read, write, edit, and run files in your
workspace — but only after you approve each plan.

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

- **Plan → Approve → Execute → Verify agent loop.** Send a task in natural
  language, get back a structured plan, approve it, watch it execute one
  milestone at a time with verification between milestones.
- **7 built-in tools**, each security-hardened:
  - `read_file` — read workspace files (path-traversal protected)
  - `write_file` — create or overwrite files (workspace-boundary enforced)
  - `edit_file` — surgical string replacement in existing files
  - `list_directory` — enumerate workspace contents
  - `run_command` — execute shell commands (no-shell `spawn` only, blocklist
    enforced, shell-metachar detection, env sanitisation)
  - `search_code` — ripgrep-based content search
  - `web_fetch` — fetch external URLs (SSRF-defended: blocks private ranges,
    cloud metadata, link-local)
- **Anthropic provider support** (Claude). API key stored in the OS
  keychain via VS Code's SecretStorage — never written to disk in plaintext.
- **Agent chat panel** in the activity bar. Streaming token display,
  collapsible tool-call cards, plan-approval card, milestone pause banner,
  pending-changes section with Accept/Reject/View-diff, auto-growing input
  with Stop button.
- **Four autonomy modes**: every-milestone pause, major-milestone pause,
  selective (user picks which milestones to pause at), full-auto.
- **Security invariants enforced mechanically** (not just by code review):
  - `SEC-1` credentials in OS keychain, never plaintext
  - `SEC-3` no shell execution — `spawn()` only, with command blocklist
  - `SEC-4` workspace path-traversal defence on all file tools
  - `SEC-6` prompt-injection filtering on all tool outputs returned to the LLM
  - `SEC-7` secret redaction (Anthropic/OpenAI/GitHub/etc.) + SSRF URL defence
  - `SEC-9` child-process env sanitisation (strips `NODE_OPTIONS`,
    `LD_PRELOAD`, `PYTHONPATH`, etc.)
  - `no-eval` / `no-new-func` / `no child_process.exec` enforced by ESLint

---

## What's planned (not in v0.1-alpha)

- **v1.0-beta — Semantic memory.** Recall context from prior tasks using
  local embeddings (Ollama + `hnswlib-node`). The `kovix.memory.*` settings
  exist today but no service consumes them yet.
- **v1.0-beta — MCP server host.** Connect external Model Context Protocol
  servers (stdio transport) and surface their tools alongside the 7 built-ins.
  The `kovix.mcp.servers` setting exists today but no service consumes it yet.
- **v1.1 — Multi-agent swarm.** Multiple agents working in parallel with
  role dispatch and conflict resolution. Design doc pending.

---

## Install

### From .vsix (current — v0.1-alpha)

1. Download the latest `kovix-0.1.0-alpha.vsix` from the
   [releases page](https://github.com/Razisafir/fresh/releases).
2. In VS Code: open the Extensions view (Ctrl+Shift+X / Cmd+Shift+X).
3. Click the `...` menu at the top of the Extensions panel →
   **Install from VSIX...** → select the downloaded `.vsix` file.
4. Reload VS Code when prompted.

### From the Marketplace (later)

Not yet published. Will be available at
`https://marketplace.visualstudio.com/items?itemName=kovix.kovix` once v1.0
ships.

### From source (developers)

```bash
git clone https://github.com/Razisafir/fresh.git
cd fresh
npm ci
npm run compile
```

Then press F5 in VS Code to launch the Extension Development Host with Kovix
loaded.

---

## Quick start

1. Install Kovix (see above).
2. Open any folder in VS Code.
3. Click the Kovix icon in the activity bar (left side).
4. Run the command **Kovix: Manage API Keys** from the Command Palette
   (Ctrl+Shift+P / Cmd+Shift+P). Paste your Anthropic API key. It's stored
   in the OS keychain — the key never touches disk.
5. In the Kovix panel, type a task. For example:
   > Create a file called hello.txt with the text "hi"
6. The agent will propose a plan. Review it, then click **Approve**.
7. The agent executes the plan one milestone at a time. Watch the tool-call
   cards for what it's doing. When done, the file appears in your workspace.

---

## Configuration

Open VS Code Settings (Ctrl+, / Cmd+,) and search for `kovix`:

| Setting | Default | Description |
|---------|---------|-------------|
| `kovix.llm.activeProvider` | `anthropic` | LLM provider. v0.1-alpha only ships Anthropic; other providers are scaffolded for future versions. |
| `kovix.llm.activeModel` | _(empty)_ | Model name, e.g. `claude-sonnet-4-20250514`. |
| `kovix.autonomy.defaultMode` | `major_milestone` | When to pause for approval: `every_milestone`, `major_milestone`, `selective`, `full_auto`. |
| `kovix.autonomy.pauseOnVerificationFailure` | `true` | Always pause if a milestone's verification fails, regardless of autonomy mode. |
| `kovix.memory.embedProvider` | `ollama` | _(v1.0-beta)_ Embedding provider. `none` disables memory. |
| `kovix.memory.embedModel` | `nomic-embed-text` | _(v1.0-beta)_ Embedding model name. |
| `kovix.memory.vectorStore` | `in-process` | _(v1.0-beta)_ Vector store backend. `in-process` uses `hnswlib-node` (no Docker). |
| `kovix.mcp.servers` | `[]` | _(v1.0-beta)_ MCP server configurations. |
| `kovix.mcp.toolTimeoutMs` | `30000` | _(v1.0-beta)_ Per-tool-call timeout for MCP tools. |
| `kovix.security.allowExternalTargets` | `false` | Allow `web_fetch` to hit non-allowlisted external URLs. |
| `kovix.debug.verbose` | `false` | Verbose logging to the Kovix output channel. |

---

## Project status

**v0.1-alpha** — feature-complete for the basic Plan → Approve → Execute →
Verify loop with the 7 built-in tools and the Anthropic provider. All
automated gates green: typecheck, lint (with security rules), compile,
279 tests, 0 npm audit vulnerabilities. CI runs on every push (Node 20.x
and 22.x matrix).

**Not yet done:** memory recall, MCP server host, multi-agent swarm,
marketplace listing, cross-platform install verification on Windows/macOS.
See the roadmap in `docs/` for the full plan.

---

## Contributing

This project is currently single-maintainer. If you find a bug, please open
an issue at <https://github.com/Razisafir/fresh/issues> with:
- What you were trying to do
- What you expected
- What actually happened (paste the Kovix output channel logs — View →
  Output → select "Kovix" from the dropdown)

See `docs/10_MAINTENANCE.md` for the issue-triage convention and
`docs/09_RELEASE_CHECKLIST.md` for the release process.

---

## License

MIT. See [LICENSE.txt](./LICENSE.txt).
