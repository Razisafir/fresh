/**
 * Tests for localUsageLogHelpers.ts — pure-logic helpers for usage logging.
 */
import { expect } from 'chai';
import {
        createEvent,
        formatEventAsJsonl,
        parseJsonlLine,
        filterByName,
        filterBySession,
        filterByTimeRange,
        filterByProvider,
        countByName,
        sumTokens,
        sumCost,
        averageDuration,
        taskSuccessRate,
} from '../../../src/agent/localUsageLogHelpers';

describe('localUsageLogHelpers', () => {
        const sessionId = 'test-session-001';

        describe('createEvent()', () => {
                it('creates an event with name, timestamp, and sessionId', () => {
                        const event = createEvent('agent_task_started', sessionId);
                        expect(event.name).to.equal('agent_task_started');
                        expect(event.sessionId).to.equal(sessionId);
                        expect(event.timestamp).to.be.a('string');
                        // Timestamp should be valid ISO 8601
                        expect(new Date(event.timestamp).getTime()).to.not.be.NaN;
                });

                it('includes optional fields', () => {
                        const event = createEvent('llm_call_completed', sessionId, {
                                provider: 'anthropic',
                                model: 'claude-sonnet-4',
                                tokenCount: 1500,
                                estimatedCostUsd: 0.015,
                                durationMs: 3200,
                        });
                        expect(event.provider).to.equal('anthropic');
                        expect(event.model).to.equal('claude-sonnet-4');
                        expect(event.tokenCount).to.equal(1500);
                        expect(event.estimatedCostUsd).to.equal(0.015);
                        expect(event.durationMs).to.equal(3200);
                });
        });

        describe('formatEventAsJsonl() / parseJsonlLine()', () => {
                it('round-trips an event through JSONL', () => {
                        const event = createEvent('tool_call_completed', sessionId, {
                                toolName: 'write_file',
                                durationMs: 120,
                        });
                        const line = formatEventAsJsonl(event);
                        expect(line).to.be.a('string');
                        expect(line).to.not.include('\n'); // JSONL = one line

                        const parsed = parseJsonlLine(line);
                        expect(parsed).to.deep.equal(event);
                });

                it('returns undefined for malformed JSON', () => {
                        expect(parseJsonlLine('not json')).to.be.undefined;
                });

                it('returns undefined for JSON without name/timestamp', () => {
                        expect(parseJsonlLine('{"foo":"bar"}')).to.be.undefined;
                });
        });

        describe('filterByName()', () => {
                it('filters events by name', () => {
                        const events = [
                                createEvent('agent_task_started', sessionId),
                                createEvent('llm_call_completed', sessionId),
                                createEvent('agent_task_started', sessionId),
                        ];
                        const filtered = filterByName(events, 'agent_task_started');
                        expect(filtered.length).to.equal(2);
                });
        });

        describe('filterBySession()', () => {
                it('filters events by session ID', () => {
                        const otherSession = 'other-session';
                        const events = [
                                createEvent('agent_task_started', sessionId),
                                createEvent('agent_task_started', otherSession),
                        ];
                        const filtered = filterBySession(events, sessionId);
                        expect(filtered.length).to.equal(1);
                        expect(filtered[0].sessionId).to.equal(sessionId);
                });
        });

        describe('filterByTimeRange()', () => {
                it('filters events within a time range', () => {
                        const events = [
                                { ...createEvent('agent_task_started', sessionId), timestamp: '2026-01-01T10:00:00Z' },
                                { ...createEvent('agent_task_started', sessionId), timestamp: '2026-01-02T10:00:00Z' },
                                { ...createEvent('agent_task_started', sessionId), timestamp: '2026-01-03T10:00:00Z' },
                        ];
                        const filtered = filterByTimeRange(events, '2026-01-01T12:00:00Z', '2026-01-02T12:00:00Z');
                        expect(filtered.length).to.equal(1);
                });
        });

        describe('filterByProvider()', () => {
                it('filters events by provider', () => {
                        const events = [
                                createEvent('llm_call_completed', sessionId, { provider: 'anthropic' }),
                                createEvent('llm_call_completed', sessionId, { provider: 'nvidia-nim' }),
                        ];
                        const filtered = filterByProvider(events, 'anthropic');
                        expect(filtered.length).to.equal(1);
                });
        });

        describe('countByName()', () => {
                it('counts events by name', () => {
                        const events = [
                                createEvent('agent_task_started', sessionId),
                                createEvent('llm_call_completed', sessionId),
                                createEvent('agent_task_started', sessionId),
                                createEvent('tool_call_completed', sessionId),
                        ];
                        const counts = countByName(events);
                        expect(counts.get('agent_task_started')).to.equal(2);
                        expect(counts.get('llm_call_completed')).to.equal(1);
                        expect(counts.get('tool_call_completed')).to.equal(1);
                });
        });

        describe('sumTokens()', () => {
                it('sums token counts from llm_call_completed events', () => {
                        const events = [
                                createEvent('llm_call_completed', sessionId, { tokenCount: 1000 }),
                                createEvent('llm_call_completed', sessionId, { tokenCount: 2000 }),
                                createEvent('agent_task_completed', sessionId), // not an LLM call
                        ];
                        expect(sumTokens(events)).to.equal(3000);
                });

                it('returns 0 for empty events', () => {
                        expect(sumTokens([])).to.equal(0);
                });
        });

        describe('sumCost()', () => {
                it('sums estimated costs', () => {
                        const events = [
                                createEvent('llm_call_completed', sessionId, { estimatedCostUsd: 0.01 }),
                                createEvent('llm_call_completed', sessionId, { estimatedCostUsd: 0.02 }),
                        ];
                        expect(sumCost(events)).to.be.closeTo(0.03, 0.0001);
                });
        });

        describe('averageDuration()', () => {
                it('calculates average duration', () => {
                        const events = [
                                createEvent('agent_task_completed', sessionId, { durationMs: 2000 }),
                                createEvent('agent_task_completed', sessionId, { durationMs: 4000 }),
                        ];
                        expect(averageDuration(events)).to.equal(3000);
                });

                it('returns 0 for events without duration', () => {
                        const events = [createEvent('agent_task_started', sessionId)];
                        expect(averageDuration(events)).to.equal(0);
                });
        });

        describe('taskSuccessRate()', () => {
                it('calculates success rate', () => {
                        const events = [
                                createEvent('agent_task_completed', sessionId),
                                createEvent('agent_task_completed', sessionId),
                                createEvent('agent_task_failed', sessionId),
                        ];
                        expect(taskSuccessRate(events)).to.be.closeTo(0.667, 0.01);
                });

                it('returns 0 when no task events exist', () => {
                        expect(taskSuccessRate([])).to.equal(0);
                });

                it('returns 1 when all tasks succeed', () => {
                        const events = [
                                createEvent('agent_task_completed', sessionId),
                                createEvent('agent_task_completed', sessionId),
                        ];
                        expect(taskSuccessRate(events)).to.equal(1);
                });
        });
});
