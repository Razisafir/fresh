# Contributing to Kovix

Kovix is currently single-maintainer, but this document exists for
future-proofing. If you're reading this and you're not the maintainer,
you're welcome to open issues and PRs.

## Quick start

```bash
git clone https://github.com/Razisafir/fresh.git
cd fresh
npm ci
npm run compile
npm test
```

Press F5 in VS Code to launch the Extension Development Host.

## The 5 quality gates (all must pass before merge)

1. `npm run typecheck` — strict TypeScript, 0 errors
2. `npm run lint` — ESLint with security rules (`no-eval`, `no-new-func`,
   no `child_process.exec/execSync`)
3. `npm run compile` — esbuild bundle, size sanity-checked
4. `npm test` — mocha + vscode shim, all tests passing
5. `npm audit` — 0 vulnerabilities

CI runs all 5 on every push (Node 20.x + 22.x matrix). PRs are not
mergeable until green on both.

## Git workflow

- `main` is always shippable. Never commit directly to `main`.
- Feature branches: `<phase>-<description>` (e.g. `m5-memory`).
- Merge via PR. The lead reviews + merges.
- Commit messages: `<phase/round>: <description>`.

## Code conventions

- TypeScript strict mode. No `any` in source code.
- No framework in the webview (vanilla JS/CSS per D-010).
- Security invariants are ESLint-enforced, not aspirational.
- JSDoc on all public APIs. Security-critical functions have detailed
  threat-model docs.
- Every source file has a license header identifying port origin +
  decisions referenced + security invariants preserved.

## Test conventions

- Tests in `test/unit/` (pure logic) and `test/integration/` (multi-component).
- The vscode module is mocked via `test/_setup/vscode-shim-register.cjs`.
  Tests run headless in plain Node — no VS Code launch needed.
- Test names are imperative ("returns X", "throws on Y", "does NOT Z").

## Reporting bugs

Open an issue at <https://github.com/Razisafir/fresh/issues> with:
- What you were trying to do
- What you expected
- What actually happened (paste the Kovix output channel logs —
  View → Output → select "Kovix")

See `docs/10_MAINTENANCE.md` for the full issue-triage convention.

## License

MIT. See [LICENSE.txt](./LICENSE.txt). Contributions are accepted under
the same license.
