/**
 * localUsageLog.ts — Local-only usage logging service (never sends data externally).
 *
 * Reimplemented from Kovix_2.0's localUsageLog.ts (originally on
 * recovery/audit-tier1-patches branch, ~255 LOC). The original branch
 * no longer exists in the remote, so this is a fresh implementation
 * based on the HARVEST_CANDIDATES.md description:
 *
 *   "Writes usage events to ~/.kovix/logs/usage.jsonl as JSON Lines —
 *    never sends data anywhere. Fills a critical observability gap.
 *    The maintainer is 'flying blind' with no telemetry of any kind."
 *
 * Design decisions:
 *   - All writes are append-only (JSONL format)
 *   - File is rotated when it exceeds a configurable size (default 10MB)
 *   - Writes are fire-and-forget (never block the agent loop)
 *   - Uses Node.js fs.appendFile for atomic appends
 *   - No external dependencies
 *
 * Security: this service writes ONLY to the user's local disk. It NEVER
 * makes network calls, NEVER sends data externally, and NEVER includes
 * full file contents or user secrets in log entries. Only event metadata
 * (event name, timestamp, provider, model, tool name, duration, token count)
 * is logged. Task descriptions are truncated to 200 chars and stripped of
 * any secret patterns before logging.
 *
 * Migration log entry: docs/03_MIGRATION_LOG.md — see "Harvest-1: localUsageLog"
 *
 * Decisions referenced: D-001 (file-by-file audit), harvest plan Step 2.
 */

import { appendFile, mkdir, stat, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import {
	type IUsageEvent,
	type UsageEventName,
	createEvent,
	formatEventAsJsonl,
} from './localUsageLogHelpers';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the local usage log.
 */
export interface ILocalUsageLogConfig {
	/** Directory to write log files. Defaults to ~/.kovix/logs/ */
	readonly logDir?: string;
	/** Maximum log file size in bytes before rotation. Defaults to 10MB. */
	readonly maxFileSizeBytes?: number;
	/** Maximum number of rotated log files to keep. Defaults to 5. */
	readonly maxRotatedFiles?: number;
	/** Whether logging is enabled. Defaults to true. */
	readonly enabled?: boolean;
}

const DEFAULT_CONFIG: Required<ILocalUsageLogConfig> = {
	logDir: join(homedir(), '.kovix', 'logs'),
	maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
	maxRotatedFiles: 5,
	enabled: true,
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Local-only usage log service. Writes events as JSONL to
 * ~/.kovix/logs/usage.jsonl. Never sends data externally.
 *
 * Usage:
 *   const log = new LocalUsageLogService({ enabled: true });
 *   log.recordEvent('agent_task_started', sessionId, { task: 'Add tests' });
 *   log.recordEvent('agent_task_completed', sessionId, { durationMs: 5000 });
 */
export class LocalUsageLogService {
	private readonly config: Required<ILocalUsageLogConfig>;
	private readonly logFilePath: string;
	private writeInProgress = false;
	private pendingWrites: string[] = [];

	constructor(config?: ILocalUsageLogConfig) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.logFilePath = join(this.config.logDir, 'usage.jsonl');
	}

	/**
	 * Record a usage event. Fire-and-forget — this never blocks the
	 * caller and never throws (errors are silently swallowed to avoid
	 * disrupting the agent loop). If logging is disabled, this is a no-op.
	 */
	recordEvent(
		name: UsageEventName,
		sessionId: string,
		fields?: Partial<Omit<IUsageEvent, 'name' | 'timestamp' | 'sessionId'>>,
	): void {
		if (!this.config.enabled) return;

		const event = createEvent(name, sessionId, fields);
		const line = formatEventAsJsonl(event);

		// Buffer the write. If a write is already in progress, queue it.
		// This prevents concurrent appends which could interleave JSONL lines.
		this.pendingWrites.push(line);
		this.flushPendingWrites().catch(() => {
			// Silently swallow — usage logging must never break the agent loop.
		});
	}

	/**
	 * Check if logging is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Get the log file path (useful for displaying in settings UI).
	 */
	getLogFilePath(): string {
		return this.logFilePath;
	}

	// ---------------------------------------------------------------------------
	// Internal
	// ---------------------------------------------------------------------------

	/**
	 * Flush pending writes to the log file. Only one flush runs at a time
	 * to prevent interleaved appends.
	 */
	private async flushPendingWrites(): Promise<void> {
		if (this.writeInProgress) return;
		if (this.pendingWrites.length === 0) return;

		this.writeInProgress = true;
		const lines = this.pendingWrites.splice(0);
		const content = lines.join('\n') + '\n';

		try {
			// Ensure the log directory exists
			await mkdir(this.config.logDir, { recursive: true });

			// Check if rotation is needed
			await this.rotateIfNeeded();

			// Append the events
			await appendFile(this.logFilePath, content, 'utf-8');
		} catch {
			// Silently swallow — usage logging must never break the agent loop.
			// The events are lost, but that's acceptable for an observability tool.
		} finally {
			this.writeInProgress = false;

			// If more writes accumulated while we were flushing, flush again.
			if (this.pendingWrites.length > 0) {
				this.flushPendingWrites().catch(() => {});
			}
		}
	}

	/**
	 * Rotate the log file if it exceeds the configured maximum size.
	 * Rotation renames the current file to usage.jsonl.1, shifts older
	 * rotations up (usage.jsonl.1 → usage.jsonl.2, etc.), and deletes
	 * files beyond the rotation limit.
	 */
	private async rotateIfNeeded(): Promise<void> {
		try {
			const fileStat = await stat(this.logFilePath);
			if (fileStat.size < this.config.maxFileSizeBytes) {
				return; // No rotation needed
			}

			// Delete the oldest rotation if it exceeds the limit
			const oldestPath = `${this.logFilePath}.${this.config.maxRotatedFiles}`;
			try {
				const { unlink } = await import('fs/promises');
				await unlink(oldestPath);
			} catch {
				// File might not exist — that's fine
			}

			// Shift existing rotations up
			for (let i = this.config.maxRotatedFiles - 1; i >= 1; i--) {
				const fromPath = `${this.logFilePath}.${i}`;
				const toPath = `${this.logFilePath}.${i + 1}`;
				try {
					await rename(fromPath, toPath);
				} catch {
					// File might not exist — that's fine
				}
			}

			// Rotate the current file to .1
			await rename(this.logFilePath, `${this.logFilePath}.1`);
		} catch {
			// File doesn't exist yet — no rotation needed
		}
	}
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: LocalUsageLogService | undefined;

/**
 * Get the global usage log service instance. Creates it on first call.
 */
export function getUsageLogService(config?: ILocalUsageLogConfig): LocalUsageLogService {
	if (!_instance) {
		_instance = new LocalUsageLogService(config);
	}
	return _instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetUsageLogService(): void {
	_instance = undefined;
}
