/**
 * costGovernor.ts — Concrete cost governor and credit system for Kovix.
 *
 * Implements the ICreditSystem and ICostGovernor interfaces from
 * agentLoopHelpers.ts. This is the production wiring that was deferred
 * in v0.1-alpha.
 *
 * Features:
 *   - Configurable credit allocation per session
 *   - Emergency stop when credits < 10
 *   - Auto-switch recommendation when credits < 20%
 *   - Cheaper model fallback table
 *   - Credit consumption logging for telemetry
 *
 * The cost governor MUST be wired before swarm ships (per 08_SWARM_DESIGN.md
 * §5: "swarm mode multiplies LLM cost by N — the cost governor MUST be
 * wired or the user could accidentally spend N× their expected API budget").
 */

import type { ICreditSystem, ICostGovernor, CreditActionType } from '../agent/agentLoopHelpers';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Credit System
// ---------------------------------------------------------------------------

export interface ICreditSystemConfig {
	/** Total credits allocated for this session. Default: 500. */
	totalCredits: number;
	/** Whether the credit system is enabled. Default: true. */
	enabled: boolean;
}

const DEFAULT_CREDIT_CONFIG: ICreditSystemConfig = {
	totalCredits: 500,
	enabled: true,
};

export class CreditSystem implements ICreditSystem {
	private _remaining: number;
	private readonly _config: ICreditSystemConfig;
	private readonly _log: Array<{ timestamp: number; amount: number; actionType: CreditActionType; metadata?: Record<string, string> }> = [];

	constructor(config?: Partial<ICreditSystemConfig>) {
		this._config = { ...DEFAULT_CREDIT_CONFIG, ...config };
		this._remaining = this._config.totalCredits;
	}

	getCreditsRemaining(): number {
		return this._remaining;
	}

	getTotalCredits(): number {
		return this._config.totalCredits;
	}

	isEnabled(): boolean {
		return this._config.enabled;
	}

	/**
	 * Consume credits for an action.
	 * @returns true if credits were consumed, false if insufficient.
	 */
	consumeCredits(
		amount: number,
		actionType: CreditActionType,
		metadata?: { agentType?: string; sessionId?: string | undefined; description?: string },
	): boolean {
		if (!this._config.enabled) return true; // No limit when disabled
		if (this._remaining < amount) {
			logger.warn(`[CreditSystem] Insufficient credits: ${this._remaining} remaining, ${amount} requested for ${actionType}`);
			return false;
		}
		this._remaining -= amount;
		this._log.push({
			timestamp: Date.now(),
			amount,
			actionType,
			metadata: metadata as Record<string, string> | undefined,
		});

		// Log when credits are getting low
		if (this._remaining <= this._config.totalCredits * 0.2) {
			logger.info(`[CreditSystem] Credits low: ${this._remaining}/${this._config.totalCredits} remaining`);
		}

		return true;
	}

	/**
	 * Add more credits to the allocation (e.g. when user upgrades).
	 */
	addCredits(amount: number): void {
		this._remaining += amount;
		this._config.totalCredits += amount;
		logger.info(`[CreditSystem] Credits added: +${amount}, now ${this._remaining}/${this._config.totalCredits}`);
	}

	/**
	 * Reset credits to the initial allocation.
	 */
	reset(): void {
		this._remaining = this._config.totalCredits;
		this._log.length = 0;
	}

	/**
	 * Get the consumption log for telemetry.
	 */
	getLog(): ReadonlyArray<{ timestamp: number; amount: number; actionType: CreditActionType }> {
		return this._log;
	}

	/**
	 * Get usage statistics.
	 */
	getStats(): { totalConsumed: number; byActionType: Record<string, number> } {
		let totalConsumed = 0;
		const byActionType: Record<string, number> = {};
		for (const entry of this._log) {
			totalConsumed += entry.amount;
			byActionType[entry.actionType] = (byActionType[entry.actionType] ?? 0) + entry.amount;
		}
		return { totalConsumed, byActionType };
	}
}

// ---------------------------------------------------------------------------
// Cost Governor
// ---------------------------------------------------------------------------

/**
 * Model fallback table: when credits are low, the cost governor can
 * recommend switching to a cheaper model.
 *
 * Maps model prefixes to cheaper alternatives.
 */
const MODEL_FALLBACK_TABLE: Record<string, string> = {
	'anthropic/claude-opus': 'anthropic/claude-sonnet',
	'anthropic/claude-sonnet': 'anthropic/claude-haiku',
	'openai/gpt-4': 'openai/gpt-4o-mini',
	'openai/gpt-4o': 'openai/gpt-4o-mini',
	'meta/llama-3.3-70b': 'meta/llama-3.1-8b',
	'nvidia/nemotron': 'nvidia/nemotron-3-nano-30b-a3b:free',
};

export class CostGovernor implements ICostGovernor {
	constructor(
		private readonly _creditSystem: CreditSystem,
		private readonly _emergencyThreshold: number = 10,
		private readonly _lowCreditPercent: number = 0.2,
	) {}

	isEmergencyMode(): boolean {
		if (!this._creditSystem.isEnabled()) return false;
		return this._creditSystem.getCreditsRemaining() < this._emergencyThreshold;
	}

	shouldAutoSwitchModel(): boolean {
		if (!this._creditSystem.isEnabled()) return false;
		const remaining = this._creditSystem.getCreditsRemaining();
		const total = this._creditSystem.getTotalCredits();
		return (remaining / total) < this._lowCreditPercent;
	}

	getCheaperModel(currentModel: string): string | undefined {
		// Try exact match first
		if (MODEL_FALLBACK_TABLE[currentModel]) {
			return MODEL_FALLBACK_TABLE[currentModel];
		}
		// Try prefix match
		for (const [prefix, fallback] of Object.entries(MODEL_FALLBACK_TABLE)) {
			if (currentModel.startsWith(prefix)) {
				return fallback;
			}
		}
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _creditSystem: CreditSystem | undefined;
let _costGovernor: CostGovernor | undefined;

export function getCreditSystem(): CreditSystem {
	if (!_creditSystem) {
		_creditSystem = new CreditSystem();
	}
	return _creditSystem;
}

export function getCostGovernor(): CostGovernor {
	if (!_costGovernor) {
		_costGovernor = new CostGovernor(getCreditSystem());
	}
	return _costGovernor;
}

export function initCostGovernor(config?: Partial<ICreditSystemConfig>): { creditSystem: CreditSystem; costGovernor: CostGovernor } {
	_creditSystem = new CreditSystem(config);
	_costGovernor = new CostGovernor(_creditSystem);
	return { creditSystem: _creditSystem, costGovernor: _costGovernor };
}
