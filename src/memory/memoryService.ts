/**
 * memoryService.ts — Orchestration layer for M5 semantic memory (v1.0-beta).
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.workspace.getConfiguration → getAppState().config
 */

import { createEmbeddingService, type IEmbeddingService } from './embeddingService';
import { VectorStore } from './vectorStore';
import { wrapMemoryContext } from '../agent/promptSanitizer';
import type { IMemoryConfig, IMemoryMatch } from './types';
import { getAppState, isAppStateInitialized } from '../platform/appState';

export interface IMemoryService {
	isEnabled(): boolean;
	store(text: string, metadata?: Record<string, unknown>): Promise<void>;
	retrieve(query: string, k?: number): Promise<string>;
	retrieveRaw(query: string, k?: number): Promise<IMemoryMatch[]>;
	get size(): number;
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
		const matches = await this.retrieveRaw(query, k);
		if (matches.length === 0) return '';

		const lines = matches.map((m, i) => {
			const score = m.score.toFixed(2);
			const ts = m.timestamp.split('T')[0];
			return `[${i + 1}] (similarity ${score}, ${ts})\n${m.text}`;
		});
		const combined = lines.join('\n\n---\n\n');
		return wrapMemoryContext(combined);
	}

	async retrieveRaw(query: string, k = 5): Promise<IMemoryMatch[]> {
		if (!this.isEnabled() || !query.trim()) return [];

		const embedding = await this.embedder.embed(query);
		if (!embedding) return [];

		const store = await this.ensureStore(embedding.length);
		return store.search(embedding, k);
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
			const matches = await svc.retrieveRaw(query, k);
			if (matches.length === 0) return '';
			const lines = matches.map((m, i) => `[${i + 1}] (similarity ${m.score.toFixed(2)})\n${m.text}`);
			return wrapMemoryContext(lines.join('\n\n---\n\n'));
		},
		retrieveRaw: async (query, k = 5) => {
			if (!embedder.isEnabled() || !query.trim()) return [];
			const emb = await embedder.embed(query);
			if (!emb) return [];
			if (!_store) return [];
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
