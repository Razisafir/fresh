/**
 * types.ts — Shared types for the memory service (M5, v1.0-beta).
 *
 * The memory service stores text entries (e.g. task descriptions + outcomes)
 * with their embedding vectors, and retrieves the k most similar entries
 * for a given query. Used by agentLoop.ts to inject relevant context from
 * prior tasks before planning.
 *
 * Decisions referenced: D-007 (memory deferred to v1.0-beta), R-007 (old
 * repo's keyword-only scoring bug — NOT carried forward; we use semantic
 * embedding similarity).
 * Security: SEC-6 (all retrieved memory is sanitised via wrapMemoryContext
 * before injection into the LLM context).
 */

/**
 * A single memory entry stored in the vector index.
 */
export interface IMemoryEntry {
	/** Unique ID (used as the HNSW label). */
	id: number;
	/** The original text content (pre-embedding). */
	text: string;
	/** When the entry was stored (ISO 8601). */
	timestamp: string;
	/** Optional metadata (e.g. task type, source). */
	metadata?: Record<string, unknown>;
}

/**
 * A retrieved memory entry, with its similarity score.
 */
export interface IMemoryMatch extends IMemoryEntry {
	/** Cosine similarity score in [0, 1]. Higher = more similar. */
	score: number;
}

/**
 * Configuration for the memory service, derived from VS Code settings
 * (kovix.memory.*).
 */
export interface IMemoryConfig {
	/** 'ollama' | 'openai' | 'none'. 'none' disables the service. */
	embedProvider: 'ollama' | 'openai' | 'none';
	/** Embedding model name (e.g. 'nomic-embed-text'). */
	embedModel: string;
	/** Vector store backend. Only 'in-process' (hnswlib-node) is wired. */
	vectorStore: 'in-process' | 'qdrant';
	/** Ollama API base URL (default http://localhost:11434). */
	ollamaBaseUrl?: string;
}
