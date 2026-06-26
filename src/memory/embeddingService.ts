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
 * Security: SEC-6 — embedding text is sent to the local Ollama instance
 * only (no remote calls). The Ollama base URL is constrained to localhost
 * by default; if a user overrides it to a remote URL, that's their choice.
 *
 * Decisions referenced: D-007, R-007, Phase 8-A (local-only).
 */

import type { IMemoryConfig } from './types';

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
}

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
 */
export class OllamaEmbeddingService implements IEmbeddingService {
	private readonly baseUrl: string;
	private readonly model: string;
	private _dimension: number | null = null;

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
				return null;
			}

			const data = (await response.json()) as { embedding?: number[] };
			if (!data.embedding || !Array.isArray(data.embedding) || data.embedding.length === 0) {
				return null;
			}

			// Cache the dimension on first success so the vector store can
			// initialise its index with the right size.
			if (this._dimension === null) {
				this._dimension = data.embedding.length;
			}

			return data.embedding;
		} catch {
			// Network error, timeout, JSON parse error — all degrade to null.
			return null;
		}
	}

	getDimension(): number | null {
		return this._dimension;
	}
}

/**
 * Null embedding service — used when embedProvider === 'none' or when an
 * unimplemented provider (e.g. 'openai' in v1.0-beta) is selected.
 * Always returns null. The memory service checks isEnabled() before
 * attempting any storage/retrieval.
 */
export class NullEmbeddingService implements IEmbeddingService {
	isEnabled(): boolean {
		return false;
	}
	async embed(_text: string): Promise<EmbeddingResult> {
		return null;
	}
	getDimension(): number | null {
		return null;
	}
}

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
