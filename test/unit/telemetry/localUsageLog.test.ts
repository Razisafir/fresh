/**
 * localUsageLog.test.ts — Unit tests for LocalUsageLogService (HARVEST-4).
 *
 * Tests the file-writing service using a temp directory.
 * NOT a pure-logic test — creates and reads files.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LocalUsageLogService, resetTelemetryService, getLogFilePath } from '../../../src/telemetry/localUsageLog';
import { parseTelemetryLine } from '../../../src/telemetry/localUsageLogHelpers';

describe('LocalUsageLogService', () => {
	let tempDir: string;
	let service: LocalUsageLogService;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kovix-telemetry-test-'));
		service = new LocalUsageLogService(tempDir);
	});

	afterEach(() => {
		service.dispose();
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup failures
		}
	});

	describe('recordEvent()', () => {
		it('creates log file and writes event', () => {
			service.recordEvent('agent_loop_start', { mode: 'plan' });

			const logPath = service.logFilePath;
			assert.ok(fs.existsSync(logPath), 'Log file should exist');

			const content = fs.readFileSync(logPath, 'utf8');
			const event = parseTelemetryLine(content);
			assert.ok(event);
			assert.strictEqual(event!.event, 'agent_loop_start');
			assert.strictEqual(event!.data?.mode, 'plan');
		});

		it('appends multiple events as JSONL', () => {
			service.recordEvent('agent_loop_start');
			service.recordEvent('llm_call_complete');
			service.recordEvent('agent_loop_complete');

			const content = fs.readFileSync(service.logFilePath, 'utf8');
			const lines = content.trim().split('\n');
			assert.strictEqual(lines.length, 3);

			const events = lines.map(l => parseTelemetryLine(l));
			assert.strictEqual(events[0]?.event, 'agent_loop_start');
			assert.strictEqual(events[1]?.event, 'llm_call_complete');
			assert.strictEqual(events[2]?.event, 'agent_loop_complete');
		});

		it('includes session ID in events', () => {
			service.setSessionId('sess-test-123');
			service.recordEvent('agent_loop_start');

			const content = fs.readFileSync(service.logFilePath, 'utf8');
			const event = parseTelemetryLine(content);
			assert.strictEqual(event?.sessionId, 'sess-test-123');
		});

		it('includes ISO 8601 timestamp', () => {
			service.recordEvent('agent_loop_start');

			const content = fs.readFileSync(service.logFilePath, 'utf8');
			const event = parseTelemetryLine(content);
			assert.ok(event?.timestamp);
			assert.ok(Date.parse(event!.timestamp) > 0, 'Timestamp should be parseable');
		});
	});

	describe('setSessionId()', () => {
		it('updates session ID', () => {
			service.setSessionId('sess-new');
			assert.strictEqual(service.sessionId, 'sess-new');
		});
	});

	describe('log file path', () => {
		it('is under ~/.kovix/logs/ by default', () => {
			const defaultPath = getLogFilePath();
			assert.ok(defaultPath.includes('.kovix'));
			assert.ok(defaultPath.includes('logs'));
			assert.ok(defaultPath.endsWith('usage.jsonl'));
		});

		it('uses provided homeDir', () => {
			assert.ok(service.logFilePath.startsWith(tempDir));
		});
	});

	describe('rotation', () => {
		it('rotates log when it exceeds MAX_LOG_SIZE_BYTES', () => {
			// Write enough data to trigger rotation
			const bigData = 'x'.repeat(1000);
			const eventsNeeded = Math.ceil((LocalUsageLogService.MAX_LOG_SIZE_BYTES / (bigData.length + 50)) + 1);

			for (let i = 0; i < Math.min(eventsNeeded, 11000); i++) {
				service.recordEvent('agent_loop_start', { data: bigData });
			}

			// After rotation, original file should still exist (now smaller)
			assert.ok(fs.existsSync(service.logFilePath));

			// Check that rotated file exists (usage.jsonl.1)
			const rotatedPath = `${service.logFilePath}.1`;
			assert.ok(fs.existsSync(rotatedPath), 'Rotated file should exist');
		});
	});

	describe('error handling', () => {
		it('does not throw on write failure', () => {
			const badService = new LocalUsageLogService('/nonexistent/path/that/cannot/be/created/because/parent/does/not/exist');
			// Should not throw — error is logged internally
			assert.doesNotThrow(() => {
				badService.recordEvent('agent_loop_start');
			});
			badService.dispose();
		});
	});
});

describe('resetTelemetryService()', () => {
	afterEach(() => {
		resetTelemetryService();
	});

	it('does not throw when no instance exists', () => {
		resetTelemetryService(); // Should be safe
	});
});
