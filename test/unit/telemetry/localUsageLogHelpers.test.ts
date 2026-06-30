/**
 * localUsageLogHelpers.test.ts — Unit tests for telemetry helpers (HARVEST-4).
 *
 * Pure-logic tests — no filesystem, no mocks.
 */

import * as assert from 'assert';
import {
        generateSessionId,
        buildAgentLoopStartData,
        buildAgentLoopCompleteData,
        buildLlmCallCompleteData,
        buildToolCallCompleteData,
        buildCreditsConsumedData,
        parseTelemetryLine,
        filterEventsByName,
        filterEventsBySession,
        buildSessionSummary,
} from '../../../src/telemetry/localUsageLogHelpers';
import type { ITelemetryEvent } from '../../../src/telemetry/telemetryTypes';

describe('localUsageLogHelpers', () => {

        // ---------------------------------------------------------------------------
        // generateSessionId
        // ---------------------------------------------------------------------------

        describe('generateSessionId()', () => {
                it('starts with sess-', () => {
                        const id = generateSessionId();
                        assert.ok(id.startsWith('sess-'), `Expected sess- prefix, got: ${id}`);
                });

                it('is unique across calls', () => {
                        const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
                        assert.strictEqual(ids.size, 100, 'Session IDs should be unique');
                });
        });

        // ---------------------------------------------------------------------------
        // buildAgentLoopStartData
        // ---------------------------------------------------------------------------

        describe('buildAgentLoopStartData()', () => {
                it('includes taskLength and mode', () => {
                        const data = buildAgentLoopStartData('create a hello world app', 'plan');
                        assert.strictEqual(data.taskLength, 24);
                        assert.strictEqual(data.mode, 'plan');
                });
        });

        // ---------------------------------------------------------------------------
        // buildAgentLoopCompleteData
        // ---------------------------------------------------------------------------

        describe('buildAgentLoopCompleteData()', () => {
                it('includes all fields', () => {
                        const data = buildAgentLoopCompleteData('done', 5, 3, 1, 7);
                        assert.strictEqual(data.summaryLength, 4);
                        assert.strictEqual(data.roundsCompleted, 5);
                        assert.strictEqual(data.milestonesCompleted, 3);
                        assert.strictEqual(data.milestonesSkipped, 1);
                        assert.strictEqual(data.creditsConsumed, 7);
                });
        });

        // ---------------------------------------------------------------------------
        // buildLlmCallCompleteData
        // ---------------------------------------------------------------------------

        describe('buildLlmCallCompleteData()', () => {
                it('includes model and timing info', () => {
                        const data = buildLlmCallCompleteData('claude-sonnet-4', 'anthropic', 1500, 2345);
                        assert.strictEqual(data.modelId, 'claude-sonnet-4');
                        assert.strictEqual(data.provider, 'anthropic');
                        assert.strictEqual(data.tokenCount, 1500);
                        assert.strictEqual(data.durationMs, 2345);
                });

                it('handles undefined tokenCount', () => {
                        const data = buildLlmCallCompleteData('model', 'provider', undefined, 100);
                        assert.strictEqual(data.tokenCount, undefined);
                });
        });

        // ---------------------------------------------------------------------------
        // buildToolCallCompleteData
        // ---------------------------------------------------------------------------

        describe('buildToolCallCompleteData()', () => {
                it('includes tool name, success, and credits', () => {
                        const data = buildToolCallCompleteData('write_file', true, 500, 1);
                        assert.strictEqual(data.toolName, 'write_file');
                        assert.strictEqual(data.success, true);
                        assert.strictEqual(data.durationMs, 500);
                        assert.strictEqual(data.creditsCharged, 1);
                });
        });

        // ---------------------------------------------------------------------------
        // buildCreditsConsumedData
        // ---------------------------------------------------------------------------

        describe('buildCreditsConsumedData()', () => {
                it('includes all fields', () => {
                        const data = buildCreditsConsumedData('file_edit', 1, 42, 'sess-abc');
                        assert.strictEqual(data.actionType, 'file_edit');
                        assert.strictEqual(data.amount, 1);
                        assert.strictEqual(data.creditsRemaining, 42);
                        assert.strictEqual(data.sessionId, 'sess-abc');
                });
        });

        // ---------------------------------------------------------------------------
        // parseTelemetryLine
        // ---------------------------------------------------------------------------

        describe('parseTelemetryLine()', () => {
                it('parses a valid JSONL line', () => {
                        const event = parseTelemetryLine('{"timestamp":"2026-01-01T00:00:00Z","event":"agent_loop_start","sessionId":"sess-123"}');
                        assert.ok(event);
                        assert.strictEqual(event!.event, 'agent_loop_start');
                        assert.strictEqual(event!.sessionId, 'sess-123');
                });

                it('returns null for empty line', () => {
                        assert.strictEqual(parseTelemetryLine(''), null);
                        assert.strictEqual(parseTelemetryLine('   '), null);
                });

                it('returns null for invalid JSON', () => {
                        assert.strictEqual(parseTelemetryLine('not json'), null);
                });

                it('returns null for JSON missing required fields', () => {
                        assert.strictEqual(parseTelemetryLine('{"foo":"bar"}'), null);
                });
        });

        // ---------------------------------------------------------------------------
        // filterEventsByName / filterEventsBySession
        // ---------------------------------------------------------------------------

        describe('filterEventsByName()', () => {
                const events: ITelemetryEvent[] = [
                        { timestamp: '2026-01-01T00:00:00Z', event: 'agent_loop_start' },
                        { timestamp: '2026-01-01T00:01:00Z', event: 'llm_call_complete' },
                        { timestamp: '2026-01-01T00:02:00Z', event: 'agent_loop_complete' },
                ];

                it('filters by event name', () => {
                        const filtered = filterEventsByName(events, 'llm_call_complete');
                        assert.strictEqual(filtered.length, 1);
                        assert.strictEqual(filtered[0].event, 'llm_call_complete');
                });

                it('returns empty array when no match', () => {
                        assert.strictEqual(filterEventsByName(events, 'tool_call_error').length, 0);
                });
        });

        describe('filterEventsBySession()', () => {
                const events: ITelemetryEvent[] = [
                        { timestamp: '2026-01-01T00:00:00Z', event: 'agent_loop_start', sessionId: 'sess-a' },
                        { timestamp: '2026-01-01T00:01:00Z', event: 'llm_call_complete', sessionId: 'sess-b' },
                        { timestamp: '2026-01-01T00:02:00Z', event: 'agent_loop_complete', sessionId: 'sess-a' },
                ];

                it('filters by session ID', () => {
                        const filtered = filterEventsBySession(events, 'sess-a');
                        assert.strictEqual(filtered.length, 2);
                });
        });

        // ---------------------------------------------------------------------------
        // buildSessionSummary
        // ---------------------------------------------------------------------------

        describe('buildSessionSummary()', () => {
                it('returns empty summary for empty events', () => {
                        const summary = buildSessionSummary([]);
                        assert.strictEqual(summary.totalEvents, 0);
                        assert.strictEqual(summary.sessionId, '');
                });

                it('aggregates session statistics', () => {
                        const events: ITelemetryEvent[] = [
                                { timestamp: '2026-01-01T00:00:00Z', event: 'agent_loop_start', sessionId: 'sess-1' },
                                { timestamp: '2026-01-01T00:01:00Z', event: 'llm_call_complete', sessionId: 'sess-1' },
                                { timestamp: '2026-01-01T00:02:00Z', event: 'tool_call_complete', sessionId: 'sess-1' },
                                { timestamp: '2026-01-01T00:03:00Z', event: 'milestone_completed', sessionId: 'sess-1' },
                                { timestamp: '2026-01-01T00:04:00Z', event: 'milestone_skipped', sessionId: 'sess-1' },
                                { timestamp: '2026-01-01T00:05:00Z', event: 'credits_consumed', sessionId: 'sess-1', data: { amount: 1 } },
                                { timestamp: '2026-01-01T00:06:00Z', event: 'credits_consumed', sessionId: 'sess-1', data: { amount: 2 } },
                                { timestamp: '2026-01-01T00:07:00Z', event: 'agent_loop_complete', sessionId: 'sess-1' },
                        ];

                        const summary = buildSessionSummary(events);
                        assert.strictEqual(summary.sessionId, 'sess-1');
                        assert.strictEqual(summary.startTime, '2026-01-01T00:00:00Z');
                        assert.strictEqual(summary.endTime, '2026-01-01T00:07:00Z');
                        assert.strictEqual(summary.totalEvents, 8);
                        assert.strictEqual(summary.llmCalls, 1);
                        assert.strictEqual(summary.toolCalls, 1);
                        assert.strictEqual(summary.creditsConsumed, 3);
                        assert.strictEqual(summary.milestonesCompleted, 1);
                        assert.strictEqual(summary.milestonesSkipped, 1);
                });

                it('counts errors across all error types', () => {
                        const events: ITelemetryEvent[] = [
                                { timestamp: '2026-01-01T00:00:00Z', event: 'agent_loop_error', sessionId: 'sess-1' },
                                { timestamp: '2026-01-01T00:01:00Z', event: 'llm_call_error', sessionId: 'sess-1' },
                                { timestamp: '2026-01-01T00:02:00Z', event: 'tool_call_error', sessionId: 'sess-1' },
                        ];

                        const summary = buildSessionSummary(events);
                        assert.strictEqual(summary.errors, 3);
                });
        });
});
