# 07B — Design System Refinement, Round 1 (PROPOSAL — NOT IMPLEMENTED)

> **Status: PROPOSAL for lead review.** Per Phase 7-B prompt: "Propose changes
> as a diff-style description first (before/after per element) so I can react
> before you implement. Don't rewrite everything at once — this should be 2-3
> rounds." This is round 1. No CSS/HTML/JS changes have been made. Once you
> react, I implement the approved subset in round 2.

Reference: `docs/04_DESIGN_SYSTEM.md` (current Material 3 dark-first tokens)
and `src/ui/webview/agentPanel.{css,html,js}`.

Goal: move the feel from "functional VS Code webview" toward Cursor/Codex-grade
polish, WITHOUT leaving the locked constraints:
- **D-012** — exactly 2 webview surfaces, no custom file explorer/editor/terminal
- **D-010** — vanilla JS/CSS, no framework

**Constraint check:** D-010's "no framework" reasoning was timeline-driven
("we don't have time to set up React + Tailwind for v0.1-alpha"). We're now
past alpha. **My flag:** D-010 should still hold for v1.0 — vanilla JS/CSS is
working, the webview is ~720 lines of JS + ~920 lines of CSS, well within
maintainable range. A framework migration would be 2-3 weeks of work for
marginal benefit. Revisit at v2.0 if the webview grows past ~2000 lines of JS.

---

## Element 1: Message bubbles

### Current state (agentPanel.css §4, lines 234–364)

- Both user and agent bubbles: `border-radius: var(--kovix-radius-lg)` (12px)
- Tail corner: user = `border-top-right-radius: 4px`, agent = `border-top-left-radius: 4px`
  (the classic iMessage "speech bubble tail" affectation)
- `max-width: 88%` of message list
- User bubble bg = `--kovix-surface-2` (#1c1f24), agent bubble bg = `--kovix-surface-1` (#15171b)
- No border on either bubble
- `animation: message-in 120ms` (opacity 0→1, translateY 4px→0)

### Proposed (Round 1)

**Before:**
```css
.message.user .bubble {
  background: var(--kovix-surface-2);
  border-top-right-radius: var(--kovix-radius-sm);  /* tail */
  max-width: 88%;
}
.message.agent .bubble {
  background: var(--kovix-surface-1);
  border-top-left-radius: var(--kovix-radius-sm);   /* tail */
  max-width: 88%;
}
```

**After:**
```css
.message.user .bubble {
  background: var(--kovix-surface-2);
  border: 1px solid var(--kovix-surface-3);          /* new: definition */
  border-radius: var(--kovix-radius-lg);             /* full radius, no tail */
  max-width: 92%;                                    /* slightly wider */
}
.message.agent .bubble {
  background: var(--kovix-surface-1);
  border: 1px solid var(--kovix-surface-3);          /* new: definition */
  border-radius: var(--kovix-radius-lg);             /* full radius, no tail */
  max-width: 92%;
}
```

**Why:** The 4px tail corner is a dated iMessage affectation. Cursor, ChatGPT,
and Claude.ai have all moved away from it. Fully-rounded bubbles with a 1px
border read as more modern and give the bubbles definition against the
surface-0 background (which they currently lack — the agent bubble is
surface-1 on surface-0, a 1-step elevation that's almost invisible).

**Tradeoff:** Slightly less "chat-like", slightly more "card-like". I think
that's the right direction for a developer tool. If you disagree, we can keep
the tail and just add the border.

---

## Element 2: Plan-approval card (THE most important visual moment)

### Current state (agentPanel.css §6, lines 443–570)

- `background: var(--kovix-surface-2)`
- `border-left: 3px solid var(--kovix-accent)` (notification-banner pattern)
- `border-radius: var(--kovix-radius-md)` (8px)
- `padding: var(--kovix-space-4)` (16px)
- "PLAN" label in accent uppercase, 11px, letter-spacing 0.08em
- Task in primary text, 14px, weight 500
- Milestones listed as `milestone-block` with `plan-step` rows
- `.plan-actions` row: autonomy-select (left) + approve-button + cancel-button (right)
- Approve button: accent bg, on-accent text, 8px 16px padding, weight 600
- Cancel button: transparent bg, secondary text, hover = surface-3
- Animation: reuses `message-in` (opacity + 4px translateY)

### Proposed (Round 1)

**Before:**
```css
.plan-card {
  background: var(--kovix-surface-2);
  border-left: 3px solid var(--kovix-accent);
  border-radius: var(--kovix-radius-md);
  padding: var(--kovix-space-4);
  animation: message-in var(--kovix-motion-normal) var(--kovix-easing);
}
.plan-card .approve-button {
  padding: var(--kovix-space-2) var(--kovix-space-4);   /* 8px 16px */
  font-weight: 600;
}
```

**After:**
```css
.plan-card {
  background: var(--kovix-surface-2);
  border: 1px solid var(--kovix-surface-3);            /* full border, not just left */
  border-radius: var(--kovix-radius-lg);               /* 12px, matches bubbles */
  padding: var(--kovix-space-5);                       /* 20px, slightly more breathing room */
  box-shadow: var(--kovix-shadow-2);                   /* new: elevates above message stream */
  animation: plan-card-in var(--kovix-motion-slow) var(--kovix-easing);  /* dedicated keyframe */
  position: relative;
  overflow: hidden;
}
/* Accent gradient strip at top — marks this as the active decision */
.plan-card::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: linear-gradient(90deg,
    var(--kovix-accent) 0%,
    var(--kovix-accent-hover) 100%);
}
.plan-card .plan-label {
  /* unchanged */
}
.plan-card .plan-meta {                                 /* new element */
  font-size: var(--kovix-text-xs);
  color: var(--kovix-text-tertiary);
  margin-left: auto;                                    /* sits next to PLAN label */
}
.plan-card .approve-button {
  padding: var(--kovix-space-3) var(--kovix-space-5);  /* 12px 20px — bigger, more confident */
  font-weight: 700;                                     /* bolder */
  box-shadow: var(--kovix-shadow-1);                   /* subtle lift */
}
.plan-card .plan-shortcut-hint {                       /* new element */
  font-size: var(--kovix-text-xs);
  color: var(--kovix-text-tertiary);
  margin-left: var(--kovix-space-2);
}

@keyframes plan-card-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0)   scale(1); }
}
```

**HTML additions** (in `agentPanel.html` or generated by `agentPanel.ts`):
- `<span class="plan-meta">1 of {N} milestones</span>` next to the PLAN label
- `<span class="plan-shortcut-hint">Enter ↵ approve · Esc cancel</span>` next to the buttons

**JS additions** (in `agentPanel.js`):
- Keydown listener on the plan-card: Enter = approve, Esc = cancel
  (only when plan-card is visible; remove listener on dismiss)

**Why:**
- The 3px left-border is a **notification banner** pattern (Slack, GitHub
  issue comments). The plan-approval moment is not a notification — it's a
  **decision point**. Full border + shadow + gradient strip = "this is the
  active thing demanding your attention", not "fyi here's a card".
- The approve button at 8px/16px is the same size as every other button.
  It should be the **biggest, boldest** button on screen at that moment.
- The "1 of N" meta tells the user the scope of what they're approving
  without making them count milestones.
- Keyboard shortcuts match VS Code's command-palette convention (Enter to
  confirm, Esc to cancel). The hint is small but visible.

**This is the single most important change in round 1.** The plan-approval
card is the visual moment that defines the product's value prop ("you stay
in control"). Currently it looks like a Slack notification. It should look
like a moment.

---

## Element 3: Tool-call cards (collapsed/expanded)

### Current state (agentPanel.css §5, lines 385–437)

- `background: var(--kovix-surface-2)`
- `border-left: 2px solid var(--kovix-role-tool)` (blue, #5eb8ff)
- `border-radius: var(--kovix-radius-md)` (8px)
- Hover: bg → surface-3
- Collapsed: `.tool-detail { display: none }` (instant, no animation)
- Chevron: 12px, rotates -90deg when collapsed
- `.tool-detail`: monospace, 12px, max-height 240px, scroll, white-space pre-wrap

### Proposed (Round 1)

**Before:**
```css
.tool-card {
  margin-left: var(--kovix-space-8);
  background: var(--kovix-surface-2);
  border-left: 2px solid var(--kovix-role-tool);
  border-radius: var(--kovix-radius-md);
}
.tool-card.collapsed .tool-detail { display: none; }
.tool-card .chevron { width: 12px; height: 12px; }
```

**After:**
```css
.tool-card {
  margin-left: var(--kovix-space-8);
  background: var(--kovix-surface-2);
  border: 1px solid var(--kovix-surface-3);            /* full border, drop left-only */
  border-radius: var(--kovix-radius-md);
}
/* Status dot replaces the left-border color encoding */
.tool-card .tool-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--kovix-info);                       /* running = blue */
  flex-shrink: 0;
}
.tool-card.success .tool-status-dot {
  background: var(--kovix-success);
  animation: none;
}
.tool-card.error .tool-status-dot {
  background: var(--kovix-error);
}
.tool-card.running .tool-status-dot {
  animation: dot-pulse 1.4s var(--kovix-easing) infinite;
}
@keyframes dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.5; transform: scale(0.85); }
}

/* Collapsed state: 1-line preview instead of fully hidden */
.tool-card.collapsed .tool-detail {
  display: block;
  max-height: 0;
  overflow: hidden;
  padding: 0 var(--kovix-space-3);
  opacity: 0;
  transition: max-height var(--kovix-motion-normal) var(--kovix-easing),
              opacity var(--kovix-motion-normal) var(--kovix-easing),
              padding var(--kovix-motion-normal) var(--kovix-easing);
}
.tool-card:not(.collapsed) .tool-detail {
  max-height: 500px;
  opacity: 1;
  padding: var(--kovix-space-3);
  transition: max-height var(--kovix-motion-slow) var(--kovix-easing),
              opacity var(--kovix-motion-normal) var(--kovix-easing),
              padding var(--kovix-motion-normal) var(--kovix-easing);
}
.tool-card.collapsed .tool-preview {                   /* new: 1-line preview */
  display: block;
  font-family: var(--kovix-font-mono);
  font-size: var(--kovix-text-xs);
  color: var(--kovix-text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 var(--kovix-space-3) var(--kovix-space-2);
  max-width: 100%;
}
.tool-card:not(.collapsed) .tool-preview { display: none; }

.tool-card .chevron { width: 14px; height: 14px; }    /* slightly bigger */
```

**HTML/JS changes:**
- Add `<span class="tool-status-dot"></span>` before the tool name
- Add `<div class="tool-preview">{first 80 chars of detail}</div>` after `.tool-detail`
- Toggle `.success` / `.error` / `.running` classes on `.tool-card` based on `tool_result` event

**Why:**
- The 2px left-border is thin and easy to miss. A status dot is a stronger
  affordance and encodes state (running/success/error) which the current
  left-border doesn't (it's always blue).
- `display: none` → `max-height` transition gives a smooth expand/collapse
  instead of an instant jump. Cursor and Codex both animate this.
- The 1-line preview lets the user scan tool calls without expanding each
  one. For `run_command`, the preview shows the command; for `read_file`,
  the first line of the file; for `write_file`, the path. Big UX win for
  scrolling through a long agent run.

---

## Element 4: Input box focus state

### Current state (agentPanel.css §9, lines 763–825)

- Wrapper: surface-2 bg, 1px surface-3 border, 12px radius
- `:focus-within`: border-color → accent, 3px accent-ring box-shadow
- Textarea: 24px min-height, 240px max-height, auto-grow via JS
- Send button: 32x32 accent square, becomes red "stop" button while running

### Proposed (Round 1)

**Before:**
```css
.input-wrapper {
  background: var(--kovix-surface-2);
  border: 1px solid var(--kovix-surface-3);
  border-radius: var(--kovix-radius-lg);
  transition: border-color 80ms, box-shadow 80ms;
}
.input-wrapper:focus-within {
  border-color: var(--kovix-accent);
  box-shadow: 0 0 0 3px var(--kovix-accent-ring);
}
```

**After:**
```css
.input-wrapper {
  background: var(--kovix-surface-2);
  border: 1px solid var(--kovix-surface-3);
  border-radius: var(--kovix-radius-lg);
  transition: border-color 80ms, box-shadow 80ms, border-width 80ms;
  position: relative;
}
.input-wrapper:focus-within {
  border-color: var(--kovix-accent);
  border-width: 1.5px;                                 /* thicker on focus */
  box-shadow: 0 0 0 3px var(--kovix-accent-ring),
              var(--kovix-shadow-1);                   /* new: subtle lift */
}
/* Bottom accent line — grows from center on focus (Material 3 text-field pattern) */
.input-wrapper::after {
  content: "";
  position: absolute;
  bottom: -1px;
  left: 50%;
  right: 50%;
  height: 2px;
  background: var(--kovix-accent);
  border-radius: 1px;
  transition: left 160ms var(--kovix-easing),
              right 160ms var(--kovix-easing);
}
.input-wrapper:focus-within::after {
  left: 12px;
  right: 12px;
}
```

**Why:**
- The 3px ring is good but the wrapper doesn't "lift". Adding shadow-1 on
  focus gives it a subtle elevation that separates it from the message-list
  background.
- The 1.5px border on focus is a small detail that reads as "more confident"
  without being heavy.
- The bottom accent line that grows from center is a Material 3 text-field
  pattern. It's a small detail but it's the kind of thing that makes a UI
  feel "designed" rather than "functional". Cursor has a similar effect on
  its composer input.

**Tradeoff:** The `::after` pseudo-element requires `position: relative` on
the wrapper and `overflow: visible`. The wrapper already has `overflow:
hidden` for the border-radius — I'll need to verify the send button still
clips correctly. If it breaks, drop the `::after` line and keep just the
shadow + border-width changes.

---

## Element 5: Motion / transitions (current state + gaps)

### Current state

- Tokens: `--kovix-motion-fast: 80ms`, `--kovix-motion-normal: 120ms`,
  `--kovix-motion-slow: 200ms`. Easing: `cubic-bezier(0.4, 0, 0.2, 1)`.
- Animations: `message-in` (120ms), `banner-in` (120ms), `cursor-blink`
  (1.06s loop), `thinking-pulse` (1.4s loop)
- Transitions: 80ms on hover/focus color + background changes, 200ms on
  pending-changes section expand
- Reduced-motion media query disables all of it

### Gaps (what's missing)

| Element | Current | Should be |
|---------|---------|-----------|
| Tool-card expand/collapse | `display: none` (instant) | `max-height` transition (200ms) — see Element 3 |
| Plan-card appear | reuses `message-in` | dedicated `plan-card-in` with scale (200ms) — see Element 2 |
| Message-list scroll-to-bottom | instant jump | `scroll-behavior: smooth` on the container |
| Streaming cursor | hard blink (opacity 0/1) | gradient shimmer sweep (more "alive") |
| Tool-card status change (running → success) | instant color flip | 120ms color transition on the status dot |
| Pending-changes Accept/Reject buttons | no press feedback | `transform: translateY(1px)` on `:active` (matches approve button) |

### Proposed additions (Round 1)

```css
.kovix-root .message-list {
  scroll-behavior: smooth;                              /* new */
}

.kovix-root .streaming-cursor {
  /* was: solid blink */
  background: linear-gradient(90deg,
    transparent 0%,
    var(--kovix-accent) 50%,
    transparent 100%);
  background-size: 200% 100%;
  animation: cursor-shimmer 1.06s linear infinite;
}
@keyframes cursor-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.kovix-root .tool-card .tool-status-dot {
  transition: background-color var(--kovix-motion-normal) var(--kovix-easing);
}

.kovix-root .pending-changes .accept-button:active,
.kovix-root .pending-changes .reject-button:active {
  transform: translateY(1px);
}
```

**Why:** Motion should signal state change. The current motion design covers
the basics (messages arrive, banners arrive, cursor blinks) but misses several
state changes that feel "dead" (instant tool-card expand, instant status
flip, instant scroll). Filling these gaps brings the UI from "functional" to
"responsive" without adding decorative motion (which the design principles
explicitly forbid).

---

## Round 1 scope summary

| Element | Change | Effort | Risk |
|---------|--------|--------|------|
| 1. Message bubbles | Drop tail, add 1px border, widen to 92% | 5 min | Very low — pure CSS |
| 2. Plan-approval card | Full border + shadow + gradient strip + bigger Approve + plan-meta + shortcut hint + dedicated keyframe + keyboard shortcuts | 30 min | Low — CSS + small JS for keydown |
| 3. Tool-call cards | Status dot, animated expand/collapse, 1-line preview | 25 min | Low — CSS + small JS for class toggles + preview text |
| 4. Input box focus | Shadow-1, 1.5px border, bottom accent line | 10 min | Low — pure CSS, one `::after` to verify |
| 5. Motion gaps | smooth scroll, cursor shimmer, status-dot transition, button press feedback | 10 min | Very low — pure CSS |

**Total round 1 effort:** ~80 minutes of implementation (after your approval).

**What round 1 explicitly does NOT do:**
- Drop bubbles entirely for agent messages (Cursor-style) — that's a round 2 conversation
- Add light theme — that's Phase 7-C (separate doc)
- Change the color palette — palette is locked from `04_DESIGN_SYSTEM.md`
- Add any new webview surfaces (D-012 holds)
- Introduce a framework (D-010 holds)

---

## What I need from you

React to each of the 5 elements independently. For each, any of:
- "Ship as proposed"
- "Ship with this change: ____"
- "Skip for round 1, revisit in round 2"
- "Hard no — here's why: ____"

Once I have your reactions, I implement the approved subset in round 2,
re-run all 5 gates, and commit. Then we can do a round 3 if needed.
