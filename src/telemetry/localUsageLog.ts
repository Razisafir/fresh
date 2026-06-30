/**
 * localUsageLog.ts — Local-only usage log service (HARVEST-4 from Kovix_2.0).
 *
 * Source: `Kovix_2.0` branch `recovery/audit-tier1-patches`, commits
 * `d5d54108`, `c7c5f79e`. Original file was ~255 LOC. The original
 * branch has been deleted; this is reconstructed from the spec in
 * HARVEST_CANDIDATES.md §1.5.
 *
 * Layer: 2 (writes to filesystem, but no VS Code / Electron imports).
 *
 * Writes usage events to `~/.kovix/logs/usage.jsonl` as JSON Lines.
 * NEVER sends data anywhere. This is an observability tool for the
 * developer, not an analytics pipeline.
 *
 * Integration point with Cost Governor / agentLoopHelpers:
 *   The `consumeCreditsForToolCall` function in agentLoopHelpers.ts
 *   already tracks credit consumption. The localUsageLog adds
 *   persistent observability — every credit consumption, LLM call,
 *   and tool execution is recorded to the JSONL file so the developer
 *   can review what happened after a session.
 *
 *   Wiring: the agent loop should call telemetry.recordEvent() at
 *   each significant state transition. The current agentLoop.ts
 *   already has logger.info() calls at these points; the telemetry
 *   calls would be added alongside them (not replacing them) in a
 *   future wiring pass. For now, the service is ready to use but
 *   not yet wired into the agent loop — that wiring happens when
 *   Layout B brings the settings panel where the user can toggle
 *   telemetry on/off.
 *
 * Decisions referenced: D-001 (file-by-file audit), HARVEST-4.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
	ITelemetryEvent,
	TelemetryEventName,
	IConstructTelemetryService,
} from './telemetryTypes';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_DIR_NAME = '.kovix';
const LOG_SUBDIR = 'logs';
const LOG_FILE_NAME = 'usage.jsonl';

/**
 * Get the path to the usage log file.
 * Exported for testing (allows overriding the home directory).
 */
export function getLogFilePath(homeDir?: string): string {
	const base = homeDir ?? os.homedir();
	return path.join(base, LOG_DIR_NAME, LOG_SUBDIR, LOG_FILE_NAME);
}

// ---------------------------------------------------------------------------
// LocalUsageLogService
// ---------------------------------------------------------------------------

/**
 * Local-only usage log. Appends one JSON line per event to
 * ~/.kovix/logs/usage.jsonl.
 *
 * Design choices:
 *   - Synchronous writes (fs.appendFileSync) to guarantee no event
 *     loss on process crash. The JSONL file is append-only, so
 *     concurrent writes from multiple processes are safe (atomic appends
 *     under 4KB on most OS/filesystem combos). For larger events,
 *     each line is still written as a single appendFileSync call.
 *   - No buffering — every event is persisted immediately. This is
 *     intentional: the whole point of this log is crash-survivability.
 *   - If the log file grows beyond MAX_LOG_SIZE_BYTES, it is rotated
 *     (renamed to usage.jsonl.1, previous .1 becomes .2, etc.).
 *     Rotation happens on the write that crosses the threshold.
 *   - If writing fails (permissions, disk full), the error is logged
 *     to the console logger and the event is silently dropped.
 *     Telemetry failure must never break the agent loop.
 */
export class LocalUsageLogService implements IConstructTelemetryService {

	private _sessionId: string | undefined;
	private _logFilePath: string;
	private _initialized = false;
	private _writeCount = 0;

	/**
	 * Maximum log file size before rotation. Default: 10 MB.
	 * After rotation, the old file becomes usage.jsonl.1, etc.
	 * Up to 3 rotated files are kept (usage.jsonl.1, .2, .3).
	 */
	static readonly MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
	static readonly MAX_ROTATED_FILES = 3;

	constructor(homeDir?: string) {
		this._logFilePath = getLogFilePath(homeDir);
	}

	/**
	 * Ensure the log directory exists. Called lazily on first write.
	 */
	private _ensureInitialized(): void {
		if (this._initialized) return;
		try {
			const dir = path.dirname(this._logFilePath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			this._initialized = true;
		} catch (err) {
			logger.warn(`[Telemetry] Failed to create log directory: ${err instanceof Error ? err.message : String(err)}`);
			// Don't set _initialized — we'll try again next write
		}
	}

	/**
	 * Check if the log file needs rotation, and rotate if so.
	 */
	private _rotateIfNeeded(): void {
		try {
			if (!fs.existsSync(this._logFilePath)) return;
			const stats = fs.statSync(this._logFilePath);
			if (stats.size >= LocalUsageLogService.MAX_LOG_SIZE_BYTES) {
				// Rotate: .3 → delete, .2 → .3, .1 → .2, current → .1
				for (let i = LocalUsageLogService.MAX_ROTATED_FILES; i >= 1; i--) {
					const rotatedPath = `${this._logFilePath}.${i}`;
					if (fs.existsSync(rotatedPath)) {
						if (i === LocalUsageLogService.MAX_ROTATED_FILES) {
							fs.unlinkSync(rotatedPath);
						} else {
							fs.renameSync(rotatedPath, `${this._logFilePath}.${i + 1}`);
						}
					}
				}
				fs.renameSync(this._logFilePath, `${this._logFilePath}.1`);
				logger.info(`[Telemetry] Rotated usage log (was ${Math.round(stats.size / 1024)}KB)`);
			}
		} catch (err) {
			logger.warn(`[Telemetry] Log rotation failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// --- IConstructTelemetryService ---

	recordEvent(event: TelemetryEventName, data?: Record<string, unknown>): void {
		this._ensureInitialized();

		const entry: ITelemetryEvent = {
			timestamp: new Date().toISOString(),
			event,
			sessionId: this._sessionId,
			data,
		};

		try {
			// Rotate on every 100th write (avoids stat on every event)
			this._writeCount++;
			if (this._writeCount % 100 === 0) {
				this._rotateIfNeeded();
			}

			const line = JSON.stringify(entry) + '\n';
			fs.appendFileSync(this._logFilePath, line, 'utf8');
		} catch (err) {
			// Telemetry must never break the agent loop. Log and move on.
			logger.warn(`[Telemetry] Failed to write event '${event}': ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	setSessionId(sessionId: string): void {
		this._sessionId = sessionId;
	}

	async flush(): Promise<void> {
		// No-op: appendFileSync writes immediately.
		// This method exists for the interface contract.
	}

	dispose(): void {
		// No-op: no file handles to close with appendFileSync.
		this._initialized = false;
	}

	/**
	 * Get the current log file path (for diagnostics/testing).
	 */
	get logFilePath(): string {
		return this._logFilePath;
	}

	/**
	 * Get the current session ID (for testing).
	 */
	get sessionId(): string | undefined {
		return this._sessionId;
	}
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let _instance: LocalUsageLogService | undefined;

/**
 * Get the singleton LocalUsageLogService instance.
 * Created lazily on first access.
 */
export function getTelemetryService(): LocalUsageLogService {
	if (!_instance) {
		_instance = new LocalUsageLogService();
		logger.info(`[Telemetry] Local usage log initialized at ${_instance.logFilePath}`);
	}
	return _instance;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetTelemetryService(): void {
	if (_instance) {
		_instance.dispose();
		_instance = undefined;
	}
}
