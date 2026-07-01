/**
 * localUsageLogHelpers.ts — Pure-logic helpers for the telemetry system
 * (HARVEST-4 from Kovix_2.0).
 *
 * Source: `Kovix_2.0` branch `recovery/audit-tier1-patches`, commit
 * `c7c5f79e`. Original file was ~210 LOC. The original branch has been
 * deleted; reconstructed from HARVEST_CANDIDATES.md §1.5 spec.
 *
 * Layer: 1 (pure logic, no filesystem or platform imports).
 *
 * These helpers format and validate telemetry data before it reaches
 * the LocalUsageLogService. They are fully unit-testable with no mocks.
 *
 * Decisions referenced: D-001 (file-by-file audit), HARVEST-4.
 */

import type { TelemetryEventName, ITelemetryEvent } from './telemetryTypes';

// ---------------------------------------------------------------------------
// Session ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a session ID for correlating events from the same agent run.
 * Format: `sess-<8-char-hex>-<timestamp>` — human-readable, unique,
 * and sortable by timestamp.
 */
export function generateSessionId(): string {
	const hex = Math.random().toString(16).slice(2, 10);
	const ts = Date.now().toString(36);
	return `sess-${hex}-${ts}`;
}

// ---------------------------------------------------------------------------
// Event data builders (pure functions)
// ---------------------------------------------------------------------------

/**
 * Build data payload for an agent_loop_start event.
 */
export function buildAgentLoopStartData(task: string, mode: string): Record<string, unknown> {
	return {
		taskLength: task.length,
		mode,
	};
}

/**
 * Build data payload for an agent_loop_complete event.
 */
export function buildAgentLoopCompleteData(
	summary: string,
	roundsCompleted: number,
	milestonesCompleted: number,
	milestonesSkipped: number,
	creditsConsumed: number,
): Record<string, unknown> {
	return {
		summaryLength: summary.length,
		roundsCompleted,
		milestonesCompleted,
		milestonesSkipped,
		creditsConsumed,
	};
}

/**
 * Build data payload for an llm_call_complete event.
 */
export function buildLlmCallCompleteData(
	modelId: string,
	provider: string,
	tokenCount: number | undefined,
	durationMs: number,
): Record<string, unknown> {
	return {
		modelId,
		provider,
		tokenCount,
		durationMs,
	};
}

/**
 * Build data payload for a tool_call_complete event.
 */
export function buildToolCallCompleteData(
	toolName: string,
	success: boolean,
	durationMs: number,
	creditsCharged: number,
): Record<string, unknown> {
	return {
		toolName,
		success,
		durationMs,
		creditsCharged,
	};
}

/**
 * Build data payload for a credits_consumed event.
 */
export function buildCreditsConsumedData(
	actionType: string,
	amount: number,
	creditsRemaining: number,
	sessionId: string | undefined,
): Record<string, unknown> {
	return {
		actionType,
		amount,
		creditsRemaining,
		sessionId,
	};
}

// ---------------------------------------------------------------------------
// Event parsing (read back from JSONL)
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL line into an ITelemetryEvent. Returns null if the line
 * is malformed or not valid JSON.
 */
export function parseTelemetryLine(line: string): ITelemetryEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed.timestamp === 'string' && typeof parsed.event === 'string') {
			return parsed as ITelemetryEvent;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Filter telemetry events by event name.
 */
export function filterEventsByName(
	events: ITelemetryEvent[],
	name: TelemetryEventName,
): ITelemetryEvent[] {
	return events.filter(e => e.event === name);
}

/**
 * Filter telemetry events by session ID.
 */
export function filterEventsBySession(
	events: ITelemetryEvent[],
	sessionId: string,
): ITelemetryEvent[] {
	return events.filter(e => e.sessionId === sessionId);
}

// ---------------------------------------------------------------------------
// Session summary (aggregate statistics from a set of events)
// ---------------------------------------------------------------------------

/**
 * Summary of an agent session, aggregated from its telemetry events.
 */
export interface ISessionSummary {
	sessionId: string;
	startTime: string | undefined;
	endTime: string | undefined;
	totalEvents: number;
	llmCalls: number;
	toolCalls: number;
	creditsConsumed: number;
	milestonesCompleted: number;
	milestonesSkipped: number;
	errors: number;
}

/**
 * Build a session summary from a list of events sharing the same sessionId.
 * Pure function — no side effects.
 */
export function buildSessionSummary(events: ITelemetryEvent[]): ISessionSummary {
	if (events.length === 0) {
		return {
			sessionId: '',
			startTime: undefined,
			endTime: undefined,
			totalEvents: 0,
			llmCalls: 0,
			toolCalls: 0,
			creditsConsumed: 0,
			milestonesCompleted: 0,
			milestonesSkipped: 0,
			errors: 0,
		};
	}

	const sessionId = events[0].sessionId ?? '';
	const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

	let creditsConsumed = 0;
	for (const e of events) {
		if (e.event === 'credits_consumed' && e.data?.amount) {
			creditsConsumed += Number(e.data.amount);
		}
	}

	return {
		sessionId,
		startTime: sorted[0].timestamp,
		endTime: sorted[sorted.length - 1].timestamp,
		totalEvents: events.length,
		llmCalls: filterEventsByName(events, 'llm_call_complete').length,
		toolCalls: filterEventsByName(events, 'tool_call_complete').length,
		creditsConsumed,
		milestonesCompleted: filterEventsByName(events, 'milestone_completed').length,
		milestonesSkipped: filterEventsByName(events, 'milestone_skipped').length,
		errors:
			filterEventsByName(events, 'agent_loop_error').length +
			filterEventsByName(events, 'llm_call_error').length +
			filterEventsByName(events, 'tool_call_error').length,
	};
}
