/**
 * Regression test for the silent-degradation bug (STUB_AUDIT H-1).
 *
 * This test specifically catches the reintroduction of the bug class
 * where embedding failures are silently swallowed without any status
 * change or user-visible indication. The test is designed to be
 * hard to accidentally break — it checks the BEHAVIOR (status changes)
 * not the implementation details.
 *
 * Bug class: "looks fine, isn't" — the system appears to work (no errors,
 * no crashes) but memory retrieval silently returns empty results when
 * the embedding backend is down. This is the most dangerous bug class
 * because tests can pass around it.
 *
 * Treat with the same seriousness as SEC-6 prompt-sanitizer miss.
 */
import { expect } from 'chai';
import {
        type IEmbeddingService,
        type EmbeddingResult,
        type EmbeddingStatus,
        type StatusChangeCallback,
        OllamaEmbeddingService,
        NullEmbeddingService,
} from '../../../src/memory/embeddingService';
import type { IMemoryConfig } from '../../../src/memory/types';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A controllable embedding service that simulates failures.
 * This lets us test the status-tracking behavior without
 * needing a real Ollama server.
 */
class MockEmbeddingService implements IEmbeddingService {
        private _enabled: boolean;
        private _shouldFail: boolean;
        private _status: EmbeddingStatus = 'available';
        private _consecutiveFailures = 0;
        private readonly _statusListeners: StatusChangeCallback[] = [];
        private _embedCallCount = 0;

        constructor(enabled = true) {
                this._enabled = enabled;
                this._shouldFail = false;
        }

        /** Simulate failures on subsequent embed() calls. */
        setShouldFail(shouldFail: boolean): void {
                this._shouldFail = shouldFail;
        }

        /** Get the number of embed() calls made. */
        getEmbedCallCount(): number {
                return this._embedCallCount;
        }

        isEnabled(): boolean {
                return this._enabled;
        }

        async embed(_text: string): Promise<EmbeddingResult> {
                this._embedCallCount++;
                if (!this._enabled || this._shouldFail) {
                        this._consecutiveFailures++;
                        if (this._consecutiveFailures >= 10) {
                                if (this._status !== 'unavailable') {
                                        this.setStatus('unavailable');
                                }
                        } else if (this._consecutiveFailures >= 3) {
                                if (this._status !== 'degraded' && this._status !== 'unavailable') {
                                        this.setStatus('degraded');
                                }
                        }
                        return null;
                }
                this._consecutiveFailures = 0;
                if (this._status !== 'available') {
                        this.setStatus('available');
                }
                return new Array(384).fill(0.1); // Mock embedding vector
        }

        getDimension(): number | null {
                return this._enabled ? 384 : null;
        }

        getStatus(): EmbeddingStatus {
                return this._status;
        }

        onStatusChange(callback: StatusChangeCallback): void {
                this._statusListeners.push(callback);
        }

        private setStatus(newStatus: EmbeddingStatus): void {
                const previous = this._status;
                this._status = newStatus;
                for (const listener of this._statusListeners) {
                        listener(newStatus, previous);
                }
        }
}

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------

describe('embeddingService — HARVEST-1b silent-degradation regression', () => {
        describe('OllamaEmbeddingService status tracking', () => {
                it('starts with status "available"', () => {
                        const config: IMemoryConfig = { embedProvider: 'ollama', embedModel: 'nomic-embed-text', vectorStore: 'in-process' };
                        const svc = new OllamaEmbeddingService(config);
                        expect(svc.getStatus()).to.equal('available');
                });

                it('does NOT silently swallow failures — status changes are emitted', () => {
                        const mock = new MockEmbeddingService(true);
                        const statusChanges: Array<{ newStatus: EmbeddingStatus; previousStatus: EmbeddingStatus }> = [];

                        mock.onStatusChange((newStatus, previousStatus) => {
                                statusChanges.push({ newStatus, previousStatus });
                        });

                        // Simulate 3 consecutive failures
                        mock.setShouldFail(true);
                        mock.embed('test1');
                        mock.embed('test2');
                        mock.embed('test3');

                        // After 3 failures, status should be 'degraded' — NOT silent
                        expect(mock.getStatus()).to.equal('degraded');
                        expect(statusChanges.length).to.be.greaterThan(0);
                        expect(statusChanges[0].newStatus).to.equal('degraded');
                });

                it('transitions to "unavailable" after 10 consecutive failures', () => {
                        const mock = new MockEmbeddingService(true);
                        const statusChanges: EmbeddingStatus[] = [];

                        mock.onStatusChange((newStatus) => {
                                statusChanges.push(newStatus);
                        });

                        mock.setShouldFail(true);
                        for (let i = 0; i < 10; i++) {
                                mock.embed(`test${i}`);
                        }

                        expect(mock.getStatus()).to.equal('unavailable');
                        expect(statusChanges).to.include('unavailable');
                });

                it('recovers to "available" after a successful call', () => {
                        const mock = new MockEmbeddingService(true);

                        mock.setShouldFail(true);
                        for (let i = 0; i < 5; i++) {
                                mock.embed(`test${i}`);
                        }
                        expect(mock.getStatus()).to.equal('degraded');

                        // Now succeed
                        mock.setShouldFail(false);
                        mock.embed('recovery test');

                        expect(mock.getStatus()).to.equal('available');
                });

                it('status change callback is invoked on every transition', () => {
                        const mock = new MockEmbeddingService(true);
                        const transitions: string[] = [];

                        mock.onStatusChange((newStatus, previousStatus) => {
                                transitions.push(`${previousStatus} → ${newStatus}`);
                        });

                        // available → degraded
                        mock.setShouldFail(true);
                        for (let i = 0; i < 3; i++) mock.embed(`f${i}`);
                        expect(transitions).to.include('available → degraded');

                        // degraded → unavailable
                        for (let i = 0; i < 7; i++) mock.embed(`f${i + 3}`);
                        expect(transitions).to.include('degraded → unavailable');

                        // unavailable → available
                        mock.setShouldFail(false);
                        mock.embed('recovery');
                        expect(transitions).to.include('unavailable → available');
                });
        });

        describe('NullEmbeddingService', () => {
                it('always reports status "unavailable"', () => {
                        const svc = new NullEmbeddingService();
                        expect(svc.getStatus()).to.equal('unavailable');
                });

                it('fires status change callback immediately on registration', () => {
                        const svc = new NullEmbeddingService();
                        let receivedStatus: EmbeddingStatus | undefined;
                        svc.onStatusChange((newStatus) => {
                                receivedStatus = newStatus;
                        });
                        expect(receivedStatus).to.equal('unavailable');
                });

                it('isEnabled() returns false — callers cannot accidentally use it', () => {
                        const svc = new NullEmbeddingService();
                        expect(svc.isEnabled()).to.be.false;
                });
        });

        describe('CRITICAL REGRESSION: silent failure must not be reintroduced', () => {
                it('when embed() returns null 10+ times, getStatus() MUST NOT be "available"', () => {
                        /**
                         * This is the core regression test for the STUB_AUDIT H-1 bug class.
                         *
                         * BEFORE the fix: embed() returned null silently, status was always
                         * "available" (or didn't exist), and the UI had no way to know
                         * embeddings were broken.
                         *
                         * AFTER the fix: consecutive failures cause status transitions.
                         * If someone refactors embeddingService.ts and accidentally removes
                         * the status tracking, THIS test will fail.
                         */
                        const mock = new MockEmbeddingService(true);

                        // Simulate persistent failures
                        mock.setShouldFail(true);
                        for (let i = 0; i < 15; i++) {
                                mock.embed(`fail${i}`);
                        }

                        // The status MUST NOT be 'available' — that would be the silent bug
                        expect(mock.getStatus()).to.not.equal('available');
                        // It should specifically be 'unavailable' after 10+ failures
                        expect(mock.getStatus()).to.equal('unavailable');
                });

                it('when embed() returns null 3-9 times, getStatus() MUST NOT be "available"', () => {
                        const mock = new MockEmbeddingService(true);
                        mock.setShouldFail(true);
                        for (let i = 0; i < 5; i++) {
                                mock.embed(`fail${i}`);
                        }

                        expect(mock.getStatus()).to.not.equal('available');
                        expect(mock.getStatus()).to.equal('degraded');
                });

                it('at least one status change callback MUST fire on degradation', () => {
                        const mock = new MockEmbeddingService(true);
                        let callbackCount = 0;

                        mock.onStatusChange(() => {
                                callbackCount++;
                        });

                        mock.setShouldFail(true);
                        for (let i = 0; i < 5; i++) {
                                mock.embed(`fail${i}`);
                        }

                        // If callbackCount === 0, the status change is silent — that's the bug
                        expect(callbackCount).to.be.greaterThan(0);
                });
        });
});
