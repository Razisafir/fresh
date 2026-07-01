/**
 * commandRateLimiter.ts — Per-session rate limiter for terminal command execution.
 *
 * Implements the "10 cmds / 30s" rate limit that was deferred in v1.0-beta.
 * The rate limiter is owned by the agent loop and wraps `terminalExecutor.execute()`
 * to prevent runaway agents from spawning excessive child processes.
 *
 * Design:
 *   - Sliding window: tracks the last N command timestamps.
 *   - Configurable: maxCommands and windowMs can be tuned per-session.
 *   - Non-blocking: if the rate limit is exceeded, the caller receives a
 *     clear error instead of hanging or silently dropping commands.
 *   - Thread-safe: all state is in a single class instance, no shared mutable
 *     state outside the class.
 *
 * Security: this is a defence-in-depth measure on top of the existing SEC-3
 * (blocklist) and SEC-9 (env sanitisation) invariants. Rate limiting prevents
 * resource exhaustion from a compromised or buggy agent.
 */

import { logger } from '../util/logger';

export interface IRateLimitConfig {
	/** Maximum number of commands allowed within the window. Default: 10. */
	maxCommands: number;
	/** Sliding window duration in milliseconds. Default: 30_000 (30 seconds). */
	windowMs: number;
}

const DEFAULT_CONFIG: IRateLimitConfig = {
	maxCommands: 10,
	windowMs: 30_000,
};

export class CommandRateLimiter {
	private readonly config: IRateLimitConfig;
	private readonly timestamps: number[] = [];

	constructor(config?: Partial<IRateLimitConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Check if a new command is allowed under the rate limit.
	 * If allowed, records the timestamp and returns true.
	 * If not allowed, returns false with the time to wait.
	 */
	tryAcquire(): { allowed: true } | { allowed: false; retryAfterMs: number } {
		const now = Date.now();
		const windowStart = now - this.config.windowMs;

		// Remove timestamps outside the current window
		while (this.timestamps.length > 0 && this.timestamps[0] < windowStart) {
			this.timestamps.shift();
		}

		if (this.timestamps.length >= this.config.maxCommands) {
			const oldestInWindow = this.timestamps[0];
			const retryAfterMs = oldestInWindow + this.config.windowMs - now;
			logger.warn(
				`[CommandRateLimiter] Rate limit exceeded: ${this.timestamps.length}/${this.config.maxCommands} ` +
				`commands in the last ${this.config.windowMs / 1000}s. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
			);
			return { allowed: false, retryAfterMs };
		}

		this.timestamps.push(now);
		return { allowed: true };
	}

	/**
	 * Get the current rate limit status for display.
	 */
	getStatus(): { commandsInWindow: number; maxCommands: number; windowMs: number } {
		const now = Date.now();
		const windowStart = now - this.config.windowMs;
		const inWindow = this.timestamps.filter(t => t >= windowStart).length;
		return {
			commandsInWindow: inWindow,
			maxCommands: this.config.maxCommands,
			windowMs: this.config.windowMs,
		};
	}

	/**
	 * Reset the rate limiter (e.g. on session reset).
	 */
	reset(): void {
		this.timestamps.length = 0;
	}

	/**
	 * Update the rate limit configuration.
	 */
	updateConfig(config: Partial<IRateLimitConfig>): void {
		if (config.maxCommands !== undefined) {
			this.config.maxCommands = config.maxCommands;
		}
		if (config.windowMs !== undefined) {
			this.config.windowMs = config.windowMs;
		}
	}
}

/**
 * Singleton rate limiter instance. The agent loop should use this to gate
 * `terminalExecutor.execute()` calls.
 */
export const commandRateLimiter = new CommandRateLimiter();
