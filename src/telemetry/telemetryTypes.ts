/**
 * telemetryTypes.ts — Telemetry event type definitions (HARVEST-4 from Kovix_2.0).
 *
 * Source: `Kovix_2.0` branch `recovery/audit-tier1-patches`, commits
 * `d5d54108`, `c7c5f79e`, `ad0ac5c8`. Original file was
 * `constructTelemetryService.ts` (85L). The original branch has been
 * deleted from the remote; this file is reconstructed from the spec in
 * HARVEST_CANDIDATES.md §1.5.
 *
 * Layer: 1 (pure types, no platform imports).
 *
 * Decisions referenced: D-001 (file-by-file audit), HARVEST-4.
 */

// ---------------------------------------------------------------------------
// Telemetry event names
// ---------------------------------------------------------------------------

/**
 * All typed telemetry event names. 15 categories covering the full
 * observable surface of the agent loop. Each event name maps to a
 * specific payload type in TelemetryEventPayload.
 *
 * PRIVACY: These events are written to a LOCAL file only
 * (~/.kovix/logs/usage.jsonl). They are NEVER sent to any remote
 * server. This module exists so the developer can understand what
 * the agent is doing, not for analytics or tracking.
 */
export type TelemetryEventName =
	| 'agent_loop_start'
	| 'agent_loop_complete'
	| 'agent_loop_error'
	| 'llm_call_start'
	| 'llm_call_complete'
	| 'llm_call_error'
	| 'tool_call_start'
	| 'tool_call_complete'
	| 'tool_call_error'
	| 'milestone_reached'
	| 'milestone_paused'
	| 'milestone_resumed'
	| 'milestone_skipped'
	| 'milestone_completed'
	| 'credits_consumed';

// ---------------------------------------------------------------------------
// Telemetry event payload
// ---------------------------------------------------------------------------

/**
 * A telemetry event. All events share a common envelope (timestamp,
 * event name, sessionId) plus a typed data payload.
 */
export interface ITelemetryEvent {
	/** ISO 8601 timestamp. */
	timestamp: string;
	/** Which event happened. */
	event: TelemetryEventName;
	/** Session ID for correlating events from the same agent run. */
	sessionId?: string;
	/** Event-specific data. */
	data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Telemetry service interface
// ---------------------------------------------------------------------------

/**
 * Local-only telemetry service. Writes events to
 * ~/.kovix/logs/usage.jsonl as JSON Lines.
 *
 * NEVER sends data anywhere. This is an observability tool for the
 * developer, not an analytics pipeline.
 */
export interface IConstructTelemetryService {
	/**
	 * Record a telemetry event. Writes to the local log file immediately.
	 * If the log file doesn't exist, it's created. If the directory
	 * doesn't exist, it's created.
	 */
	recordEvent(event: TelemetryEventName, data?: Record<string, unknown>): void;

	/**
	 * Set the session ID for subsequent events. Events without a
	 * sessionId are still recorded (they're just harder to correlate).
	 */
	setSessionId(sessionId: string): void;

	/**
	 * Flush any buffered events to disk. In the default implementation
	 * (append-only JSONL), this is a no-op since events are written
	 * immediately. It exists for future buffered implementations.
	 */
	flush(): Promise<void>;

	/**
	 * Dispose the service. Flushes and closes file handles.
	 */
	dispose(): void;
}
