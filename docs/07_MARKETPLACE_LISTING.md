# Kovix — Marketplace Listing Draft

> **Status: DRAFT — not yet published anywhere.** This document is for lead
> review per Phase 6-C of the SDLC roadmap. Once approved, the short
> description and long description below will be used when publishing to the
> VS Code Marketplace via `vsce publish`.

---

## Extension name

`Kovix`

## Publisher

`kovix` (namespace not yet claimed on the Marketplace — claimed at publish
time per Phase 10-B)

## Short description (≤ 200 chars)

> AI-native dev environment with a Plan → Approve → Execute → Verify agent
> loop. The agent proposes, you approve, it executes — one milestone at a
> time, with verification between each step.

**Character count:** 178 / 200 ✓

## Long description (marketplace "Description" field)

### Kovix — an agent that proposes before it acts

Kovix is a VS Code extension that runs an autonomous coding agent inside a
chat panel. Unlike a chat-only assistant, Kovix can actually read, write,
edit, and run files in your workspace — but every action goes through a
**Plan → Approve → Execute → Verify** loop, so you stay in control.

**How it works:**

1. You describe a task in natural language ("add a unit test for the auth
   module that covers the expired-token case").
2. Kovix proposes a structured plan: which files to read, what to write,
   what commands to run.
3. You review the plan and approve, reject, or ask for changes.
4. Kovix executes the plan one milestone at a time. Between milestones, it
   verifies the previous step's output. You can pause, skip, or abort at
   any boundary.
5. Each tool call appears as a collapsible card in the chat panel — you see
   exactly what command ran, with what arguments, and what it returned.

**Seven built-in tools**, each security-hardened:

- `read_file`, `write_file`, `edit_file`, `list_directory` — workspace
  file operations with path-traversal defence
- `run_command` — shell command execution with command blocklist,
  shell-metacharacter detection, and environment sanitisation (no
  `NODE_OPTIONS`, `LD_PRELOAD`, `PYTHONPATH` leakage)
- `search_code` — ripgrep-based content search
- `web_fetch` — HTTP fetch with SSRF defence (blocks private ranges, cloud
  metadata endpoints, link-local addresses)

**Security-first design:**

- API keys stored in the OS keychain via VS Code's `SecretStorage` — never
  written to disk in plaintext
- All tool outputs are sanitised before being returned to the LLM
  (prompt-injection prefix filtering, secret redaction across 10+ provider
  key formats)
- `no-eval`, `no-new-func`, and `no child_process.exec` enforced
  mechanically by ESLint — not just by code review
- Full audit trail in the Kovix output channel

**Four autonomy modes:**

- **Every milestone** — pause before each milestone (most cautious)
- **Major milestone** — pause only at milestones that create files, run
  commands, or edit config (default)
- **Selective** — pause only at user-selected milestones
- **Full auto** — run the entire plan without pausing (use with caution)

---

## What's not in v0.1-alpha (so you know what you're getting)

- **Single provider:** Anthropic only. OpenAI / Ollama / others are
  scaffolded in the settings but not yet wired up.
- **No semantic memory:** each task is independent. The agent doesn't
  recall context from prior tasks. (Planned for v1.0-beta, local-only via
  Ollama embeddings.)
- **No MCP server host:** you can't yet connect external Model Context
  Protocol servers. (Planned for v1.0-beta, stdio transport only.)
- **No multi-agent swarm:** one agent per task. (Planned for v1.1.)

---

## Categories

- AI
- Machine Learning
- Programming Languages
- Other

## Tags

`ai`, `agent`, `llm`, `anthropic`, `claude`, `automation`, `coding-assistant`,
`developer-tools`, `plan-approve-execute`

## Installation

### From .vsix (v0.1-alpha)

1. Download `kovix-0.1.0-alpha.vsix` from the
   [releases page](https://github.com/Razisafir/fresh/releases).
2. VS Code → Extensions view (Ctrl+Shift+X) → `...` menu →
   **Install from VSIX...** → select the file.
3. Reload VS Code.

### From source

```bash
git clone https://github.com/Razisafir/fresh.git
cd fresh
npm ci
npm run compile
```

Press F5 in VS Code to launch the Extension Development Host.

---

## Quick start

1. Install Kovix.
2. Open any folder in VS Code.
3. Click the Kovix icon in the activity bar.
4. Command Palette → **Kovix: Manage API Keys** → paste your Anthropic API
   key (stored in OS keychain).
5. Type a task in the panel:
   > Create a file called hello.txt with the text "hi"
6. Review the plan, click Approve, watch it execute.

---

## Repository

<https://github.com/Razisafir/fresh>

## Issues

<https://github.com/Razisafir/fresh/issues>

## License

MIT

---

## Changelog (high-level)

### v0.1-alpha
- Initial preview release
- Plan → Approve → Execute → Verify agent loop
- 7 built-in tools (read/write/edit/list/run/search/fetch)
- Anthropic provider support
- Agent chat panel with streaming, tool cards, plan-approval card
- Four autonomy modes
- Security invariants enforced by ESLint + 279 unit/integration tests

---

_This listing was drafted per Phase 6-C of the Kovix SDLC roadmap. It will be
updated as v1.0-beta and v1.0 features land._
