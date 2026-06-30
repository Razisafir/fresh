/**
 * errorRecovery.ts — Agent error recovery: retry / skip / abort classification.
 *
 * This was deferred in v0.1 ("AgentErrorRecovery — deferred to v1.0") but
 * is needed for robust swarm execution where workers may fail.
 *
 * Strategy:
 *   - Classify errors into retryable / skippable / fatal
 *   - Retryable: network timeouts, rate limits (429), transient IPC failures
 *   - Skippable: file not found (can continue without), permission denied on non-critical file
 *   - Fatal: auth errors, credit exhaustion, workspace boundary violations
 *
 * For swarm: when a worker hits a retryable error, we retry up to N times.
 * When a worker hits a skippable error, we skip the current step and continue.
 * When a worker hits a fatal error, we abort the worker.
 */

import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorClassification = 'retry' | 'skip' | 'abort';

export interface IErrorRecoveryResult {
	classification: ErrorClassification;
	/** Number of retries remaining (only for 'retry'). */
	retriesRemaining: number;
	/** Delay before next retry in ms (only for 'retry'). */
	retryDelayMs: number;
	/** Human-readable reason for the classification. */
	reason: string;
}

export interface IErrorRecoveryConfig {
	/** Maximum number of retries for retryable errors. Default: 3. */
	maxRetries: number;
	/** Base delay for exponential backoff (ms). Default: 1000. */
	baseRetryDelayMs: number;
	/** Maximum retry delay cap (ms). Default: 30000. */
	maxRetryDelayMs: number;
}

const DEFAULT_CONFIG: IErrorRecoveryConfig = {
	maxRetries: 3,
	baseRetryDelayMs: 1000,
	maxRetryDelayMs: 30000,
};

// ---------------------------------------------------------------------------
// Error patterns
// ---------------------------------------------------------------------------

/** Patterns that indicate a retryable (transient) error. */
const RETRYABLE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{ pattern: /429|rate.?limit|too many requests/i, reason: 'Rate limited — will retry after backoff' },
	{ pattern: /timeout|timed? ?out|ETIMEDOUT/i, reason: 'Request timed out — will retry' },
	{ pattern: /ECONNRESET|ECONNREFUSED|ENOTFOUND/i, reason: 'Network error — will retry' },
	{ pattern: /socket hang up|premature close/i, reason: 'Connection dropped — will retry' },
	{ pattern: /overloaded|capacity|temporarily unavailable/i, reason: 'Provider overloaded — will retry' },
	{ pattern: /500|502|503|504|internal server error/i, reason: 'Server error — will retry' },
];

/** Patterns that indicate a skippable (non-fatal) error. */
const SKIPPABLE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{ pattern: /ENOENT|file not found|no such file/i, reason: 'File not found — skipping step' },
	{ pattern: /EISDIR|is a directory/i, reason: 'Expected file but got directory — skipping' },
	{ pattern: /empty directory|no entries/i, reason: 'Directory is empty — skipping' },
];

/** Patterns that indicate a fatal (abort) error. */
const FATAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
	{ pattern: /401|403|unauthorized|forbidden|invalid api key|authentication/i, reason: 'Authentication error — aborting' },
	{ pattern: /insufficient credits|credit governor emergency/i, reason: 'Credits exhausted — aborting' },
	{ pattern: /SEC-4|workspace boundary|path traversal/i, reason: 'Security violation — aborting' },
	{ pattern: /SEC-6|prompt injection|sanitiser/i, reason: 'Security violation — aborting' },
	{ pattern: /abort|cancelled|cancel/i, reason: 'Operation cancelled — aborting' },
];

// ---------------------------------------------------------------------------
// Error Recovery Service
// ---------------------------------------------------------------------------

export class ErrorRecoveryService {
	private readonly _config: IErrorRecoveryConfig;
	private readonly _retryCounters = new Map<string, number>();

	constructor(config?: Partial<IErrorRecoveryConfig>) {
		this._config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Classify an error and determine the recovery strategy.
	 *
	 * @param error The error to classify.
	 * @param context Optional context (tool name, file path, etc.) for logging.
	 */
	classify(error: Error | string, context?: string): IErrorRecoveryResult {
		const message = error instanceof Error ? error.message : String(error);
		const contextKey = context ?? message.slice(0, 50);

		// Check fatal patterns first (highest priority)
		for (const { pattern, reason } of FATAL_PATTERNS) {
			if (pattern.test(message)) {
				logger.info(`[ErrorRecovery] Classified as ABORT: ${reason} (context: ${contextKey})`);
				this._retryCounters.delete(contextKey);
				return { classification: 'abort', retriesRemaining: 0, retryDelayMs: 0, reason };
			}
		}

		// Check retryable patterns
		for (const { pattern, reason } of RETRYABLE_PATTERNS) {
			if (pattern.test(message)) {
				const retriesUsed = this._retryCounters.get(contextKey) ?? 0;
				const retriesRemaining = this._config.maxRetries - retriesUsed;

				if (retriesRemaining <= 0) {
					logger.info(`[ErrorRecovery] Retry budget exhausted for "${contextKey}" — classifying as ABORT`);
					this._retryCounters.delete(contextKey);
					return {
						classification: 'abort',
						retriesRemaining: 0,
						retryDelayMs: 0,
						reason: `Retry budget exhausted after ${this._config.maxRetries} attempts: ${reason}`,
					};
				}

				this._retryCounters.set(contextKey, retriesUsed + 1);
				const delay = Math.min(
					this._config.baseRetryDelayMs * Math.pow(2, retriesUsed),
					this._config.maxRetryDelayMs,
				);

				logger.info(`[ErrorRecovery] Classified as RETRY (${retriesRemaining} remaining, ${delay}ms delay): ${reason}`);
				return {
					classification: 'retry',
					retriesRemaining,
					retryDelayMs: delay,
					reason,
				};
			}
		}

		// Check skippable patterns
		for (const { pattern, reason } of SKIPPABLE_PATTERNS) {
			if (pattern.test(message)) {
				logger.info(`[ErrorRecovery] Classified as SKIP: ${reason}`);
				this._retryCounters.delete(contextKey);
				return { classification: 'skip', retriesRemaining: 0, retryDelayMs: 0, reason };
			}
		}

		// Default: unknown errors are treated as fatal (conservative)
		logger.info(`[ErrorRecovery] Unclassified error, treating as ABORT: ${message.slice(0, 100)}`);
		this._retryCounters.delete(contextKey);
		return {
			classification: 'abort',
			retriesRemaining: 0,
			retryDelayMs: 0,
			reason: `Unclassified error — treating as fatal for safety: ${message.slice(0, 100)}`,
		};
	}

	/**
	 * Reset retry counters for a given context.
	 */
	resetRetries(context: string): void {
		this._retryCounters.delete(context);
	}

	/**
	 * Reset all retry counters.
	 */
	resetAll(): void {
		this._retryCounters.clear();
	}
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: ErrorRecoveryService | undefined;

export function getErrorRecoveryService(): ErrorRecoveryService {
	if (!_instance) {
		_instance = new ErrorRecoveryService();
	}
	return _instance;
}
