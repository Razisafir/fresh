# Kovix Design System

**Status:** v0.1-alpha (Round 2D deliverable, per D-013)
**Scope:** Applies to the two Kovix webviews (agent chat + pending changes inline section). Stock VS Code surfaces (file explorer, editor, terminal) are NOT re-themed — they keep the user's chosen VS Code theme. Per D-012, v0.1 ships only the agent chat panel; the pending changes section is a collapsible `<section>` inside the same webview.
**Aesthetic:** Cursor / Codex CLI polish with a Google Material 3 influence (per D-013). Dark-first; light theme deferred to v1.0-beta.
**Reference targets:** Cursor composer panel, OpenAI Codex CLI TUI, GitHub Copilot Chat, Material 3 design tokens (public spec at m3.material.io).

---

## 1. Design principles

1. **Calm density.** A developer tool, not a marketing site. Whitespace is intentional, not luxurious. Every pixel should help the user read code, follow the agent's reasoning, or act on a pending change.
2. **Dark-first, high-contrast.** The default theme is dark. Text contrast ratio ≥ 7:1 for primary text (WCAG AAA), ≥ 4.5:1 for secondary text (WCAG AA). No grey-on-grey-on-grey.
3. **Restraint with color.** Color carries meaning. A new color earns its place by encoding a state the user must distinguish (success / warning / error / agent / user / tool). Decorative color is forbidden.
4. **Motion has purpose.** No decorative animations. Motion signals state change — a tool starts, a milestone pauses, a verification passes. Default duration 120ms; only the typing indicator and the streaming token cursor loop.
5. **Stock VS Code wins ties.** When the user's VS Code theme already does something well (editor selection, find widget, command palette), we don't re-implement it. We only theme our own two webviews.

---

## 2. Color tokens (dark theme)

All tokens are CSS custom properties on `:root` inside the webview. Names follow a `--kovix-<role>-<state>` convention so they're greppable.

### 2.1 Surfaces (Material 3 elevation, adapted)

Material 3 defines 5 elevation levels (0–5). We use 4 — Kovix panels rarely need the top level. Elevation in our context is encoded purely by background color + shadow (no Material 3 tonal overlay); VS Code webviews can't reliably blend with the host theme, so we use discrete values.

| Token | Value | Use |
|---|---|---|
| `--kovix-surface-0` | `#0e0f12` | Outermost panel background (the webview body) |
| `--kovix-surface-1` | `#15171b` | Cards, the message list container |
| `--kovix-surface-2` | `#1c1f24` | Tool call cards inside messages, the input box wrapper |
| `--kovix-surface-3` | `#252930` | Hover state on cards, active tab background |
| `--kovix-surface-overlay` | `rgba(255, 255, 255, 0.06)` | Modal overlays, dropdown backdrops |

### 2.2 Text

| Token | Value | Use | Contrast on surface-0 |
|---|---|---|---|
| `--kovix-text-primary` | `#e6e8ee` | Body text, message content | 14.6:1 (AAA) |
| `--kovix-text-secondary` | `#9aa0aa` | Timestamps, labels, metadata | 6.8:1 (AA+) |
| `--kovix-text-tertiary` | `#6b7178` | Placeholders, disabled | 4.0:1 (AA for large only) |
| `--kovix-text-on-accent` | `#0e0f12` | Text on the accent button | 14.6:1 (AAA) |
| `--kovix-text-code` | `#f0b4ff` | Inline code in messages | 9.4:1 (AAA) |

### 2.3 Accent (the "Kovix" color)

The accent is a muted indigo. It reads as "AI / agent" without being aggressive, and it sits comfortably next to VS Code's blue (which the user keeps on stock surfaces). Indigo is also distinct from VS Code's built-in activity bar blue (`#3794ff`) so the Kovix icon stands out without clashing.

| Token | Value | Use |
|---|---|---|
| `--kovix-accent` | `#7c83ff` | Send button, active states, focus rings |
| `--kovix-accent-hover` | `#9aa0ff` | Hover on accent-colored elements |
| `--kovix-accent-pressed` | `#6168e0` | Active/pressed on accent-colored elements |
| `--kovix-accent-faded` | `rgba(124, 131, 255, 0.16)` | Subtle highlight backgrounds (e.g. "agent is thinking" pulse) |
| `--kovix-accent-ring` | `rgba(124, 131, 255, 0.45)` | Focus ring (3px offset) |

### 2.4 Status colors

Standard Material 3 status palette, but tuned for dark surfaces. Each has a `bg` variant for chip / badge backgrounds.

| Token | Value | Use |
|---|---|---|
| `--kovix-success` | `#5ed387` | Verification passed, file accepted |
| `--kovix-success-bg` | `rgba(94, 211, 135, 0.14)` | Chip background for success states |
| `--kovix-warning` | `#f0c04a` | Verification unverified, milestone paused |
| `--kovix-warning-bg` | `rgba(240, 192, 74, 0.14)` | Chip background for warning states |
| `--kovix-error` | `#ff6b6b` | Verification failed, tool error, agent error |
| `--kovix-error-bg` | `rgba(255, 107, 107, 0.14)` | Chip background for error states |
| `--kovix-info` | `#5eb8ff` | "Tool started", "milestone reached" |
| `--kovix-info-bg` | `rgba(94, 184, 255, 0.14)` | Chip background for info states |

### 2.5 Roles (chat-specific)

These encode who said what in the chat transcript. The user is neutral (primary text); the agent gets the accent; tools get a code-blue.

| Token | Value | Use |
|---|---|---|
| `--kovix-role-user` | `--kovix-text-primary` | User messages |
| `--kovix-role-agent` | `--kovix-accent` | Agent messages (avatar, name) |
| `--kovix-role-tool` | `#5eb8ff` | Tool call cards (avatar, name) |
| `--kovix-role-system` | `--kovix-text-secondary` | System / status messages (paused, complete) |

---

## 3. Typography

VS Code webviews inherit the user's font stack via `var(--vscode-font-family)`. We use that as the base and only override weights + sizes. CJK fallback is the user's VS Code setting.

### 3.1 Type scale

| Token | Size | Weight | Line height | Use |
|---|---|---|---|---|
| `--kovix-text-xs` | `11px` | 500 | 1.45 | Timestamps, badge text |
| `--kovix-text-sm` | `12px` | 400 | 1.5 | Metadata, secondary labels |
| `--kovix-text-base` | `13px` | 400 | 1.55 | Body text, message content |
| `--kovix-text-md` | `14px` | 500 | 1.5 | Section headers, input text |
| `--kovix-text-lg` | `16px` | 600 | 1.4 | Panel title |
| `--kovix-text-xl` | `20px` | 600 | 1.3 | Empty-state headline |

Font family:
```css
font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif);
font-feature-settings: "cv01", "cv02", "cv03", "cv04", "ss01";
```

Code blocks (inside messages):
```css
--kovix-font-mono: var(--vscode-editor-font-family, "SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace);
```

### 3.2 Inline code

Inline code (e.g. `read_file`, `src/index.ts`) uses the mono stack at `0.92em` size, with a subtle background (`--kovix-surface-2`) and 3px horizontal padding + 1px vertical padding. No border — Material 3 prefers tonal separation over strokes.

---

## 4. Spacing & layout

A 4px base unit. All paddings / margins / gaps are multiples of 4. This is stricter than Material 3's 4dp grid (which allows 2dp exceptions); the strictness is intentional for a dense developer tool.

| Token | Value |
|---|---|
| `--kovix-space-1` | `4px` |
| `--kovix-space-2` | `8px` |
| `--kovix-space-3` | `12px` |
| `--kovix-space-4` | `16px` |
| `--kovix-space-5` | `20px` |
| `--kovix-space-6` | `24px` |
| `--kovix-space-8` | `32px` |

### 4.1 Component sizing

| Component | Height | Padding | Notes |
|---|---|---|---|
| Message bubble | auto | `--kovix-space-3` `--kovix-space-4` | Max width 88% of panel |
| Tool call card | auto | `--kovix-space-2` `--kovix-space-3` | Indented 32px under parent message |
| Input box | min 48px, max 240px | `--kovix-space-3` | Grows with content; scrollbar at max |
| Send button | 36×36px | n/a | Squircle (border-radius 10px) |
| Status chip | 22px | `0 --kovix-space-2` | Border-radius 11px (pill) |
| Section header | 36px | `0 --kovix-space-4` | Sticky top within scroll container |

---

## 5. Radius & elevation

Material 3 uses generous radii. We adapt down for density.

| Token | Value | Use |
|---|---|---|
| `--kovix-radius-sm` | `4px` | Inline code chips, small buttons |
| `--kovix-radius-md` | `8px` | Cards, tool call containers |
| `--kovix-radius-lg` | `12px` | Message bubbles, input wrapper |
| `--kovix-radius-pill` | `9999px` | Status chips, the send button (when circular) |

Shadow tokens are deliberately subtle — VS Code webviews sit on opaque surfaces, so deep shadows read as visual noise.

| Token | Value |
|---|---|
| `--kovix-shadow-1` | `0 1px 2px rgba(0, 0, 0, 0.3)` |
| `--kovix-shadow-2` | `0 2px 6px rgba(0, 0, 0, 0.35)` |
| `--kovix-shadow-3` | `0 6px 16px rgba(0, 0, 0, 0.4)` (used only for modals / popovers) |

Border preference: 1px solid `--kovix-surface-3` where a separator is needed. No borders on cards — they rely on tonal separation. (Exception: the input wrapper has a 1px border that changes color on focus.)

---

## 6. Motion

| Token | Duration | Easing | Use |
|---|---|---|---|
| `--kovix-motion-fast` | `80ms` | `cubic-bezier(0.4, 0, 0.2, 1)` | Hover, focus, button press |
| `--kovix-motion-normal` | `120ms` | `cubic-bezier(0.4, 0, 0.2, 1)` | Card appearance, chip state change |
| `--kovix-motion-slow` | `200ms` | `cubic-bezier(0.4, 0, 0.2, 1)` | Pending changes section expand/collapse |

Looping animations (only two):
- **Typing indicator:** three dots, 1.4s loop, 0.4s phase offset per dot, opacity 0.3 → 1 → 0.3. Pauses when the agent emits a token within the last 400ms.
- **Streaming cursor:** a 1px-wide `--kovix-accent` block at the end of the streaming token, blinking 1.06s loop (opacity 1 → 0 → 1, square wave). Stops when the agent's `done` event arrives.

`prefers-reduced-motion: reduce` disables both loops and collapses all transitions to 0ms.

---

## 7. Component specs

### 7.1 Message list

Vertical stack of message bubbles, `--kovix-space-4` gap. Each message has:
- **Avatar** (24×24px circle, role-colored, with a single glyph — `U` for user, `K` for Kovix agent, `⚙` for tool calls)
- **Header row** (role name + timestamp, `--kovix-text-xs`)
- **Body** (markdown-rendered, `--kovix-text-base`)

User messages align right with a `--kovix-surface-2` background. Agent messages align left with `--kovix-surface-1`. Tool call cards appear nested under the parent agent message, indented 32px, with a left border in `--kovix-role-tool`.

### 7.2 Tool call card

```
┌─[ tool ] read_file ─────────────────── ✓ 0.4s ─┐
│  ▸ path: src/extension.ts                       │
│  ─────────────────────────────────────────────  │
│  // file content (truncated, expandable)        │
└─────────────────────────────────────────────────┘
```

- Header: `⚙` icon + tool name (mono, `--kovix-role-tool` color) + status chip (✓ success / ✗ error / ⋯ running) + duration in `--kovix-text-tertiary`.
- Input args: collapsible, collapsed by default. Expanded shows JSON key/value pairs with mono font.
- Output: collapsible, expanded by default for `read_file` / `run_command`, collapsed for `write_file` / `edit_file`. Output is mono, max-height 240px with scroll.
- Clicking the header toggles both sections.

### 7.3 Plan approval card

Replaces the chat input while a plan is pending approval. Full-width card with `--kovix-surface-2` background and a 1px `--kovix-accent` left border.

```
┌─[ PLAN ]────────────────────────────────────────┐
│  Task: Read README.md and write a summary       │
│  ─────────────────────────────────────────────  │
│  Milestone 1: Read and understand README.md     │
│    1. [Read] README.md                          │
│                                                 │
│  Milestone 2: Write the summary                 │
│    2. [Create] SUMMARY.md                       │
│    3. [Run] npm test                            │
│  ─────────────────────────────────────────────  │
│  Autonomy: [Every ▾]   [Approve & Run]  [Cancel]│
└─────────────────────────────────────────────────┘
```

- Approve button uses `--kovix-accent` background + `--kovix-text-on-accent`.
- Cancel button is a ghost button (`--kovix-text-secondary` on `transparent`, hover `--kovix-surface-3`).
- Autonomy dropdown is a native `<select>` styled to match the chip aesthetic.

### 7.4 Milestone pause banner

Sticky, full-width, `--kovix-warning-bg` background, 1px `--kovix-warning` top border. Appears when `milestone_paused` event fires.

```
⏸ Paused at milestone: Read and understand README.md
  [Resume]  [Skip]  [Abort]
```

Three buttons: Resume (accent), Skip (ghost), Abort (error-ghost).

### 7.5 Verification chip

Inline chip after the milestone name. Three states:
- `passed` → `--kovix-success-bg` + `✓ Verified`
- `unverified` → `--kovix-warning-bg` + `? Unverified`
- `failed` → `--kovix-error-bg` + `✗ Failed` (with expandable output)

### 7.6 Pending changes section

Collapsible section at the bottom of the panel (above the input box). Collapsed by default; expands when a `file_written` event arrives. Header shows count: `Pending Changes (3)`. Each entry is a row with file path + action (new/edit) + Accept / Reject / View diff buttons.

### 7.7 Input box

Sticky at the bottom of the panel. Wrapper has `--kovix-surface-2` background, 1px `--kovix-surface-3` border, transitions to `--kovix-accent` border on focus. Inside: a `<textarea>` (auto-grow, max 240px) + send button (squircle, `--kovix-accent` background, `↑` glyph). `Enter` sends; `Shift+Enter` inserts newline. Disabled (opacity 0.5) while the agent is running; a "Stop" button replaces Send in that state.

---

## 8. Accessibility

- All interactive elements have visible focus rings (`--kovix-accent-ring`, 3px offset).
- Color is never the sole state indicator. Chips have a glyph (`✓`, `?`, `✗`, `⏸`) plus color.
- ARIA roles: `log` on the message list (live region, polite), `button` on all clickable cards, `status` on the typing indicator.
- Keyboard: `Tab` cycles through interactive elements in DOM order. `Enter` on a focused card toggles its collapsed state. `Escape` while typing in the input box blurs it; `Escape` while a plan is pending cancels the plan.
- Screen reader: streaming tokens are NOT announced individually (would be noise). The agent's final message is announced as a single live-region update.

---

## 9. Light theme (deferred)

Light theme tokens are stubbed here for v1.0-beta. The webview JS probes `body[data-vscode-theme-kind="light"]` and swaps the `:root` token block. Until v1.0-beta, light-theme users see the dark theme — acceptable per D-010.

```css
/* Stubbed — not shipped in v0.1-alpha. */
body[data-vscode-theme-kind="light"] {
  --kovix-surface-0: #ffffff;
  --kovix-surface-1: #f7f8fa;
  /* ... */
}
```

---

## 10. Token application map (cheat sheet)

For implementers — where each token is used in `agentPanel.css`:

| Token | Used in |
|---|---|
| `--kovix-surface-0` | `body`, `.kovix-panel` |
| `--kovix-surface-1` | `.message-list`, `.agent-message .bubble` |
| `--kovix-surface-2` | `.tool-card`, `.input-wrapper`, `.user-message .bubble` |
| `--kovix-surface-3` | `*:hover` on cards, `.section-header.active` |
| `--kovix-text-primary` | `.message-body`, `.input-wrapper textarea` |
| `--kovix-text-secondary` | `.timestamp`, `.tool-card .duration` |
| `--kovix-text-tertiary` | `.placeholder`, `:disabled` |
| `--kovix-accent` | `.send-button`, `.approve-button`, `:focus` outline |
| `--kovix-success` / `-bg` | `.chip.passed` |
| `--kovix-warning` / `-bg` | `.chip.unverified`, `.milestone-banner` |
| `--kovix-error` / `-bg` | `.chip.failed`, `.error-message`, `.abort-button` |
| `--kovix-info` / `-bg` | `.chip.running`, `.chip.tool-start` |
| `--kovix-role-user` | `.user-message .avatar`, `.user-message .name` |
| `--kovix-role-agent` | `.agent-message .avatar`, `.agent-message .name` |
| `--kovix-role-tool` | `.tool-card .avatar`, `.tool-card .name`, `.tool-card` left border |

---

## 11. Revisit

- **v1.0-beta:** Light theme tokens finalized. Pending changes may split into its own webview (per D-012 revisit clause).
- **v1.0-rc:** If user testing reveals the indigo accent is too close to a popular VS Code theme's accent (e.g. One Dark Pro's purple), consider shifting to teal or amber. Decision deferred until real-user feedback exists.
- **v1.0:** Animation budget review — if the typing indicator or streaming cursor reads as "busy" in user testing, slow them down or remove them.
