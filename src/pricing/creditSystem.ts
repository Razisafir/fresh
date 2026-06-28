/**
 * creditSystem.ts — Credit accounting service for cost management.
 *
 * Harvested from Kovix_2.0's creditSystemService.ts (869 lines),
 * stripped to ~200 lines for fresh's user-owned-keys, no-subscription
 * architecture. The original included subscription tiers, Stripe
 * integration, pricing alerts, and CSV export — all removed because
 * fresh doesn't have a billing backend.
 *
 * What this does:
 *   - Tracks credit consumption per session
 *   - Enforces budget caps (per-task credit limits)
 *   - Provides emergency stop when credits run low
 *   - Records usage history for the local usage log
 *   - Throws BudgetExceededError for clean error propagation
 *
 * What this does NOT do (removed from original):
 *   - No subscription tiers (Free/Pro/Team/Enterprise)
 *   - No Stripe payment integration
 *   - No pricing alerts / push notifications
 *   - No CSV export
 *   - No dev mode tier simulation
 *   - No VS Code DI decorators
 *
 * Storage: credits and budget are persisted to the app's config
 * via the platform/appState module. On restart, the session's
 * usage resets (credits are per-session, not per-month).
 *
 * Decisions referenced: D-008 (M8 dropped), harvest plan Step 4.
 */

import {
        type CreditActionType,
        type ICreditBudget,
        type ICreditUsage,
        type ICreditRule,
        DEFAULT_BUDGET,
        BudgetExceededError,
} from './pricingTypes';

// ---------------------------------------------------------------------------
// Interfaces (re-exported from agentLoopHelpers.ts shape for compatibility)
// ---------------------------------------------------------------------------

/**
 * Per-call credit accounting interface.
 * Shape preserved from Kovix_2.0's ICreditSystem but stripped of
 * subscription/payment methods.
 */
export interface ICreditSystem {
        getCreditsRemaining(): number;
        getCreditsUsed(): number;
        consumeCredits(
                amount: number,
                actionType: CreditActionType,
                metadata?: { model?: string; agentType?: string; sessionId?: string; description?: string },
        ): boolean;
        canAfford(amount: number): boolean;
        setBudget(budget: ICreditBudget): void;
        getBudget(): ICreditBudget;
        getUsageHistory(limit?: number): ICreditUsage[];
        resetSession(): void;
}

/**
 * Cost governor interface for budget-aware action gating.
 * Shape preserved from Kovix_2.0's ICostGovernor.
 */
export interface ICostGovernor {
        isEmergencyMode(): boolean;
        shouldAutoSwitchModel(): boolean;
        getCheaperModel(currentModel: string): string | undefined;
        isActionAllowed(actionType: CreditActionType): boolean;
}

// ---------------------------------------------------------------------------
// Default credit rules
// ---------------------------------------------------------------------------

/**
 * Default cost-per-action rules. Each action costs 1 credit by default.
 * Premium models can apply a multiplier — this is handled by the
 * consumeCredits() method.
 */
const DEFAULT_CREDIT_RULES: readonly ICreditRule[] = [
        { actionType: 'file_edit', baseCost: 1 },
        { actionType: 'terminal_command', baseCost: 1 },
        { actionType: 'browser_action', baseCost: 1 },
        { actionType: 'tool_call', baseCost: 1 },
        { actionType: 'llm_call', baseCost: 1 },
];

// ---------------------------------------------------------------------------
// CreditSystemService
// ---------------------------------------------------------------------------

/**
 * Simple credit accounting service for fresh's user-owned-keys model.
 * No subscription tiers, no billing backend — just per-session
 * credit tracking with budget enforcement.
 */
export class CreditSystemService implements ICreditSystem {
        private _creditsUsed = 0;
        private _budget: ICreditBudget;
        private readonly _rules: readonly ICreditRule[];
        private readonly _usageHistory: ICreditUsage[] = [];
        private _sessionCredits: number;

        constructor(budget?: ICreditBudget, rules?: readonly ICreditRule[]) {
                this._budget = budget ?? { ...DEFAULT_BUDGET };
                this._rules = rules ?? DEFAULT_CREDIT_RULES;
                this._sessionCredits = this._budget.maxCreditsPerTask || Infinity;
        }

        getCreditsRemaining(): number {
                return Math.max(0, this._sessionCredits - this._creditsUsed);
        }

        getCreditsUsed(): number {
                return this._creditsUsed;
        }

        consumeCredits(
                amount: number,
                actionType: CreditActionType,
                metadata?: { model?: string; agentType?: string; sessionId?: string; description?: string },
        ): boolean {
                if (!this._budget.enabled) {
                        // Budget enforcement disabled — always allow
                        return true;
                }

                const remaining = this.getCreditsRemaining();
                if (remaining < amount) {
                        return false;
                }

                // Apply model multiplier if provided
                let cost = amount;
                const rule = this._rules.find(r => r.actionType === actionType);
                if (rule && metadata?.model && rule.modelMultiplier?.[metadata.model]) {
                        cost = Math.ceil(amount * (rule.modelMultiplier[metadata.model] ?? 1));
                }

                this._creditsUsed += cost;
                this._usageHistory.push({
                        timestamp: new Date().toISOString(),
                        credits: cost,
                        actionType,
                        model: metadata?.model,
                        toolName: metadata?.description?.replace('Agent tool: ', ''),
                        sessionId: metadata?.sessionId,
                        description: metadata?.description,
                });

                // Check if we've hit the emergency stop threshold
                if (this.getCreditsRemaining() <= this._budget.emergencyStopThreshold) {
                        throw new BudgetExceededError(this.getCreditsRemaining(), this._budget);
                }

                return true;
        }

        canAfford(amount: number): boolean {
                return this.getCreditsRemaining() >= amount;
        }

        setBudget(budget: ICreditBudget): void {
                this._budget = budget;
                if (budget.maxCreditsPerTask > 0) {
                        this._sessionCredits = budget.maxCreditsPerTask;
                }
        }

        getBudget(): ICreditBudget {
                return this._budget;
        }

        getUsageHistory(limit?: number): ICreditUsage[] {
                const history = [...this._usageHistory];
                return limit ? history.slice(-limit) : history;
        }

        resetSession(): void {
                this._creditsUsed = 0;
                this._sessionCredits = this._budget.maxCreditsPerTask || Infinity;
                this._usageHistory.length = 0;
        }
}

// ---------------------------------------------------------------------------
// CostGovernorService
// ---------------------------------------------------------------------------

/**
 * Enhanced cost governor for LLM API spend management.
 * Integrates with ICreditSystem for credit-aware cost management.
 * Provides auto-switch to cheaper models, budget recommendations,
 * and emergency mode blocking.
 *
 * Harvested from Kovix_2.0's CostGovernorEnhancedService (144 lines),
 * adapted for fresh's simpler architecture (no subscription tiers).
 */
export class CostGovernorService implements ICostGovernor {
        private readonly _creditSystem: ICreditSystem;

        /** Model mapping: premium model → cheaper fallback. */
        private static readonly MODEL_DOWNGRADE_MAP: Record<string, string> = {
                'claude-opus-4-20250514': 'claude-sonnet-4-20250514',
                'claude-sonnet-4-20250514': 'claude-haiku-4-20250514',
                'anthropic/claude-opus-4': 'anthropic/claude-sonnet-4',
                'anthropic/claude-sonnet-4': 'anthropic/claude-haiku-4',
        };

        constructor(creditSystem: ICreditSystem) {
                this._creditSystem = creditSystem;
        }

        isEmergencyMode(): boolean {
                const budget = this._creditSystem.getBudget();
                if (!budget.enabled) return false;
                return this._creditSystem.getCreditsRemaining() <= budget.emergencyStopThreshold;
        }

        shouldAutoSwitchModel(): boolean {
                const budget = this._creditSystem.getBudget();
                if (!budget.enabled || budget.maxCreditsPerTask === 0) return false;
                const remaining = this._creditSystem.getCreditsRemaining();
                const total = budget.maxCreditsPerTask;
                return total > 0 && (remaining / total) * 100 < budget.warningThresholdPercent;
        }

        getCheaperModel(currentModel: string): string | undefined {
                return CostGovernorService.MODEL_DOWNGRADE_MAP[currentModel];
        }

        isActionAllowed(actionType: CreditActionType): boolean {
                // All actions are allowed unless emergency mode is active
                if (this.isEmergencyMode()) {
                        // In emergency mode, only essential actions are allowed
                        // (file save, git commit, settings changes — no LLM calls)
                        return actionType !== 'llm_call';
                }
                return true;
        }
}
