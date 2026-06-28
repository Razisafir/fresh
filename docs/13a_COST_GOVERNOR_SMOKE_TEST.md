# 13a — Cost Governor Manual Smoke-Test Scenario

**Date:** 2026-06-29
**Branch:** `harvest/full-run`
**Purpose:** Step-by-step manual test scenario for the Cost Governor feature. This test MUST be run by a human before the feature is considered verified. Automated tests confirm the logic; this scenario confirms the user-facing behavior.

**Status: PENDING — not yet run by a human.**

---

## Prerequisites

1. Kovix Electron app running (`npm start`)
2. An LLM provider configured with a valid API key (any provider)
3. A workspace folder opened

---

## Scenario 1: Low budget triggers emergency stop

**Setup:**
1. Open the app's settings
2. Set cost budget to a low value (e.g., `maxCreditsPerTask: 5`)
3. Enable budget enforcement

**Steps:**
1. Switch to Plan mode
2. Type a task that would require multiple tool calls, e.g.:
   > "Create three files: hello1.txt, hello2.txt, and hello3.txt, each containing 'hello world'"
3. Approve the plan
4. Watch execution proceed through the first few tool calls

**Expected behavior:**
- After ~5 credits are consumed, the agent should STOP with a clear message:
  > "Budget exceeded: only N credits remaining. Emergency stop threshold is 10. Replenish credits or increase your budget to resume agent execution. Essential actions (file save, git commit, settings) remain available."
- The agent loop should NOT continue making LLM calls
- The UI should show the error message in the chat stream
- The user should be able to dismiss the error and try again with a higher budget

**Pass criteria:**
- [ ] Agent stops when budget is exhausted (not continues silently)
- [ ] Error message is clear and actionable
- [ ] No silent failures — user is always informed

---

## Scenario 2: Auto-switch model recommendation at 20% remaining

**Setup:**
1. Set cost budget to a moderate value (e.g., `maxCreditsPerTask: 50`)
2. Enable budget enforcement
3. Use a premium model (e.g., Claude Sonnet 4)

**Steps:**
1. Run a task that consumes credits gradually
2. Watch for the model-switch recommendation in the console/logs

**Expected behavior:**
- When credits drop below 20% (10 remaining out of 50), a recommendation appears:
  > "[AgentLoop][CostGovernor] Credits low (<20% of allocation). Consider switching to claude-haiku-4-20250514 to conserve credits."
- The agent continues executing (this is a recommendation, not a block)
- The user can choose to switch models or continue

**Pass criteria:**
- [ ] Recommendation appears at the 20% threshold
- [ ] Suggested cheaper model is valid and available
- [ ] Agent does NOT stop — this is informational only

---

## Scenario 3: Budget disabled — unlimited spending

**Setup:**
1. Set budget enforcement to disabled
2. Do NOT set a maxCreditsPerTask value

**Steps:**
1. Run any task
2. Verify that credits are not tracked or limited

**Expected behavior:**
- All LLM calls proceed without any budget checks
- No "low credits" or "budget exceeded" messages appear
- Agent runs to completion normally

**Pass criteria:**
- [ ] No budget-related messages appear
- [ ] Agent completes the task normally
- [ ] Disabling the budget truly disables enforcement (not just hides it)

---

## Scenario 4: BudgetExceededError is catchable

**Setup:**
1. Open the developer console (Ctrl+Shift+I)
2. Set a low budget

**Steps:**
1. Run a task that exceeds the budget
2. Check the console for the error type

**Expected behavior:**
- The error thrown should be `BudgetExceededError`
- The error should have `.creditsRemaining` and `.budget` properties
- The error message should contain the remaining credit count and the emergency threshold

**Pass criteria:**
- [ ] Error type is `BudgetExceededError` (visible in console)
- [ ] Error properties are accessible
- [ ] Error message is human-readable

---

## Results

| Scenario | Run by | Date | Pass/Fail | Notes |
|----------|--------|------|-----------|-------|
| 1: Emergency stop | _pending_ | _pending_ | _pending_ | |
| 2: Auto-switch recommendation | _pending_ | _pending_ | _pending_ | |
| 3: Budget disabled | _pending_ | _pending_ | _pending_ | |
| 4: BudgetExceededError catchable | _pending_ | _pending_ | _pending_ | |

**This feature is NOT verified until a human runs these scenarios and records results above.**
