/**
 * memoryService.ts — Orchestration layer for M5 semantic memory (v1.0-beta).
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.workspace.getConfiguration → getAppState().config
 *
 * H-1 FIX: Memory retrieval now surfaces degradation status. When the
 * embedding backend is unavailable or degraded, retrieve() and
 * retrieveRaw() return results tagged with a `degraded` flag so the
 * caller (agent loop, UI) can inform the user that memory search
 * quality is reduced.
 */

import { createEmbeddingService, type IEmbeddingService, type EmbeddingServiceStatus } from './embeddingService';
import { VectorStore } from './vectorStore';
import { wrapMemoryContext } from '../agent/promptSanitizer';
import type { IMemoryConfig, IMemoryMatch } from './types';
import { getAppState, isAppStateInitialized } from '../platform/appState';
import { logger } from '../util/logger';

/**
 * Result of a memory retrieval, with degradation metadata.
 */
export interface IRetrieveResult {
        /** The formatted memory context string (empty if no matches). */
        context: string;
        /** Whether the retrieval was degraded (embedding backend down/unavailable). */
        degraded: boolean;
        /** Reason for degradation, if degraded=true. Human-readable. */
        degradationReason?: string;
        /** Number of matches found. */
        matchCount: number;
}

export interface IMemoryService {
        isEnabled(): boolean;
        store(text: string, metadata?: Record<string, unknown>): Promise<void>;
        retrieve(query: string, k?: number): Promise<string>;
        retrieveRaw(query: string, k?: number): Promise<IMemoryMatch[]>;
        /**
         * Retrieve with degradation metadata.
         * H-1 fix: callers should prefer this method to know whether results
         * are trustworthy or whether the embedding backend is down.
         */
        retrieveWithStatus(query: string, k?: number): Promise<IRetrieveResult>;
        /** Get the current embedding service status. */
        getEmbeddingStatus(): { status: EmbeddingServiceStatus; reason: string };
        get size(): number;
        dispose(): void;
}

class MemoryServiceImpl implements IMemoryService {
        private readonly config: IMemoryConfig;
        private readonly embedder: IEmbeddingService;
        private _store: VectorStore | null = null;
        private _loadPromise: Promise<void> | null = null;
        private _unavailableWarningLogged = false;

        constructor() {
                this.config = this.readConfig();
                this.embedder = createEmbeddingService(this.config);
        }

        isEnabled(): boolean {
                return this.embedder.isEnabled();
        }

        getEmbeddingStatus(): { status: EmbeddingServiceStatus; reason: string } {
                const detail = this.embedder.getStatus();
                return { status: detail.status, reason: detail.reason };
        }

        async store(text: string, metadata?: Record<string, unknown>): Promise<void> {
                if (!this.isEnabled() || !text.trim()) return;

                const embedding = await this.embedder.embed(text);
                if (!embedding) return;

                const store = await this.ensureStore(embedding.length);
                store.add(embedding, {
                        text,
                        timestamp: new Date().toISOString(),
                        metadata,
                });
                store.save();
        }

        async retrieve(query: string, k = 5): Promise<string> {
                const result = await this.retrieveWithStatus(query, k);
                return result.context;
        }

        async retrieveRaw(query: string, k = 5): Promise<IMemoryMatch[]> {
                if (!this.isEnabled() || !query.trim()) return [];

                const embedding = await this.embedder.embed(query);
                if (!embedding) return [];

                const store = await this.ensureStore(embedding.length);
                return store.search(embedding, k);
        }

        async retrieveWithStatus(query: string, k = 5): Promise<IRetrieveResult> {
                const status = this.embedder.getStatus();

                // If embedding backend is unavailable, return degraded result immediately
                // without even trying to embed (avoids unnecessary network timeout).
                // Only log the warning once to avoid spamming the console.
                if (status.status === 'unavailable') {
                        if (!this._unavailableWarningLogged) {
                                logger.warn(`[MemoryService] Embedding backend unavailable — memory search disabled. Reason: ${status.reason}`);
                                this._unavailableWarningLogged = true;
                        }
                        return {
                                context: '',
                                degraded: true,
                                degradationReason: status.reason,
                                matchCount: 0,
                        };
                }

                // Reset warning flag if backend recovers
                if (this._unavailableWarningLogged && status.status === 'available') {
                        this._unavailableWarningLogged = false;
                }

                if (!query.trim()) {
                        return { context: '', degraded: false, matchCount: 0 };
                }

                const embedding = await this.embedder.embed(query);
                if (!embedding) {
                        // Embedding failed — check current status for the reason
                        const currentStatus = this.embedder.getStatus();
                        if (!this._unavailableWarningLogged) {
                                logger.warn(`[MemoryService] Embedding failed for query, returning degraded result. Status: ${currentStatus.status}`);
                                if (currentStatus.status === 'unavailable') {
                                        this._unavailableWarningLogged = true;
                                }
                        }
                        return {
                                context: '',
                                degraded: true,
                                degradationReason: currentStatus.reason,
                                matchCount: 0,
                        };
                }

                const store = await this.ensureStore(embedding.length);
                const matches = store.search(embedding, k);

                if (matches.length === 0) {
                        return {
                                context: '',
                                degraded: status.status === 'degraded',
                                degradationReason: status.status === 'degraded' ? status.reason : undefined,
                                matchCount: 0,
                        };
                }

                const lines = matches.map((m, i) => {
                        const score = m.score.toFixed(2);
                        const ts = m.timestamp.split('T')[0];
                        return `[${i + 1}] (similarity ${score}, ${ts})\n${m.text}`;
                });
                const combined = lines.join('\n\n---\n\n');

                return {
                        context: wrapMemoryContext(combined),
                        degraded: status.status === 'degraded',
                        degradationReason: status.status === 'degraded' ? status.reason : undefined,
                        matchCount: matches.length,
                };
        }

        get size(): number {
                return this._store?.size ?? 0;
        }

        dispose(): void {
                this._store = null;
        }

        private async ensureStore(dimension: number): Promise<VectorStore> {
                if (this._store && this._store.dim === dimension) {
                        return this._store;
                }
                if (this._store && this._store.dim !== dimension) {
                        this._store = null;
                }
                if (!this._loadPromise) {
                        this._loadPromise = (async () => {
                                const store = new VectorStore(dimension);
                                store.load();
                                this._store = store;
                        })();
                }
                await this._loadPromise;
                this._loadPromise = null;
                if (this._store!.dim !== dimension) {
                        this._store = new VectorStore(dimension);
                }
                return this._store!;
        }

        private readConfig(): IMemoryConfig {
                if (!isAppStateInitialized()) {
                        return {
                                embedProvider: 'none',
                                embedModel: 'nomic-embed-text',
                                vectorStore: 'in-process',
                        };
                }
                const cfg = getAppState().config;
                return {
                        embedProvider: cfg.memoryEmbedProvider as IMemoryConfig['embedProvider'],
                        embedModel: cfg.memoryEmbedModel,
                        vectorStore: cfg.memoryVectorStore as IMemoryConfig['vectorStore'],
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

export function _createForTest(embedder: IEmbeddingService): IMemoryService {
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
                        const result = await svc.retrieveWithStatus(query, k);
                        return result.context;
                },
                retrieveRaw: async (query, k = 5) => {
                        if (!embedder.isEnabled() || !query.trim()) return [];
                        const emb = await embedder.embed(query);
                        if (!emb) return [];
                        if (!_store) return [];
                        return _store.search(emb, k);
                },
                retrieveWithStatus: async (query, k = 5) => {
                        const status = embedder.getStatus();
                        if (status.status === 'unavailable') {
                                return { context: '', degraded: true, degradationReason: status.reason, matchCount: 0 };
                        }
                        if (!query.trim()) {
                                return { context: '', degraded: false, matchCount: 0 };
                        }
                        const emb = await embedder.embed(query);
                        if (!emb) {
                                return { context: '', degraded: true, degradationReason: embedder.getStatus().reason, matchCount: 0 };
                        }
                        const store = ensureStore(emb.length);
                        const matches = store.search(emb, k);
                        if (matches.length === 0) {
                                return { context: '', degraded: status.status === 'degraded', degradationReason: status.status === 'degraded' ? status.reason : undefined, matchCount: 0 };
                        }
                        const lines = matches.map((m, i) => `[${i + 1}] (similarity ${m.score.toFixed(2)})\n${m.text}`);
                        return {
                                context: wrapMemoryContext(lines.join('\n\n---\n\n')),
                                degraded: status.status === 'degraded',
                                degradationReason: status.status === 'degraded' ? status.reason : undefined,
                                matchCount: matches.length,
                        };
                },
                getEmbeddingStatus: () => {
                        const detail = embedder.getStatus();
                        return { status: detail.status, reason: detail.reason };
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
