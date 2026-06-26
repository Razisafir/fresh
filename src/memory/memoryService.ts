/**
 * memoryService.ts — Orchestration layer for M5 semantic memory (v1.0-beta).
 *
 * Brings together the embedding service + vector store into a single
 * facade that the agent loop calls. Handles:
 *   - Reading config from VS Code settings (kovix.memory.*)
 *   - Lazily initialising the embedding service + vector store on first use
 *   - Degrading gracefully when embedProvider=none or Ollama is down
 *   - Persisting the index to disk after each store() call
 *   - Retrieving relevant memories for a query and returning them as
 *     sanitised text ready for injection into the LLM context
 *
 * Singleton: one instance per extension host. Access via getMemoryService().
 *
 * Security: SEC-6 — all retrieved memory text is passed through
 * wrapMemoryContext() before being returned, which sanitises it (strips
 * control chars, injection prefixes) and wraps it in an XML tag with a
 * comment marking it as user-provided context (not system instructions).
 *
 * Decisions referenced: D-007, R-007, Phase 8-A (local-only, graceful degrade).
 */

import * as vscode from 'vscode';
import { createEmbeddingService, type IEmbeddingService } from './embeddingService';
import { VectorStore } from './vectorStore';
import { wrapMemoryContext } from '../agent/promptSanitizer';
import type { IMemoryConfig, IMemoryMatch } from './types';

/**
 * The memory service facade. All methods are safe to call even when memory
 * is disabled — they return empty results / no-op.
 */
export interface IMemoryService {
        /** True if embeddings + vector store are active (provider != none). */
        isEnabled(): boolean;
        /** Store a memory entry. No-op if disabled. */
        store(text: string, metadata?: Record<string, unknown>): Promise<void>;
        /** Retrieve the k most similar memories for a query, as sanitised context. */
        retrieve(query: string, k?: number): Promise<string>;
        /** Retrieve raw matches (for testing / debugging). */
        retrieveRaw(query: string, k?: number): Promise<IMemoryMatch[]>;
        /** Number of stored entries. */
        get size(): number;
        /** Release resources (close file handles, etc.). */
        dispose(): void;
}

class MemoryServiceImpl implements IMemoryService {
        private readonly config: IMemoryConfig;
        private readonly embedder: IEmbeddingService;
        private _store: VectorStore | null = null;
        private _loadPromise: Promise<void> | null = null;

        constructor() {
                this.config = this.readConfig();
                this.embedder = createEmbeddingService(this.config);
        }

        isEnabled(): boolean {
                return this.embedder.isEnabled();
        }

        async store(text: string, metadata?: Record<string, unknown>): Promise<void> {
                if (!this.isEnabled() || !text.trim()) return;

                const embedding = await this.embedder.embed(text);
                if (!embedding) return; // Ollama down or error — degrade gracefully

                const store = await this.ensureStore(embedding.length);
                store.add(embedding, {
                        text,
                        timestamp: new Date().toISOString(),
                        metadata,
                });
                store.save(); // persist after each store (cheap for <10k entries)
        }

        async retrieve(query: string, k = 5): Promise<string> {
                const matches = await this.retrieveRaw(query, k);
                if (matches.length === 0) return '';

                // Format the matches into a single context block, then sanitise + wrap.
                const lines = matches.map((m, i) => {
                        const score = m.score.toFixed(2);
                        const ts = m.timestamp.split('T')[0]; // date only
                        return `[${i + 1}] (similarity ${score}, ${ts})\n${m.text}`;
                });
                const combined = lines.join('\n\n---\n\n');
                return wrapMemoryContext(combined);
        }

        async retrieveRaw(query: string, k = 5): Promise<IMemoryMatch[]> {
                if (!this.isEnabled() || !query.trim()) return [];

                const embedding = await this.embedder.embed(query);
                if (!embedding) return []; // Ollama down — no results

                const store = await this.ensureStore(embedding.length);
                return store.search(embedding, k);
        }

        get size(): number {
                return this._store?.size ?? 0;
        }

        dispose(): void {
                // hnswlib-node doesn't have an explicit close — the index is GC'd
                // when the object goes out of scope. Save is called after each store(),
                // so there's no unsaved state to flush here.
                this._store = null;
        }

        /**
         * Lazily initialise the vector store on first use. The dimension comes
         * from the first successful embedding (so we don't need to hardcode it
         * or query Ollama separately for the model's dimension).
         */
        private async ensureStore(dimension: number): Promise<VectorStore> {
                if (this._store && this._store.dim === dimension) {
                        return this._store;
                }
                if (this._store && this._store.dim !== dimension) {
                        // Dimension changed (user switched embedding model). Re-create
                        // the store — old entries are incompatible with the new dimension.
                        // The old index file on disk is now stale; it will be overwritten
                        // on the next save(). This is a known v1.0-beta limitation.
                        this._store = null;
                }
                if (!this._loadPromise) {
                        this._loadPromise = (async () => {
                                const store = new VectorStore(dimension);
                                store.load(); // load existing entries from disk
                                this._store = store;
                        })();
                }
                await this._loadPromise;
                this._loadPromise = null;
                // After load, check dimension again (loaded index might differ)
                if (this._store!.dim !== dimension) {
                        // Loaded index has a different dimension — start fresh
                        this._store = new VectorStore(dimension);
                }
                return this._store!;
        }

        private readConfig(): IMemoryConfig {
                const cfg = vscode.workspace.getConfiguration('kovix.memory');
                return {
                        embedProvider: cfg.get<'ollama' | 'openai' | 'none'>('embedProvider', 'ollama'),
                        embedModel: cfg.get<string>('embedModel', 'nomic-embed-text'),
                        vectorStore: cfg.get<'in-process' | 'qdrant'>('vectorStore', 'in-process'),
                };
        }
}

// --- Singleton ---

let _instance: IMemoryService | undefined;

export function getMemoryService(): IMemoryService {
        if (!_instance) {
                _instance = new MemoryServiceImpl();
        }
        return _instance;
}

export function resetMemoryService(): void {
        _instance?.dispose();
        _instance = undefined;
}

/**
 * Test-only factory: create a MemoryService with a custom embedding service
 * (e.g. a mock that returns deterministic vectors). Not exported from the
 * extension's public API; used by unit tests.
 */
export function _createForTest(embedder: IEmbeddingService): IMemoryService {
        // Single shared store — created lazily on first store() with the
        // embedder's dimension. Reused for all subsequent store/retrieve calls.
        let _store: VectorStore | null = null;

        const ensureStore = (dim: number): VectorStore => {
                if (!_store) {
                        _store = new VectorStore(dim, { storageDir: '/tmp/kovix-test-' + Date.now() });
                }
                return _store;
        };

        const svc: IMemoryService = {
                isEnabled: () => embedder.isEnabled(),
                store: async (text, metadata) => {
                        if (!embedder.isEnabled() || !text.trim()) return;
                        const emb = await embedder.embed(text);
                        if (!emb) return;
                        const store = ensureStore(emb.length);
                        store.add(emb, { text, timestamp: new Date().toISOString(), metadata });
                },
                retrieve: async (query, k = 5) => {
                        const matches = await svc.retrieveRaw(query, k);
                        if (matches.length === 0) return '';
                        const lines = matches.map((m, i) => `[${i + 1}] (similarity ${m.score.toFixed(2)})\n${m.text}`);
                        return wrapMemoryContext(lines.join('\n\n---\n\n'));
                },
                retrieveRaw: async (query, k = 5) => {
                        if (!embedder.isEnabled() || !query.trim()) return [];
                        const emb = await embedder.embed(query);
                        if (!emb) return [];
                        if (!_store) return []; // nothing stored yet
                        return _store.search(emb, k);
                },
                get size() {
                        return _store?.size ?? 0;
                },
                dispose: () => {
                        _store = null;
                },
        };
        return svc;
}
