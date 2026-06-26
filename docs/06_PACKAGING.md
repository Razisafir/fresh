# 06 — Packaging

> How Kovix is packaged into a `.vsix` file for distribution. Covers the build
> command sequence, what `.vscodeignore` excludes and why, the `package.json`
> fields that matter for packaging, and troubleshooting notes for every
> warning that came up during the initial packaging pass.

---

## Build command sequence

From a clean checkout:

```bash
npm ci                          # install exact deps from package-lock.json
npm run compile                 # tsc --noEmit + esbuild bundle → dist/extension.js
npm run package                 # vsce package --no-dependencies
```

Output: `kovix-<version>.vsix` in the repo root (e.g. `kovix-0.1.0-alpha.vsix`).

The `--no-dependencies` flag tells vsce NOT to bundle runtime npm dependencies
into the .vsix. This is correct for Kovix because the esbuild bundle in
`dist/extension.js` already inlines every dependency that the extension
actually imports. Bundling them again via vsce would double-ship the same
code and bloat the .vsix.

### Verifying what's inside

```bash
npx vsce ls                     # list every file in the .vsix
unzip -l kovix-0.1.0-alpha.vsix # same thing via unzip
```

### Installing locally for testing

```bash
code --install-extension kovix-0.1.0-alpha.vsix
```

Or via the VS Code UI: Extensions view → `...` menu → **Install from VSIX...**

---

## What `.vscodeignore` excludes (and why)

The full file lives at `.vscodeignore` in the repo root. Strategy: ship ONLY
what the runtime needs. Anything not explicitly ignored gets packaged.

| Excluded | Why |
|----------|-----|
| `src/` | Source TypeScript — the .vsix ships the compiled `dist/extension.js`, not the source. |
| `test/` | Test code — not needed at runtime. |
| `scripts/` | Build scripts (`run-tests.cjs`, etc.) — dev-only. |
| `docs/` | Internal design docs — not user-facing. |
| `AGENTS.md` | Internal entry-point doc — not user-facing. |
| `.github/` | CI workflow — not needed at runtime. |
| `.editorconfig`, `.gitignore`, `.gitattributes` | Editor/VCS config — not needed at runtime. |
| `.mocharc.json` | Test runner config — dev-only. |
| `eslint.config.mjs` | Linter config — dev-only. |
| `esbuild.config.js` | Bundler config — dev-only (esbuild is invoked at build time, not runtime). |
| `tsconfig.json`, `tsconfig.test.json` | TypeScript config — dev-only. |
| `node_modules/**/*.md`, `*.map`, `*.ts`, `test/`, `tests/`, etc. | Dev-only files inside npm packages — strips ~80% of node_modules weight. |
| `**/*.tsbuildinfo` | TypeScript incremental-build cache — should never ship (was leaking in the first packaging pass; see Troubleshooting below). |
| `out/`, `coverage/`, `test-results/`, `.nyc_output/` | Build/test artifacts. |
| `.DS_Store`, `Thumbs.db`, `*.log` | OS / editor cruft. |
| `.vscode/`, `.idea/` | Editor-specific workspace config. |

### What IS shipped (intentionally)

- `package.json` — extension manifest (required)
- `README.md` — marketplace listing body (required)
- `LICENSE.txt` — MIT license (required for marketplace)
- `dist/extension.js` — the compiled bundle (the actual extension code)
- `media/kovix-icon.png` — 128×128 marketplace icon
- `media/kovix-icon@2x.png` — 256×256 retina marketplace icon
- `media/kovix-viewbar.svg` — 24×24 activity bar icon (uses `currentColor`)

---

## `package.json` fields relevant to packaging

| Field | Value | Notes |
|-------|-------|-------|
| `name` | `kovix` | Lowercase, no spaces. Used in the .vsix filename. |
| `displayName` | `Kovix` | Human-readable name shown in the marketplace. |
| `version` | `0.1.0-alpha` | Semver. Pre-release suffix (`-alpha`) is supported by vsce. |
| `publisher` | `kovix` | Must match a publisher you've created on the VS Code Marketplace. **Not yet claimed** — claimed at publish time per Phase 10-B. |
| `license` | `MIT` | Must match the LICENSE.txt file. |
| `icon` | `media/kovix-icon.png` | 128×128 PNG. Required for marketplace (otherwise you get a broken-image placeholder). |
| `repository` | `{ type: "git", url: "https://github.com/Razisafir/fresh.git" }` | Required by vsce (warns if missing). |
| `homepage` | `https://github.com/Razisafir/fresh#readme` | Optional but recommended. |
| `bugs` | `{ url: "https://github.com/Razisafir/fresh/issues" }` | Optional but recommended. |
| `engines.vscode` | `^1.95.0` | Minimum VS Code version. |
| `main` | `./dist/extension.js` | Entry point. |

### Fields that were removed

- `browser` — was set to `./dist/extension-browser.js` (a web extension
  bundle) but we don't ship a web extension. vsce errored on the missing
  file. Removed in the packaging pass.

---

## Troubleshooting — warnings/errors encountered and how they were fixed

### Error 1: Missing `repository` field

**vsce output:**
```
WARNING  A 'repository' field is missing from the 'package.json' manifest file.
Use --allow-missing-repository to bypass.
```

**Fix:** Added `repository: { type: "git", url: "https://github.com/Razisafir/fresh.git" }` to package.json. The `--allow-missing-repository` flag is a bypass, not a fix — the proper resolution is to declare the repository.

### Error 2: Missing extension entrypoint

**vsce output:**
```
ERROR  Extension entrypoint(s) missing. Make sure these files exist and aren't ignored by '.vscodeignore':
  extension/dist/extension-browser.js
```

**Cause:** `package.json` had `"browser": "./dist/extension-browser.js"` — a field used by web extensions. We don't ship a web extension (the existing `compile` script only builds `dist/extension.js` via esbuild, not a browser bundle).

**Fix:** Removed the `browser` field from package.json. If we ever add web extension support, this field comes back and we add a separate esbuild build for the browser bundle.

### Warning 3: `.tsbuildinfo` leaking into the package

**Symptom:** First clean package included `dist/.tsbuildinfo` (34 KB of TypeScript incremental-build cache).

**Cause:** The .vscodeignore pattern `*.tsbuildinfo` didn't match `dist/.tsbuildinfo` because vsce's glob handling treats `*` as matching within a single path component only.

**Fix:** Changed the pattern to `**/*.tsbuildinfo` (matches at any depth) and added explicit `dist/.tsbuildinfo` + `dist/.tsbuildinfo.test` lines for defence in depth. Re-packaged and confirmed the file is no longer included.

### Future warning to watch for: large bundle

**Current INFO message:**
```
The file extension/dist/extension.js is large (153.19 KB)
```

This is informational, not a warning. 153 KB is normal for an esbuild bundle of an extension with this much functionality (agent loop, 7 tools, webview provider, security layer). If it grows past ~500 KB, investigate whether something heavy is being imported unintentionally.

---

## Sane .vsix size range

- **Expected:** 50 KB to a few MB for a typical extension.
- **Current:** 59.12 KB (lean — the esbuild bundle inlines only what's imported, and .vscodeignore strips dev files).
- **Red flag:** 50+ MB. Usually means `node_modules` runtime deps are being bundled (forgot `--no-dependencies`), or `.vscodeignore` is missing a large directory.

To diagnose a too-large .vsix:

```bash
npx vsce ls                    # see what's packaged
unzip -l kovix-*.vsix | sort -k1 -n -r | head -20   # biggest files first
```

---

## CI integration

The `.github/workflows/ci.yml` workflow does NOT currently produce a .vsix
artifact — it only uploads the raw `dist/extension.js` bundle. This is fine
for v0.1-alpha (the .vsix is produced locally for the install smoke test in
Phase 6-B). When we approach v1.0 release, CI should be extended to run
`npm run package` and upload the .vsix as a build artifact, so each release
candidate has a reproducible build.

---

## Reproducibility

The packaging is fully reproducible from a clean checkout:

```bash
git clone https://github.com/Razisafir/fresh.git
cd fresh
git checkout v0.1.0-alpha    # or the relevant tag/commit
npm ci
npm run compile
npm run package
# → kovix-0.1.0-alpha.vsix (byte-identical modulo timestamps)
```

The only non-determinism is file timestamps inside the .vsix zip, which
don't affect functionality.
