# Changelog

All notable changes to Kovix are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — v1.0-beta (in development)

### Added — Phase 6: Packaging
- `@vscode/vsce` devDependency for `.vsix` packaging
- `LICENSE.txt` (MIT)
- `.vscodeignore` (ships only `dist/extension.js` + `media/` + manifest)
- `media/kovix-icon.png` (128×128 marketplace icon) + `kovix-icon@2x.png` (256×256 retina)
- `docs/06_PACKAGING.md` — build sequence, .vscodeignore rationale, troubleshooting
- `docs/07_MARKETPLACE_LISTING.md` — marketplace short + long description draft
- `package.json` fields: `repository`, `icon`, `homepage`, `bugs`; bumped version to `0.1.0-alpha`; removed unused `browser` field

### Added — Phase 7: Branding + UI Polish (proposals only, not implemented)
- `docs/logo-concepts/` — 3 SVG logo directions (Convergence, Milestone Stepper, Prism Focus) + HTML preview
- `docs/07B_DESIGN_REFINEMENT_ROUND1.md` — diff-style proposal for 5 UI elements (message bubbles, plan-approval card, tool-call cards, input box, motion)
- `docs/07C_LIGHT_THEME_TRADEOFF.md` — light theme effort estimate (~1.5h) + recommendation (YES for v1.0)

### Added — Phase 8-A: M5 Universal Memory
- `src/memory/types.ts` — IMemoryEntry, IMemoryMatch, IMemoryConfig
- `src/memory/embeddingService.ts` — Ollama embedding client + NullEmbeddingService (degrades gracefully when provider=none)
- `src/memory/vectorStore.ts` — hnswlib-node wrapper (cosine similarity, disk persistence to `~/.kovix/memory/`)
- `src/memory/memoryService.ts` — orchestration facade + singleton
- `test/unit/memory/memoryService.test.ts` — 27 unit tests
- `docs/08A_MEMORY_SMOKE_TEST.md` — USER smoke test script
- Wired into `agentLoop.ts`: retrieve top-5 memories before planning (passed as `extraContext`); store task+outcome after completion
- SEC-6: all retrieved memory is sanitised via `wrapMemoryContext()` before injection
- Degrades gracefully: if `embedProvider=none` or Ollama is down, agent works normally without memory context

### Added — Phase 8-B: M6 MCP Server Host
- `src/mcp/types.ts` — IMcpServerConfig, IMcpToolDefinition, IMcpCallResult, IJsonRpcMessage
- `src/mcp/mcpClient.ts` — single-server connection over stdio (JSON-RPC 2.0, spawn + initialize + tools/list + tools/call)
- `src/mcp/mcpManager.ts` — multi-server manager, registers tools as `<serverName>__<toolName>` in the toolRegistry
- `test/unit/mcp/mcpManager.test.ts` — 12 unit tests
- `docs/08B_MCP_SMOKE_TEST.md` — USER smoke test with `@modelcontextprotocol/server-filesystem`
- Wired into `extension.ts`: McpManager started on activate, stopped on deactivate
- v1.0-beta scope: stdio transport only (SSE/remote deferred)
- SEC-3: `spawn()` only, no shell (ESLint enforced)
- SEC-6: MCP tool outputs sanitised via `sanitiseForLlm()`
- SEC-7: secrets in MCP outputs redacted via `redactSecrets()`
- SEC-9: child process env sanitised via `buildChildEnv()`
- SEC-4 (workspace boundary) NOT enforced on MCP tools — documented limitation (MCP tools are opaque)

### Added — Phase 8-C: Multi-root Workspace Fix
- `src/security/workspaceRoots.ts` — `getWorkspaceRootsProvider()` adapter (Layer 4)
- Updated 4 file tools (`readFile`, `writeFile`, `listDirectory`, `editFile`) to pass ALL workspace roots to `assertWithinWorkspace()` (previously only passed `workspaceFolders[0]`)
- Paths in the second+ root of a multi-root workspace now work correctly

### Added — Phase 9-A: Swarm Design Doc
- `docs/08_SWARM_DESIGN.md` — design doc for v1.1 multi-agent swarm (no code). Covers role dispatch, conflict resolution, UI implications, approve-gate interaction. For lead review.

### Added — Phase 10: Release + Maintenance
- `docs/09_RELEASE_CHECKLIST.md` — literal checklist for every future release
- `docs/10_MAINTENANCE.md` — contributing, changelog, issue-triage convention
- `CHANGELOG.md` (this file)
- `CONTRIBUTING.md`

### Changed
- `README.md` — rewritten from 7-byte stub to full v0.1-alpha README (Plan→Approve→Execute→Verify loop, 7 tools, Anthropic provider, install instructions, project status badge)
- `package.json` version bumped from `0.0.1` to `0.1.0-alpha`
- Bundle size: 153.2 KB → 179.3 KB (memory service + MCP host + hnswlib-node)

### Test count
- 279 (v0.1-alpha) → 318 (v1.0-beta in development): +27 memory tests, +12 MCP tests

---

## [0.1.0-alpha] — 2026-06-26

### Added — Phase 0: State brief
- `docs/00_OLD_REPO_STATE.md` — state of the old Kovix_2.0 repo
- `docs/00_FILE_SUMMARIES.md` — per-file audit summaries
- `AGENTS.md` — entry point for the rebuild

### Added — Phase 1: Requirements + decisions
- `docs/01_REQUIREMENTS.md` — v1.0 MUST features (7)
- `docs/DECISIONS.md` — D-001 through D-013 (architecture, security tools dropped, credit system deferred, etc.)

### Added — Phase 2: Architecture
- `docs/02_ARCHITECTURE.md` — 4-layer architecture (Layer 1 pure logic → Layer 4 VS Code bindings)
- `docs/02a_ARCH_CHOICE_MATRIX.md` — fork-vs-extension decision (chose extension per D-011)

### Added — Phase 3: Implementation (Rounds 2A–2D)
- Ported from Kovix_2.0 (VS Code fork) to a standard VS Code extension
- 7 built-in tools: `read_file`, `write_file`, `edit_file`, `list_directory`, `run_command`, `search_code`, `web_fetch`
- Anthropic provider support (SecretStorage, no plaintext keys)
- Plan → Approve → Execute → Verify agent loop
- 4 autonomy modes: every_milestone, major_milestone, selective, full_auto
- Agent chat panel (WebviewViewProvider) with streaming, tool cards, plan-approval card, milestone pause banner, pending changes section
- `docs/04_DESIGN_SYSTEM.md` — Material 3 dark-first design tokens
- `docs/03_MIGRATION_LOG.md` — full migration log (Rounds 2A–2D)
- `docs/SECURITY_AUDIT.md` — Round 2C security audit

### Added — Post-R2D Hardening
- `eslint.config.mjs` — flat config with security rules (`no-eval`, `no-new-func`, `no child_process.exec/execSync`, `no-unused-vars` with `^_` pattern)
- `test/_setup/vscode-shim-register.cjs` — Module._resolveFilename hook for the vscode mock (survives `npm ci`, no postinstall needed)
- `scripts/run-tests.cjs` — version-aware mocha wrapper (only sets `--no-experimental-strip-types` on Node ≥ 22.6)
- `.github/workflows/ci.yml` — GitHub Actions CI (Node 20.x + 22.x matrix, 5 gates, artifact upload)
- `docs/ISSUES.md` — 21 issues tracked (13 RESOLVED, 8 DEFERRED, 0 OPEN)

### Security invariants (mechanically enforced)
- SEC-1: credentials in OS keychain via SecretStorage
- SEC-3: no shell execution — `spawn()` only, command blocklist, metachar detection
- SEC-4: workspace path-traversal defence on all file tools
- SEC-6: prompt-injection filtering on all tool outputs
- SEC-7: secret redaction (10+ patterns) + SSRF URL defence
- SEC-9: child-process env sanitisation (strips NODE_OPTIONS, LD_PRELOAD, etc.)

### Quality gates (all green)
- typecheck: 0 errors (strict mode)
- lint: 0 errors, 0 warnings
- compile: 153.2 KB esbuild bundle
- test: 279 passing
- audit: 0 vulnerabilities
