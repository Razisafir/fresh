# 07C — Light Theme Decision + Scoping (PROPOSAL — NOT IMPLEMENTED)

> **Status: PROPOSAL for lead decision.** Per Phase 7-C prompt: "give me a
> one-page tradeoff — effort estimate to add light theme support... Recommend
> yes/no for v1.0, I'll decide."

Reference: `docs/04_DESIGN_SYSTEM.md` (D-013: dark-only for v0.1, light deferred),
`src/ui/webview/agentPanel.css`.

---

## TL;DR

**Recommendation: YES, ship light theme support in v1.0.**

Effort: ~1.5 hours of work. The CSS architecture is already fully token-based
(271 lines consume `--kovix-*` tokens; 0 lines use hardcoded colors outside
token definitions; 0 JS color logic; 0 inline HTML styles). Adding a light
theme is a pure token-value override — no selector changes, no JS changes,
no HTML changes.

VS Code's built-in `vscode-light` / `vscode-dark` / `vscode-high-contrast`
body classes make theme detection free (no JS theme-sniffing needed).

---

## Current architecture audit

### What's already abstracted

Every color in the webview flows through one of 25 CSS custom properties
defined on `.kovix-root` (agentPanel.css lines 30–67):

| Token category | Count | Examples |
|----------------|-------|----------|
| Surfaces | 5 | `--kovix-surface-0` through `--kovix-surface-3` + `--kovix-surface-overlay` |
| Text | 5 | `--kovix-text-primary`, `-secondary`, `-tertiary`, `-on-accent`, `-code` |
| Accent | 4 | `--kovix-accent`, `-hover`, `-pressed`, `-faded`, `-ring` |
| Status | 8 | `--kovix-success`, `-bg`, `-warning`, `-bg`, `-error`, `-bg`, `-info`, `-bg` |
| Roles | 4 | `--kovix-role-user`, `-agent`, `-tool`, `-system` |
| Shadow | 3 | `--kovix-shadow-1`, `-2`, `-3` |

271 lines in agentPanel.css consume these tokens via `var(--kovix-*)`.
**Zero lines use hardcoded hex colors** outside the token definition block.

### What's NOT abstracted (and would need attention)

1. **10 `rgba()` values in token definitions** — all in the token block
   (lines 36–94), not scattered. These are alpha-blended variants of the
   base colors (e.g. `--kovix-accent-faded: rgba(124, 131, 255, 0.16)`).
   In a light theme, some of these need re-tuning because the same alpha
   over a light surface reads differently than over a dark surface.

2. **3 shadow tokens use `rgba(0, 0, 0, ...)`** — black shadows on a light
   surface are more visible. The alpha values (0.3, 0.35, 0.4) are tuned
   for dark surfaces. Light theme needs lower alpha or different hue.

3. **`--kovix-text-on-accent: #0e0f12`** — dark text on the accent button.
   This is correct for dark theme (accent is light indigo, dark text reads
   well). In light theme, the accent stays the same (indigo is mid-tone),
   so dark-on-accent still works. No change needed.

4. **`--kovix-text-code: #f0b4ff`** — light purple for inline code. On a
   dark surface, this pops. On a light surface, it disappears. Needs a
   darker variant for light theme.

### VS Code theme-color variables

The webview currently uses only 2 VS Code variables:
- `--vscode-font-family` (in `--kovix-font-sans`)
- `--vscode-editor-font-family` (in `--kovix-font-mono`)

VS Code exposes ~60 `--vscode-*` color tokens that automatically reflect
the user's theme (e.g. `--vscode-editor-foreground`, `--vscode-editor-background`,
`--vscode-button-background`, etc.). We could lean on these MORE to make
the webview auto-adapt to any theme (dark, light, high-contrast, custom).

**However**, leaning on VS Code's tokens means giving up our deliberate
indigo accent (VS Code's `--vscode-button-background` is blue by default,
not indigo). The design system explicitly chose indigo to be distinct from
VS Code's blue (see `04_DESIGN_SYSTEM.md` §2.3). So we keep our own accent
token and only borrow VS Code's neutral surface/text tokens IF we want to.

**My recommendation for v1.0:** keep the current approach (own tokens,
parallel light-theme values). Don't lean on `--vscode-*` color tokens
because it would dilute the brand. The `vscode-light` body class is
sufficient for theme detection.

---

## Effort estimate

| Task | Time | Notes |
|------|------|-------|
| Define light-theme token values for all 25 tokens | 30 min | Need to maintain WCAG AA contrast ratios on light surfaces. Most are straightforward (invert surface scale, darken text). The 4 tricky ones: `text-code` (needs darker purple), `accent-faded` (alpha retune), shadows (alpha retune), `surface-overlay` (invert to black alpha). |
| Add `body.vscode-light .kovix-root { ... }` override block | 5 min | One selector, ~25 token overrides. |
| Visual verification in both themes | 30 min | Launch Extension Development Host, switch VS Code between Dark+/Light+, screenshot every component (messages, plan card, tool cards, input, milestone banner, pending changes, empty state, error message). Check contrast. |
| Update `docs/04_DESIGN_SYSTEM.md` with light-theme token table | 15 min | Parallel table for light values, plus a note on which tokens are theme-invariant (accent, status colors). |
| Test suite check | 10 min | Verify no tests assert on specific color values (they shouldn't — tests are on the provider, not the CSS). If any do, update them to be theme-agnostic. |
| **Total** | **~1.5 hours** | |

---

## Light-theme token values (proposed)

For lead review — these are my first-pass picks. Each is chosen to maintain
the same contrast ratio as the dark-theme equivalent.

| Token | Dark (current) | Light (proposed) | Notes |
|-------|----------------|------------------|-------|
| `--kovix-surface-0` | `#0e0f12` | `#ffffff` | Pure white background |
| `--kovix-surface-1` | `#15171b` | `#f7f8fa` | Slight off-white for cards |
| `--kovix-surface-2` | `#1c1f24` | `#eef0f3` | Deeper card / input bg |
| `--kovix-surface-3` | `#252930` | `#dde1e7` | Borders, hover states |
| `--kovix-surface-overlay` | `rgba(255,255,255,0.06)` | `rgba(0,0,0,0.04)` | Inverted |
| `--kovix-text-primary` | `#e6e8ee` | `#1a1d23` | Near-black |
| `--kovix-text-secondary` | `#9aa0aa` | `#5a6270` | Mid-grey |
| `--kovix-text-tertiary` | `#6b7178` | `#8a929d` | Lighter grey for placeholders |
| `--kovix-text-on-accent` | `#0e0f12` | `#ffffff` | White on indigo (accent is mid-tone) |
| `--kovix-text-code` | `#f0b4ff` | `#7c3aed` | Darker purple for light bg |
| `--kovix-accent` | `#7c83ff` | `#6366f1` | Slightly darker indigo for contrast on white |
| `--kovix-accent-hover` | `#9aa0ff` | `#7c83ff` | |
| `--kovix-accent-pressed` | `#6168e0` | `#4f46e5` | |
| `--kovix-accent-faded` | `rgba(124,131,255,0.16)` | `rgba(99,102,241,0.10)` | Lower alpha on white |
| `--kovix-accent-ring` | `rgba(124,131,255,0.45)` | `rgba(99,102,241,0.35)` | |
| `--kovix-success` | `#5ed387` | `#16a34a` | Darker green for white bg |
| `--kovix-warning` | `#f0c04a` | `#d97706` | Amber→orange (amber disappears on white) |
| `--kovix-error` | `#ff6b6b` | `#dc2626` | Darker red |
| `--kovix-info` | `#5eb8ff` | `#0284c7` | Darker blue |
| `--kovix-shadow-1` | `0 1px 2px rgba(0,0,0,0.3)` | `0 1px 2px rgba(0,0,0,0.06)` | Lower alpha |
| `--kovix-shadow-2` | `0 2px 6px rgba(0,0,0,0.35)` | `0 2px 6px rgba(0,0,0,0.08)` | |
| `--kovix-shadow-3` | `0 6px 16px rgba(0,0,0,0.4)` | `0 6px 16px rgba(0,0,0,0.10)` | |
| Role tokens | (unchanged) | (inherit from above) | Roles are aliases |

---

## What this does NOT include

- **High-contrast theme support** — VS Code's `vscode-high-contrast` body
  class. This is a separate effort (different token set, focus rings become
  solid borders, etc.). Defer to v1.0-rc or later.
- **Auto-detect theme changes at runtime** — already handled by VS Code.
  When the user switches theme, VS Code reloads the webview with the new
  body class. No JS needed.
- **A theme toggle in the Kovix UI** — not needed. Users set their theme
  via VS Code's settings; Kovix follows.

---

## Risks

1. **Contrast ratio regressions.** My proposed light-theme values are
   first-pass. Need to actually verify WCAG AA (4.5:1 for body text, 3:1
   for large text) on each surface combination. Worst case: 2-3 tokens
   need a second iteration.

2. **Status color readability.** The status colors (success/warning/error/info)
   are currently tuned for dark surfaces. On white, the darker variants I
   proposed should work, but warning (`#d97706` orange) might still be
   marginal on `#eef0f3` surface-2. Will verify in visual testing.

3. **Accent button legibility.** The accent (`#6366f1`) with white text
   (`#ffffff`) on top — contrast ratio is ~4.6:1, which barely passes AA
   for normal text. If we want AAA (7:1), need to darken the accent
   further. For a button (which is bold text, large-ish), AA is sufficient.

4. **None of the 279 tests cover CSS.** Tests are on the provider logic,
   not the rendered CSS. So a CSS regression won't be caught by CI — only
   by visual testing. This is true for dark theme today too; not a new
   risk, just worth noting.

---

## Recommendation

**YES, ship light theme in v1.0.**

Reasons:
1. **Cheap.** 1.5 hours. The architecture already supports it.
2. **Expected.** A public marketplace extension that's dark-only in 2026
   feels incomplete. Many users run light themes (especially during
   daytime / on laptops in bright environments).
3. **Low risk.** No new abstraction, no new webview surface (D-012 holds),
   no framework (D-010 holds). Just token values.
4. **D-013 explicitly deferred this to "v1.0-beta"** — but the effort
   estimate is so low that it makes sense to pull it into v1.0 rather
   than waiting. v1.0-beta can focus on the bigger features (memory, MCP).

If you say no, the fallback is trivial: do nothing, ship v1.0 dark-only,
add light theme in v1.0-beta per the original D-013 plan. No rework.
