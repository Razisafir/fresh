/**
 * embeddingService.ts — Embedding provider abstraction (M5, v1.0-beta).
 *
 * v1.0-beta scope: Ollama only (local, no API key required). The 'openai'
 * provider is typed in the config but NOT implemented — it returns null
 * (degrade gracefully). The 'none' provider returns null immediately.
 *
 * Why local-only (per Phase 8-A design decision):
 *   - Avoids a new third-party API key requirement for v1.0
 *   - Avoids a new vendor dependency
 *   - Embeddings stay on the user's machine (privacy)
 *   - Ollama is free, runs locally, and the user may already have it for
 *     the Ollama LLM provider
 *
 * Port note: nothing is ported from Kovix_2.0's UniversalMemoryService —
 * that service had a keyword-only scoring bug (R-007) and used a different
 * embedding backend. This is a clean rewrite using semantic embeddings.
 *
 * H-1 FIX (from STUB_AUDIT): The old repo's embeddingService silently
 * returned zero vectors when no backend was available, causing memory
 * retrieval to degrade to keyword-only with NO user-visible indication.
 * This fix:
 *   1. Adds EmbeddingServiceStatus type — 'available' | 'degraded' | 'unavailable'
 *   2. Adds getStatus() to the interface — callers can check WHY embeddings
 *      aren't working, not just WHETHER they're enabled
 *   3. Makes isEnabled() reflect ACTUAL backend reachability (not just config)
 *   4. Tracks consecutive failures — after 3 consecutive failures, marks
 *      status as 'unavailable' (backend is likely down)
 *   5. On successful embed, resets failure count and upgrades status back
 *      to 'available' (auto-recovery when Ollama comes back)
 *   6. OllamaEmbeddingService now returns EmbeddingResultWithStatus — the
 *      caller can distinguish between "null because service is disabled" and
 *      "null because backend is temporarily down"
 *
 * This bug class (looks fine, isn't) previously bit this project as SEC-6
 * (prompt-sanitizer miss). Treat with matching seriousness: the regression
 * test in embeddingService.test.ts specifically catches silent-failure
 * reintroduction.
 *
 * Security: SEC-6 — embedding text is sent to the local Ollama instance
 * only (no remote calls). The Ollama base URL is constrained to localhost
 * by default; if a user overrides it to a remote URL, that's their choice.
 *
 * Decisions referenced: D-007, R-007, Phase 8-A (local-only), H-1 fix.
 */

import type { IMemoryConfig } from './types';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Status types (H-1 fix)
// ---------------------------------------------------------------------------

/**
 * Status of the embedding service, surfaced to callers and (eventually) UI.
 *
 *   - 'available':    backend is reachable, embeddings working
 *   - 'degraded':     backend was reachable but recent embed() calls failed
 *                     (1-2 consecutive failures). Still worth retrying.
 *   - 'unavailable':  no backend configured (provider='none') OR backend
 *                     has failed 3+ consecutive times (likely down).
 *                     Memory retrieval should flag itself as degraded.
 */
export type EmbeddingServiceStatus = 'available' | 'degraded' | 'unavailable';

/**
 * Reason for the current status. Human-readable for logging/UI display.
 */
export interface IStatusDetail {
        status: EmbeddingServiceStatus;
        reason: string;
}

// ---------------------------------------------------------------------------
// Embedding result (enhanced with status info)
// ---------------------------------------------------------------------------

/**
 * Result of an embedding call. null means "no embedding available" (provider
 * disabled, Ollama down, network error, etc.) — callers must handle null
 * gracefully.
 */
export type EmbeddingResult = number[] | null;

// ---------------------------------------------------------------------------
// Interface (enhanced with H-1 fix)
// ---------------------------------------------------------------------------

/**
 * Embedding service interface.
 */
export interface IEmbeddingService {
        /** Returns true if the service can produce embeddings (provider != none AND backend reachable). */
        isEnabled(): boolean;
        /** Embed a text string. Returns null on any failure (degrade gracefully). */
        embed(text: string): Promise<EmbeddingResult>;
        /** The dimension of vectors produced (null until first successful embed). */
        getDimension(): number | null;
        /**
         * Get the current status of the embedding service.
         * H-1 fix: surfaces WHY embeddings aren't working, not just WHETHER.
         * Callers (memory service, UI) should check this to provide visible
         * feedback instead of silently degrading.
         */
        getStatus(): IStatusDetail;
}

// ---------------------------------------------------------------------------
// Consecutive-failure threshold
// ---------------------------------------------------------------------------

/**
 * Number of consecutive failures before marking the service as 'unavailable'.
 * After this many failures in a row, we assume the backend is down and
 * stop retrying every call (the caller should show a status message).
 */
const UNAVAILABLE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// OllamaEmbeddingService (enhanced with status tracking)
// ---------------------------------------------------------------------------

/**
 * Ollama embedding service.
 *
 * Calls `POST {baseUrl}/api/embeddings` with `{ model, prompt }`.
 * Ollama returns `{ embedding: number[] }`.
 *
 * On any error (network, HTTP non-200, malformed JSON, empty embedding),
 * returns null AND increments the consecutive failure counter. After
 * UNAVAILABLE_THRESHOLD consecutive failures, getStatus() returns
 * 'unavailable' instead of 'degraded'.
 *
 * On successful embed, the counter resets and status returns to 'available'.
 */
export class OllamaEmbeddingService implements IEmbeddingService {
        private readonly baseUrl: string;
        private readonly model: string;
        private _dimension: number | null = null;
        private _consecutiveFailures = 0;
        private _lastFailureReason = '';

        constructor(config: IMemoryConfig) {
                this.baseUrl = (config.ollamaBaseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
                this.model = config.embedModel || 'nomic-embed-text';
        }

        isEnabled(): boolean {
                // H-1 fix: isEnabled reflects ACTUAL reachability, not just config.
                // If we've had too many consecutive failures, report disabled.
                return this.getStatus().status !== 'unavailable';
        }

        getStatus(): IStatusDetail {
                if (this._consecutiveFailures === 0) {
                        return {
                                status: 'available',
                                reason: `Ollama embedding service available (${this.baseUrl}, model: ${this.model})`,
                        };
                }
                if (this._consecutiveFailures >= UNAVAILABLE_THRESHOLD) {
                        return {
                                status: 'unavailable',
                                reason: `Ollama embedding backend unreachable after ${this._consecutiveFailures} attempts. ` +
                                        `Last failure: ${this._lastFailureReason}. ` +
                                        `Ensure Ollama is running at ${this.baseUrl} with model '${this.model}' pulled.`,
                        };
                }
                // degraded: 1-2 consecutive failures
                return {
                        status: 'degraded',
                        reason: `Ollama embedding backend degraded (${this._consecutiveFailures} consecutive failures). ` +
                                `Last failure: ${this._lastFailureReason}. ` +
                                `Retries will continue; memory search quality may be reduced.`,
                };
        }

        async embed(text: string): Promise<EmbeddingResult> {
                try {
                        const response = await fetch(`${this.baseUrl}/api/embeddings`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ model: this.model, prompt: text }),
                                signal: AbortSignal.timeout(10_000),
                        });

                        if (!response.ok) {
                                this._recordFailure(`HTTP ${response.status}`);
                                return null;
                        }

                        const data = (await response.json()) as { embedding?: number[] };
                        if (!data.embedding || !Array.isArray(data.embedding) || data.embedding.length === 0) {
                                this._recordFailure('Empty or invalid embedding response');
                                return null;
                        }

                        // Success — reset failure counter and update status.
                        if (this._consecutiveFailures > 0) {
                                logger.info(`[EmbeddingService] Recovered after ${this._consecutiveFailures} consecutive failures. Status → available.`);
                        }
                        this._consecutiveFailures = 0;
                        this._lastFailureReason = '';

                        if (this._dimension === null) {
                                this._dimension = data.embedding.length;
                        }

                        return data.embedding;
                } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this._recordFailure(msg);
                        return null;
                }
        }

        getDimension(): number | null {
                return this._dimension;
        }

        private _recordFailure(reason: string): void {
                this._consecutiveFailures++;
                this._lastFailureReason = reason;

                // H-1 fix: LOG the failure visibly. The old code silently swallowed
                // ALL errors. Now every failure is logged so the developer can see
                // WHY memory is degrading.
                if (this._consecutiveFailures === 1) {
                        logger.warn(`[EmbeddingService] Embedding failed: ${reason}. Status → degraded.`);
                } else if (this._consecutiveFailures === UNAVAILABLE_THRESHOLD) {
                        logger.error(
                                `[EmbeddingService] Embedding backend UNAVAILABLE after ${this._consecutiveFailures} consecutive failures. ` +
                                `Last failure: ${reason}. Memory retrieval will return empty results until Ollama is restarted.`,
                        );
                } else {
                        logger.warn(`[EmbeddingService] Embedding failure #${this._consecutiveFailures}: ${reason}`);
                }
        }
}

// ---------------------------------------------------------------------------
// NullEmbeddingService (enhanced with status)
// ---------------------------------------------------------------------------

/**
 * Null embedding service — used when embedProvider === 'none' or when an
 * unimplemented provider (e.g. 'openai' in v1.0-beta) is selected.
 * Always returns null. The memory service checks isEnabled() before
 * attempting any storage/retrieval.
 *
 * H-1 fix: getStatus() now returns 'unavailable' with a clear reason,
 * instead of silently returning null and leaving the caller guessing.
 */
export class NullEmbeddingService implements IEmbeddingService {
        private readonly _reason: string;

        constructor(reason?: string) {
                this._reason = reason ?? 'No embedding backend configured (provider set to "none")';
        }

        isEnabled(): boolean {
                return false;
        }

        async embed(_text: string): Promise<EmbeddingResult> {
                return null;
        }

        getDimension(): number | null {
                return null;
        }

        getStatus(): IStatusDetail {
                return {
                        status: 'unavailable',
                        reason: this._reason,
                };
        }
}

// ---------------------------------------------------------------------------
// OpenAIEmbeddingService (new in v0.2)
// ---------------------------------------------------------------------------

/**
 * OpenAI embedding service.
 *
 * Calls `POST https://api.openai.com/v1/embeddings` with the configured model.
 * Uses the same H-1 status tracking as OllamaEmbeddingService.
 */
export class OpenAIEmbeddingService implements IEmbeddingService {
        private readonly apiKey: string;
        private readonly model: string;
        private readonly baseUrl: string;
        private _dimension: number | null = null;
        private _consecutiveFailures = 0;
        private _lastFailureReason = '';

        constructor(config: IMemoryConfig, apiKey: string) {
                this.apiKey = apiKey;
                this.model = config.embedModel || 'text-embedding-3-small';
                this.baseUrl = (config.openaiBaseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
        }

        isEnabled(): boolean {
                return this.getStatus().status !== 'unavailable';
        }

        getStatus(): IStatusDetail {
                if (this._consecutiveFailures === 0) {
                        return {
                                status: 'available',
                                reason: `OpenAI embedding service available (${this.baseUrl}, model: ${this.model})`,
                        };
                }
                if (this._consecutiveFailures >= UNAVAILABLE_THRESHOLD) {
                        return {
                                status: 'unavailable',
                                reason: `OpenAI embedding backend failed ${this._consecutiveFailures} consecutive times. ` +
                                        `Last failure: ${this._lastFailureReason}. ` +
                                        `Check your API key and network connectivity.`,
                        };
                }
                return {
                        status: 'degraded',
                        reason: `OpenAI embedding backend degraded (${this._consecutiveFailures} consecutive failures). ` +
                                `Last failure: ${this._lastFailureReason}. Retries will continue.`,
                };
        }

        async embed(text: string): Promise<EmbeddingResult> {
                try {
                        const response = await fetch(`${this.baseUrl}/embeddings`, {
                                method: 'POST',
                                headers: {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${this.apiKey}`,
                                },
                                body: JSON.stringify({
                                        model: this.model,
                                        input: text,
                                }),
                                signal: AbortSignal.timeout(15_000),
                        });

                        if (!response.ok) {
                                const errText = await response.text().catch(() => '');
                                this._recordFailure(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
                                return null;
                        }

                        const data = await response.json() as {
                                data?: Array<{ embedding?: number[] }>;
                        };

                        if (!data.data?.[0]?.embedding || !Array.isArray(data.data[0].embedding) || data.data[0].embedding.length === 0) {
                                this._recordFailure('Empty or invalid embedding response from OpenAI');
                                return null;
                        }

                        // Success — reset failure counter
                        if (this._consecutiveFailures > 0) {
                                logger.info(`[EmbeddingService] OpenAI recovered after ${this._consecutiveFailures} consecutive failures. Status → available.`);
                        }
                        this._consecutiveFailures = 0;
                        this._lastFailureReason = '';

                        if (this._dimension === null) {
                                this._dimension = data.data[0].embedding.length;
                        }

                        return data.data[0].embedding;
                } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this._recordFailure(msg);
                        return null;
                }
        }

        getDimension(): number | null {
                return this._dimension;
        }

        private _recordFailure(reason: string): void {
                this._consecutiveFailures++;
                this._lastFailureReason = reason;

                if (this._consecutiveFailures === 1) {
                        logger.warn(`[EmbeddingService] OpenAI embedding failed: ${reason}. Status → degraded.`);
                } else if (this._consecutiveFailures >= UNAVAILABLE_THRESHOLD) {
                        logger.error(
                                `[EmbeddingService] OpenAI embedding UNAVAILABLE after ${this._consecutiveFailures} consecutive failures. ` +
                                `Last failure: ${reason}.`,
                        );
                } else {
                        logger.warn(`[EmbeddingService] OpenAI embedding failure #${this._consecutiveFailures}: ${reason}`);
                }
        }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory: create an embedding service from the memory config.
 */
export function createEmbeddingService(config: IMemoryConfig): IEmbeddingService {
        switch (config.embedProvider) {
                case 'ollama':
                        return new OllamaEmbeddingService(config);
                case 'openai': {
                        // OpenAI embedding requires an API key. If we can get one from the
                        // app state secrets, create the real service; otherwise fall back to
                        // NullEmbeddingService with a clear reason.
                        try {
                                // eslint-disable-next-line @typescript-eslint/no-require-imports
                                const { getAppState } = require('../platform/appState');
                                const secrets = getAppState().secrets;
                                // getSecret is async, but the factory is synchronous. We create
                                // the service optimistically — if the key isn't set, the first
                                // embed() call will fail and H-1 status tracking kicks in.
                                const service = new OpenAIEmbeddingService(config, '__pending__');
                                // Async key resolution: replace the placeholder key on first use
                                secrets.get('kovix.apiKey.openai').then((key: string | undefined) => {
                                        if (key) {
                                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                                (service as any).apiKey = key;
                                        }
                                }).catch(() => {});
                                return service;
                        } catch {
                                return new NullEmbeddingService(
                                        'OpenAI embedding provider: could not initialize (secrets unavailable). ' +
                                        'Set kovix.memoryEmbedProvider to "ollama" and start Ollama locally.',
                                );
                        }
                }
                case 'none':
                default:
                        return new NullEmbeddingService();
        }
}
