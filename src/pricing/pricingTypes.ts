/**
 * pricingTypes.ts — Type definitions for the cost/pricing module.
 *
 * Harvested from Kovix_2.0's pricingTypes.ts and creditSystem.ts,
 * stripped down for fresh's user-owned-keys, no-subscription architecture.
 *
 * What was removed from the original Kovix_2.0 version:
 *   - SubscriptionTier (Free/Pro/Team/Enterprise) — fresh has no subscription model
 *   - ISubscription, IPriceEstimate, IPricingAlert — subscription-specific
 *   - Stripe-related types — fresh doesn't have payment infrastructure
 *   - ICostGovernorService (old permissive stub) — already deleted per PR #147
 *
 * What's kept:
 *   - CreditActionType — drives the cost-per-call table
 *   - ICreditRule — budget enforcement rules
 *   - ICreditBudget — budget caps and warning thresholds
 *   - ICreditUsage — usage tracking records
 *
 * M-numbering note: Cost Governor is labeled S1 in 01_REQUIREMENTS.md
 * (SHOULD ship, not MUST). The M8 label was previously used for
 * Security Tools (DROPPED per D-008). To avoid semantic collision
 * if security tools are revived at v2.0, Cost Governor retains
 * its S1 label rather than reusing M8.
 *
 * Decisions referenced: D-008 (M8 dropped), harvest plan Step 4.
 */

// ---------------------------------------------------------------------------
// Credit action types
// ---------------------------------------------------------------------------

/**
 * Action type for credit billing. Drives the cost-per-call table.
 * Re-exported from agentLoopHelpers.ts for use by the pricing module.
 */
export type CreditActionType =
	| 'file_edit'
	| 'terminal_command'
	| 'browser_action'
	| 'tool_call'
	| 'llm_call';

// ---------------------------------------------------------------------------
// Credit rules
// ---------------------------------------------------------------------------

/**
 * A credit consumption rule. Each rule defines the cost (in credits)
 * for a specific action type, with an optional model multiplier
 * for premium models.
 */
export interface ICreditRule {
	/** The action type this rule applies to. */
	readonly actionType: CreditActionType;
	/** Base cost in credits for this action. Default: 1. */
	readonly baseCost: number;
	/** Model-specific multiplier. E.g., Claude Sonnet = 1.0, Opus = 3.0. */
	readonly modelMultiplier?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Budget configuration for credit spending enforcement.
 */
export interface ICreditBudget {
	/** Maximum credits per task execution. 0 = unlimited. */
	readonly maxCreditsPerTask: number;
	/** Warning threshold — fire onBudgetWarning when credits remaining < this %. Default: 20. */
	readonly warningThresholdPercent: number;
	/** Emergency stop threshold — block all LLM calls when credits remaining < this. Default: 10. */
	readonly emergencyStopThreshold: number;
	/** Whether budget enforcement is enabled. Default: true. */
	readonly enabled: boolean;
}

/**
 * Default budget configuration. Users can override via settings.
 */
export const DEFAULT_BUDGET: ICreditBudget = {
	maxCreditsPerTask: 0, // Unlimited by default
	warningThresholdPercent: 20,
	emergencyStopThreshold: 10,
	enabled: true,
};

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

/**
 * A single credit usage record. Stored in the usage log for
 * history and budget enforcement.
 */
export interface ICreditUsage {
	/** ISO 8601 timestamp of when the usage occurred. */
	readonly timestamp: string;
	/** Number of credits consumed. */
	readonly credits: number;
	/** The action type that consumed the credits. */
	readonly actionType: CreditActionType;
	/** The model used (if applicable). */
	readonly model?: string;
	/** The tool name (if applicable). */
	readonly toolName?: string;
	/** Session ID for grouping. */
	readonly sessionId?: string;
	/** Description of the usage. */
	readonly description?: string;
}

// ---------------------------------------------------------------------------
// BudgetExceededError
// ---------------------------------------------------------------------------

/**
 * Error thrown when a budget limit is exceeded. This provides clean
 * error propagation — callers can catch this specific error type
 * to handle budget exhaustion differently from other errors.
 *
 * This is the "make it loud" equivalent of checkCostGate() returning
 * { allowed: false }. While checkCostGate() is a polling check (call
 * before each LLM round), BudgetExceededError is thrown when a credit
 * consumption call fails — providing a synchronous error path.
 */
export class BudgetExceededError extends Error {
	public readonly creditsRemaining: number;
	public readonly budget: ICreditBudget;

	constructor(creditsRemaining: number, budget: ICreditBudget) {
		super(
			`Budget exceeded: only ${creditsRemaining} credits remaining. ` +
			`Emergency stop threshold is ${budget.emergencyStopThreshold}. ` +
			`Replenish credits or increase your budget to resume agent execution. ` +
			`Essential actions (file save, git commit, settings) remain available.`,
		);
		this.name = 'BudgetExceededError';
		this.creditsRemaining = creditsRemaining;
		this.budget = budget;
	}
}
