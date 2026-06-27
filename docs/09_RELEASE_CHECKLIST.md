# 09 — Release Checklist

> Literal checklist for every future Kovix release. Copy this file, rename
> to `09_RELEASE_CHECKLIST_v<version>.md`, and check each box. Do NOT skip
> steps — every box must be checked before the release ships.

---

## Pre-release (1 week before)

- [ ] Freeze scope — no new features land after this point, only bug fixes
- [ ] Update `package.json` `version` field to the new version (semver)
- [ ] Update `CHANGELOG.md` with all changes since the last release
- [ ] Update `docs/ISSUES.md` — all OPEN issues are either RESOLVED or
      explicitly deferred with a rationale + revisit date
- [ ] Update `docs/DECISIONS.md` — any new decisions logged with D-XXX ID
- [ ] All `D-XXX` deferred items have been reviewed: are any now ready to
      ship? (If yes, move to RESOLVED with evidence)

---

## Automated gates (all 5 must pass)

- [ ] `npm run typecheck` — 0 errors (strict mode)
- [ ] `npm run lint` — 0 errors, 0 warnings (security rules enforced:
      `no-eval`, `no-new-func`, `no child_process.exec/execSync`)
- [ ] `npm run compile` — bundle produced, size is sane (<500 KB for
      v1.0; flag if >1 MB)
- [ ] `npm test` — all tests passing (check the count against the prior
      release — should only increase, never decrease)
- [ ] `npm audit` — 0 vulnerabilities

- [ ] CI is green on `main` (both Node 20.x and 22.x matrix)
- [ ] No skipped/placeholder tests (grep for `it.skip`, `describe.skip`,
      `xit`, `xdescribe`)

---

## Packaging

- [ ] `npm run package` produces a `.vsix` with 0 warnings
- [ ] `.vsix` size is sane (50 KB to a few MB)
- [ ] `npx vsce ls` output reviewed — no dev files leaking (no `src/`,
      `test/`, `scripts/`, `docs/`, `.tsbuildinfo`)
- [ ] `README.md` reflects the actual shipping features (no aspirational
      claims, no missing features)
- [ ] `LICENSE.txt` is present and matches `package.json` `license` field
- [ ] `media/kovix-icon.png` is the current logo (128×128 PNG)
- [ ] `package.json` `version`, `publisher`, `repository`, `icon` fields
      are all correct

---

## Manual smoke tests (USER — cannot be automated)

### v0.1-alpha basic task (always re-run)
- [ ] Install the `.vsix` on a clean VS Code (no prior Kovix)
- [ ] Open a folder, click Kovix icon, panel opens
- [ ] Run "Manage API Keys", paste Anthropic key
- [ ] Type: "create a file called hello.txt with the text hi"
- [ ] Plan appears, user approves
- [ ] `hello.txt` appears in workspace with "hi" inside
- [ ] No error popups, red banners, or "Extension Host terminated" messages
- [ ] **Critical:** the plan-approval gate fired BEFORE the file was written

### Memory recall (M5, v1.0-beta+)
- [ ] See `docs/08A_MEMORY_SMOKE_TEST.md` — all 3 tests pass
      (store+recall, cross-project recall, degraded mode)

### MCP tool call (M6, v1.0-beta+)
- [ ] See `docs/08B_MCP_SMOKE_TEST.md` — all 5 tests pass
      (list MCP tools, call MCP tool, SEC-6/SEC-7 sanitisation,
      degraded mode, server failure isolation)

### Multi-root workspace (Phase 8-C, v1.0-beta+)
- [ ] Open a 2-folder multi-root workspace in VS Code
- [ ] Run a task that reads/writes a file in the SECOND root
- [ ] File operation succeeds (no "outside workspace" error)
- [ ] Run a task that reads/writes a file in the FIRST root
- [ ] File operation succeeds

### Light theme (if 7-C was approved, v1.0+)
- [ ] Switch VS Code to Light+ theme
- [ ] All webview surfaces (agent panel, plan card, tool cards, input box)
      are readable
- [ ] Contrast ratios meet WCAG AA (4.5:1 for body text)
- [ ] No invisible text, no broken icons, no white-on-white

---

## Cross-platform install (USER — at least one platform)

- [ ] Install the `.vsix` on Windows (or macOS, or Linux — whichever the
      lead uses day-to-day)
- [ ] Extension activates on first use (no manual activation needed)
- [ ] All 7 built-in tools work (read_file, write_file, edit_file,
      list_directory, run_command, search_code, web_fetch)
- [ ] Agent panel renders correctly (no layout bugs, no missing CSS)

---

## Documentation review

- [ ] `README.md` matches reality (no features mentioned that don't exist,
      no features omitted that do exist)
- [ ] `docs/07_MARKETPLACE_LISTING.md` updated for the new version
- [ ] `docs/ISSUES.md` summary counts are accurate
- [ ] `docs/DECISIONS.md` has no unresolved D-XXX items
- [ ] `CHANGELOG.md` entry for the new version is complete

---

## Credential hygiene (5.5-C, every release)

- [ ] `git remote -v` does NOT show a token in the URL (use SSH or
      credential helper, not URL-embedded PAT)
- [ ] `git log --all -p | grep -iE 'github_pat_|ghp_|sk-ant-|sk-proj-|AKIA[0-9A-Z]{16}'`
      returns no actual credentials (pattern definitions in source code
      are expected and fine)
- [ ] `git log --all --source --remotes -- '*.env' '*.pem' '*.key'`
      returns nothing
- [ ] No credentials in chat logs, commit messages, or worklog

---

## Final sign-off

- [ ] Lead has reviewed all manual smoke test results
- [ ] Lead has reviewed the `CHANGELOG.md` entry
- [ ] Lead has reviewed the `README.md` for accuracy
- [ ] Lead has explicitly approved: "yes, ship version `<version>`"

---

## Publishing (ONLY after all above are checked)

- [ ] `vsce publish <version>` (or marketplace web upload)
      — this is the point of no return. See `docs/07_MARKETPLACE_LISTING.md`
      for the listing copy.
- [ ] Verify the listing is live at
      `https://marketplace.visualstudio.com/items?itemName=kovix.kovix`
- [ ] Tag the release in git: `git tag v<version> && git push --tags`
- [ ] Create a GitHub Release with the `.vsix` attached
- [ ] Update `CHANGELOG.md` with the release date

---

## Post-release

- [ ] Monitor the Kovix output channel / GitHub issues for 48 hours
- [ ] Triage any new issues into `docs/ISSUES.md` (RESOLVED / DEFERRED /
      OPEN)
- [ ] If a critical bug is found, prepare a patch release (repeat this
      checklist with version `<version>.1`)
