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
 * HARVEST-1b FIX (STUB_AUDIT H-1 class — "looks fine, isn't"):
 *   The original design returned null on failure, which is better than
 *   Kovix_2.0's zero-vector silent failure, but it still had the same
 *   class of bug: **silent degradation**. When Ollama is down, the
 *   memory service silently falls back to returning empty results with
 *   no user-visible indication that embeddings are non-functional.
 *
 *   Fix: added EmbeddingStatus tracking ('available', 'degraded',
 *   'unavailable') with an onStatusChange callback. The Ollama service
 *   now tracks consecutive failures and transitions to 'degraded' after
 *   3 consecutive failures, and 'unavailable' after 10. Successful calls
 *   reset the counter. Memory retrieval marks itself as degraded when
 *   the embedding status is not 'available'. A regression test ensures
 *   the silent-failure class cannot be reintroduced.
 *
 * Security: SEC-6 — embedding text is sent to the local Ollama instance
 * only (no remote calls). The Ollama base URL is constrained to localhost
 * by default; if a user overrides it to a remote URL, that's their choice.
 *
 * Decisions referenced: D-007, R-007, Phase 8-A (local-only).
 */

import type { IMemoryConfig } from './types';

// ---------------------------------------------------------------------------
// Status tracking (HARVEST-1b fix)
// ---------------------------------------------------------------------------

/**
 * The health status of the embedding service.
 *
 *   - 'available':    Embeddings are working normally
 *   - 'degraded':     Some recent failures, but still trying (3-9 consecutive failures)
 *   - 'unavailable':  Persistent failures, embeddings are effectively down (10+ consecutive)
 *
 * Callers (especially memoryService.ts and the UI) should check this status
 * and surface it to the user — this is the "make it loud" fix for the
 * silent-degradation bug class (STUB_AUDIT H-1).
 */
export type EmbeddingStatus = 'available' | 'degraded' | 'unavailable';

/**
 * Callback type for embedding status changes. The UI can register
 * a listener to display a status badge when embeddings degrade.
 */
export type StatusChangeCallback = (status: EmbeddingStatus, previousStatus: EmbeddingStatus) => void;

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * Result of an embedding call. null means "no embedding available" (provider
 * disabled, Ollama down, network error, etc.) — callers must handle null
 * gracefully.
 */
export type EmbeddingResult = number[] | null;

/**
 * Embedding service interface.
 */
export interface IEmbeddingService {
	/** Returns true if the service can produce embeddings (provider != none). */
	isEnabled(): boolean;
	/** Embed a text string. Returns null on any failure (degrade gracefully). */
	embed(text: string): Promise<EmbeddingResult>;
	/** The dimension of vectors produced (null until first successful embed). */
	getDimension(): number | null;
	/** Current health status of the embedding service. (HARVEST-1b addition) */
	getStatus(): EmbeddingStatus;
	/** Register a callback for status changes. (HARVEST-1b addition) */
	onStatusChange(callback: StatusChangeCallback): void;
}

// ---------------------------------------------------------------------------
// Ollama embedding service (with status tracking)
// ---------------------------------------------------------------------------

/**
 * Thresholds for status transitions. After DEGRADED_THRESHOLD consecutive
 * failures, status becomes 'degraded'. After UNAVAILABLE_THRESHOLD, it
 * becomes 'unavailable'. Any success resets the counter to 0.
 */
const DEGRADED_THRESHOLD = 3;
const UNAVAILABLE_THRESHOLD = 10;

/**
 * Ollama embedding service.
 *
 * Calls `POST {baseUrl}/api/embeddings` with `{ model, prompt }`.
 * Ollama returns `{ embedding: number[] }`.
 *
 * On any error (network, HTTP non-200, malformed JSON, empty embedding),
 * returns null. The memory service treats null as "skip this entry" and
 * continues. This means a temporary Ollama outage doesn't break the agent
 * loop — it just means no new memories get stored until Ollama is back.
 *
 * HARVEST-1b: consecutive failures are now tracked and status transitions
 * fire via onStatusChange callbacks. The UI can display a badge when
 * status is 'degraded' or 'unavailable'.
 */
export class OllamaEmbeddingService implements IEmbeddingService {
	private readonly baseUrl: string;
	private readonly model: string;
	private _dimension: number | null = null;
	private _status: EmbeddingStatus = 'available';
	private _consecutiveFailures = 0;
	private readonly _statusListeners: StatusChangeCallback[] = [];

	constructor(config: IMemoryConfig) {
		this.baseUrl = (config.ollamaBaseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
		this.model = config.embedModel || 'nomic-embed-text';
	}

	isEnabled(): boolean {
		return true;
	}

	async embed(text: string): Promise<EmbeddingResult> {
		try {
			// Use the global fetch (Node 18+). No external HTTP library needed.
			const response = await fetch(`${this.baseUrl}/api/embeddings`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: this.model, prompt: text }),
				// 10s timeout — Ollama on localhost should respond in <1s for
				// a single embedding. If it's slow, something is wrong.
				signal: AbortSignal.timeout(10_000),
			});

			if (!response.ok) {
				this.recordFailure();
				return null;
			}

			const data = (await response.json()) as { embedding?: number[] };
			if (!data.embedding || !Array.isArray(data.embedding) || data.embedding.length === 0) {
				this.recordFailure();
				return null;
			}

			// Cache the dimension on first success so the vector store can
			// initialise its index with the right size.
			if (this._dimension === null) {
				this._dimension = data.embedding.length;
			}

			this.recordSuccess();
			return data.embedding;
		} catch {
			// Network error, timeout, JSON parse error — all degrade to null.
			this.recordFailure();
			return null;
		}
	}

	getDimension(): number | null {
		return this._dimension;
	}

	getStatus(): EmbeddingStatus {
		return this._status;
	}

	onStatusChange(callback: StatusChangeCallback): void {
		this._statusListeners.push(callback);
	}

	// --- Status tracking (HARVEST-1b) ---

	private recordSuccess(): void {
		if (this._consecutiveFailures > 0) {
			this._consecutiveFailures = 0;
			// Was degraded/unavailable, now recovering
			if (this._status !== 'available') {
				this.setStatus('available');
			}
		}
	}

	private recordFailure(): void {
		this._consecutiveFailures++;
		if (this._consecutiveFailures >= UNAVAILABLE_THRESHOLD) {
			if (this._status !== 'unavailable') {
				this.setStatus('unavailable');
			}
		} else if (this._consecutiveFailures >= DEGRADED_THRESHOLD) {
			if (this._status !== 'degraded') {
				this.setStatus('degraded');
			}
		}
	}

	private setStatus(newStatus: EmbeddingStatus): void {
		const previous = this._status;
		this._status = newStatus;
		for (const listener of this._statusListeners) {
			try {
				listener(newStatus, previous);
			} catch {
				// Listener errors must not break the embedding service
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Null embedding service
// ---------------------------------------------------------------------------

/**
 * Null embedding service — used when embedProvider === 'none' or when an
 * unimplemented provider (e.g. 'openai' in v1.0-beta) is selected.
 * Always returns null. The memory service checks isEnabled() before
 * attempting any storage/retrieval.
 *
 * Status is always 'unavailable' — there is no backend to fail.
 */
export class NullEmbeddingService implements IEmbeddingService {
	private readonly _statusListeners: StatusChangeCallback[] = [];

	isEnabled(): boolean {
		return false;
	}
	async embed(_text: string): Promise<EmbeddingResult> {
		return null;
	}
	getDimension(): number | null {
		return null;
	}
	getStatus(): EmbeddingStatus {
		return 'unavailable';
	}
	onStatusChange(callback: StatusChangeCallback): void {
		this._statusListeners.push(callback);
		// Immediately fire with current status so the caller knows the state
		callback('unavailable', 'unavailable');
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
		case 'openai':
			// Not implemented in v1.0-beta — degrade gracefully.
			// To implement: add an OpenAIEmbeddingService that calls
			// POST https://api.openai.com/v1/embeddings with the user's
			// OpenAI key from SecretStorage.
			return new NullEmbeddingService();
		case 'none':
		default:
			return new NullEmbeddingService();
	}
}
