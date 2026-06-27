# 10 — Maintenance Plan

> How the Kovix project is maintained going forward. Covers contributing,
> changelog, and issue triage. Applies from v0.1-alpha onward.

---

## Contributing

Kovix is currently single-maintainer (Razisafir). This section exists for
future-proofing — if contributors join, the conventions are already
documented.

### Development setup

```bash
git clone https://github.com/Razisafir/fresh.git
cd fresh
npm ci              # install exact deps from package-lock.json
npm run compile     # tsc --noEmit + esbuild bundle
npm test            # 318 unit + integration tests (headless, no VS Code needed)
```

Press F5 in VS Code to launch the Extension Development Host with Kovix
loaded.

### The 5 quality gates (all must pass before merge)

1. `npm run typecheck` — `tsc --noEmit` against the strict `tsconfig.json`
2. `npm run lint` — `eslint .` with security rules (`no-eval`,
   `no-new-func`, `no child_process.exec/execSync`)
3. `npm run compile` — `tsc --noEmit` + `esbuild` bundle → `dist/extension.js`
4. `npm test` — mocha with the vscode shim, all tests passing
5. `npm audit` — 0 vulnerabilities

CI runs all 5 gates on every push (Node 20.x + 22.x matrix). A PR is not
mergeable until CI is green on both Node versions.

### Git workflow

- `main` is always shippable. Never commit directly to `main`.
- Feature branches: `<phase>-<description>` (e.g. `phase-6-10-execution`,
  `m5-memory`, `m6-mcp-host`).
- Merge via PR. The lead reviews + merges.
- Commit messages: `<phase/round>: <description>` (e.g. "Phase 8-A (M5):
  Universal semantic memory service — local-only").

### Code conventions

- **TypeScript strict mode.** No `any` in source code (test code may use
  `any` for vscode stubs). `noUnusedLocals` + `noUnusedParameters` enabled.
- **No framework in the webview.** Vanilla JS/CSS per D-010. If this
  constraint needs revisiting, flag it explicitly — don't silently break it.
- **Security invariants are mechanical, not aspirational.** `no-eval`,
  `no-new-func`, `no child_process.exec` are enforced by ESLint, not just
  by code review. If you need to disable one of these rules for a
  legitimate reason, add a scoped `// eslint-disable-next-line` with a
  comment explaining why.
- **JSDoc on all public APIs.** Security-critical functions (`assertWithinWorkspace`,
  `sanitise`, `redactSecrets`, `assertSafeUrl`, `safeFetch`, `buildChildEnv`,
  `isBlockedCommand`) have detailed JSDoc explaining the threat model.
- **License headers.** Every source file has a top-of-file JSDoc block
  identifying the old-repo file it was ported from (if any), the port
  strategy, decisions referenced, and security invariants preserved.

### Test conventions

- Tests live in `test/unit/` (pure logic) and `test/integration/`
  (multi-component). The split is about speed, not philosophy — unit tests
  run in <100ms total.
- The vscode module is mocked via `test/_setup/vscode-shim-register.cjs`,
  which hooks `Module._resolveFilename`. Tests run headless in plain Node
  (no `@vscode/test-electron` launch). This is what makes CI fast.
- Test names are imperative ("returns X", "throws on Y", "does NOT Z").
  Avoid "should" — it adds nothing.
- Chai assertions: `expect(x).to.be.true` triggers a false positive on
  `@typescript-eslint/no-unused-expressions`. The rule is disabled in
  `test/**/*.ts` via `eslint.config.mjs`.

---

## Changelog

See `CHANGELOG.md` for the full history. Format: one section per version,
with Added / Changed / Fixed / Removed subsections.

The changelog is seeded from `docs/DECISIONS.md`, `docs/ISSUES.md`, and
the shared worklog at `/home/z/my-project/worklog.md`. The lead
(Razisafir) writes the changelog entry for each release — it's not
auto-generated, because auto-generated changelogs from commit messages
are unreadable.

---

## Issue triage convention

### Where issues live

- **GitHub Issues** (`https://github.com/Razisafir/fresh/issues`) — user-
  facing bug reports + feature requests.
- **`docs/ISSUES.md`** — the internal issue inventory. Every issue that
  affects the codebase (whether from GitHub Issues, self-discovered, or
  from an audit) gets an entry here with a stable ID (R-XXX for resolved,
  D-XXX for deferred).

### Triage flow

1. **User reports a bug on GitHub Issues.**
2. **Lead acknowledges within 48 hours** (sooner for critical bugs).
3. **Lead creates an entry in `docs/ISSUES.md`** with the next available
   R-XXX or D-XXX ID. Status starts as OPEN.
4. **Lead investigates.** If it's a real bug, fix it in a feature branch.
   If it's a feature request, decide whether it's in scope for the next
   version. If it's a duplicate, close with a link to the original.
5. **On fix/defer, update the ISSUES.md entry** to RESOLVED or DEFERRED
   with evidence (commit hash, rationale, revisit date).
6. **Close the GitHub Issue** with a reference to the ISSUES.md entry.

### RESOLVED vs DEFERRED — who decides?

**The lead (Razisafir) decides.** Same as it's been this whole project.
There is no committee, no voting, no consensus process. The lead is the
single point of accountability.

- **RESOLVED** = the issue is fixed in the codebase, with evidence (commit
  hash + test that verifies the fix).
- **DEFERRED** = the issue is real but intentionally not fixed in this
  version, with a rationale + a revisit date (e.g. "v1.0-beta", "v1.0",
  "when payment integration is designed").
- **OPEN** = the issue is real and must be fixed before the next version
  ships. There should be ZERO OPEN issues at release time.

### What goes in an ISSUES.md entry

Every entry (RESOLVED, DEFERRED, or OPEN) has:
- **Source** — where the issue was found (GitHub Issue #N, audit doc,
  self-discovered, etc.)
- **Status** — RESOLVED / DEFERRED / OPEN
- **Evidence** — for RESOLVED: commit hash + test name. For DEFERRED:
  rationale + revisit date. For OPEN: what's blocking the fix.
- **Cross-references** — related D-XXX decisions, related R-XXX issues.

### Critical bugs (special handling)

A "critical bug" is one that:
- Loses user data
- Leaks credentials
- Allows arbitrary code execution
- Prevents the extension from activating

**Critical bugs get a patch release** (e.g. v1.0.1 → v1.0.2) within 24
hours of discovery. The patch release follows the full
`docs/09_RELEASE_CHECKLIST.md` — no shortcuts, even for critical bugs.

---

## Versioning

Semver. Pre-release suffixes for alpha/beta/rc:
- `0.1.0-alpha` — current (v0.1-alpha feature-complete)
- `0.1.0-beta` — after Phase 6-B install smoke test passes
- `1.0.0-beta` — after Phase 8 (M5 + M6) ships
- `1.0.0-rc.1` — after Phase 10-A release hardening
- `1.0.0` — after Phase 10-B marketplace publish

Patch versions for bug fixes: `1.0.1`, `1.0.2`, etc.
Minor versions for new features: `1.1.0` (swarm), `1.2.0`, etc.
Major versions for breaking changes: `2.0.0` (not planned).

---

## Deprecation policy

Features are deprecated with a notice in `CHANGELOG.md` + a runtime
warning in the Kovix output channel. Deprecated features are removed in
the next major version (e.g. a feature deprecated in v1.2 is removed in
v2.0).

No features are currently deprecated.

---

## Support

- **GitHub Issues** — bug reports + feature requests only. Not for general
  questions.
- **No chat / Discord / forum.** The project is single-maintainer; a chat
  channel would be unreadable. If the project grows past
  single-maintainer, reconsider.

---

## License

MIT. See `LICENSE.txt`. Contributions are accepted under the same license.
