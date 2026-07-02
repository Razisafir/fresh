/**
 * localUsageLogHelpers.ts — Pure-logic helpers for the local usage log (zero dependencies).
 *
 * Reimplemented from Kovix_2.0's localUsageLogHelpers.ts (originally on
 * recovery/audit-tier1-patches branch, ~210 LOC). The original branch
 * no longer exists in the remote, so this is a fresh implementation
 * based on the HARVEST_CANDIDATES.md description:
 *
 *   "Pure-logic and unit-testable. 15 typed event names."
 *
 * Design decisions:
 *   - All event names are typed string literals (not enums) for JSON
 *     serialisation friendliness
 *   - Each event has a well-defined shape (IUsageEvent)
 *   - Helpers for formatting, filtering, and aggregating events
 *   - Zero imports beyond TypeScript primitives
 *
 * Migration log entry: docs/03_MIGRATION_LOG.md — see "Harvest-1: localUsageLogHelpers"
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * The 15 typed event names for usage logging. Each name corresponds to
 * a specific user or agent action that should be recorded for observability.
 *
 * These events are LOCAL ONLY — never sent to any external server.
 * Written to ~/.kovix/logs/usage.jsonl as JSON Lines.
 */
export type UsageEventName =
	| 'agent_task_started'
	| 'agent_task_completed'
	| 'agent_task_failed'
	| 'agent_milestone_reached'
	| 'agent_milestone_completed'
	| 'agent_milestone_skipped'
	| 'agent_milestone_failed'
	| 'llm_call_started'
	| 'llm_call_completed'
	| 'llm_call_failed'
	| 'tool_call_started'
	| 'tool_call_completed'
	| 'tool_call_failed'
	| 'provider_switched'
	| 'session_started';

/**
 * A single usage event. All events have at minimum a name and timestamp.
 * Additional fields depend on the event type.
 */
export interface IUsageEvent {
	/** The event name (one of the 15 typed names). */
	readonly name: UsageEventName;
	/** ISO 8601 timestamp of when the event occurred. */
	readonly timestamp: string;
	/** Unique session ID — correlates events within a single Kovix session. */
	readonly sessionId: string;
	/** The LLM provider used (if applicable). */
	readonly provider?: string;
	/** The model used (if applicable). */
	readonly model?: string;
	/** The tool name (for tool_call_* events). */
	readonly toolName?: string;
	/** The task description (for agent_task_* events). */
	readonly task?: string;
	/** The milestone name (for agent_milestone_* events). */
	readonly milestone?: string;
	/** Duration in milliseconds (for *_completed events). */
	readonly durationMs?: number;
	/** Number of tokens consumed (for llm_call_completed events). */
	readonly tokenCount?: number;
	/** Estimated cost in USD (for llm_call_completed events). */
	readonly estimatedCostUsd?: number;
	/** Whether the operation succeeded (for *_completed / *_failed events). */
	readonly success?: boolean;
	/** Error message (for *_failed events). */
	readonly error?: string;
}

// ---------------------------------------------------------------------------
// Event creation helpers
// ---------------------------------------------------------------------------

/**
 * Create a new usage event with the current timestamp.
 * Pure function — no side effects beyond object creation.
 */
export function createEvent(
	name: UsageEventName,
	sessionId: string,
	fields?: Partial<Omit<IUsageEvent, 'name' | 'timestamp' | 'sessionId'>>,
): IUsageEvent {
	return {
		name,
		timestamp: new Date().toISOString(),
		sessionId,
		...fields,
	};
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a usage event as a JSON Lines string (one JSON object per line).
 * JSONL is append-friendly — you can just concatenate lines.
 */
export function formatEventAsJsonl(event: IUsageEvent): string {
	return JSON.stringify(event);
}

/**
 * Parse a JSONL line back into an IUsageEvent object.
 * Returns undefined if the line is malformed.
 */
export function parseJsonlLine(line: string): IUsageEvent | undefined {
	try {
		const parsed = JSON.parse(line);
		if (typeof parsed.name === 'string' && typeof parsed.timestamp === 'string') {
			return parsed as IUsageEvent;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Filtering helpers
// ---------------------------------------------------------------------------

/**
 * Filter events by name.
 */
export function filterByName(events: readonly IUsageEvent[], name: UsageEventName): IUsageEvent[] {
	return events.filter(e => e.name === name);
}

/**
 * Filter events by session ID.
 */
export function filterBySession(events: readonly IUsageEvent[], sessionId: string): IUsageEvent[] {
	return events.filter(e => e.sessionId === sessionId);
}

/**
 * Filter events by time range (inclusive).
 */
export function filterByTimeRange(
	events: readonly IUsageEvent[],
	startIso: string,
	endIso: string,
): IUsageEvent[] {
	const start = new Date(startIso).getTime();
	const end = new Date(endIso).getTime();
	return events.filter(e => {
		const t = new Date(e.timestamp).getTime();
		return t >= start && t <= end;
	});
}

/**
 * Filter events by provider.
 */
export function filterByProvider(events: readonly IUsageEvent[], provider: string): IUsageEvent[] {
	return events.filter(e => e.provider === provider);
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/**
 * Count events by name. Returns a Map from event name to count.
 */
export function countByName(events: readonly IUsageEvent[]): Map<UsageEventName, number> {
	const counts = new Map<UsageEventName, number>();
	for (const event of events) {
		const current = counts.get(event.name) ?? 0;
		counts.set(event.name, current + 1);
	}
	return counts;
}

/**
 * Sum total tokens from llm_call_completed events.
 */
export function sumTokens(events: readonly IUsageEvent[]): number {
	return events
		.filter(e => e.name === 'llm_call_completed' && typeof e.tokenCount === 'number')
		.reduce((sum, e) => sum + (e.tokenCount ?? 0), 0);
}

/**
 * Sum total estimated cost from llm_call_completed events.
 */
export function sumCost(events: readonly IUsageEvent[]): number {
	return events
		.filter(e => e.name === 'llm_call_completed' && typeof e.estimatedCostUsd === 'number')
		.reduce((sum, e) => sum + (e.estimatedCostUsd ?? 0), 0);
}

/**
 * Calculate average duration for *_completed events that have durationMs.
 */
export function averageDuration(events: readonly IUsageEvent[]): number {
	const withDuration = events.filter(e => typeof e.durationMs === 'number');
	if (withDuration.length === 0) return 0;
	return withDuration.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / withDuration.length;
}

/**
 * Get the success rate for agent tasks (completed / (completed + failed)).
 * Returns 0-1, or 0 if no task events exist.
 */
export function taskSuccessRate(events: readonly IUsageEvent[]): number {
	const completed = events.filter(e => e.name === 'agent_task_completed').length;
	const failed = events.filter(e => e.name === 'agent_task_failed').length;
	const total = completed + failed;
	return total === 0 ? 0 : completed / total;
}
