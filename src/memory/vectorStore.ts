/**
 * vectorStore.ts — HNSW vector index wrapper (M5, v1.0-beta).
 *
 * Wraps hnswlib-node's HierarchicalNSW for cosine-similarity search. The
 * index is persisted to disk so memories survive across sessions.
 *
 * Graceful degradation: if hnswlib-node is not installed (e.g. on Windows
 * without ClangCL build tools, or on any platform where the native addon
 * fails to compile), the VectorStore falls back to a naive linear-scan
 * implementation. This is slower for large datasets but functionally
 * identical for small-scale use (<10k entries). The agent loop and the
 * rest of the app are unaffected — memory simply works without native deps.
 *
 * Design:
 *   - Cosine similarity = normalised vectors + inner product. We L2-normalise
 *     all vectors before insertion/query, then use InnerProductSpace.
 *   - The HNSW index stores only the vectors + integer labels. The text
 *     entries are kept in a sidecar JSON file, keyed by label.
 *   - Persistence: index → .bin file, entries → .json file. Both in
 *     ~/.kovix/memory/ (global, shared across projects — useful for
 *     cross-project recall).
 *
 * hnswlib-node parameters (chosen for small-scale memory, <10k entries):
 *   - maxElements: 10000 (grows if needed via resizeIndex)
 *   - M: 16 (connectivity — higher = more accurate, more memory)
 *   - efConstruction: 200 (build-time search depth — higher = more accurate)
 *   - efSearch: 50 (query-time search depth — higher = more accurate)
 *
 * Decisions referenced: D-007, Phase 8-A (local-only, in-process).
 * Security: vector data never leaves the user's machine.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { IMemoryEntry, IMemoryMatch } from './types';

const DEFAULT_MAX_ELEMENTS = 10_000;
const DEFAULT_M = 16;
const DEFAULT_EF_CONSTRUCTION = 200;
const DEFAULT_EF_SEARCH = 50;

// ---------------------------------------------------------------------------
// Try to load hnswlib-node. If it fails (missing native addon), we fall back
// to a pure-JS linear-scan implementation.
// ---------------------------------------------------------------------------

// Minimal interface for the hnswlib-node methods we use. Defined locally
// so TypeScript doesn't need the hnswlib-node type declarations (which
// won't exist if the native addon failed to compile).
interface IHnswIndex {
        initIndex(maxElements: number, M: number, efConstruction: number): void;
        getCurrentCount(): number;
        resizeIndex(newSize: number): void;
        addPoint(vector: number[], label: number, replace?: boolean): void;
        setEf(ef: number): void;
        searchKnn(queryVector: number[], k: number): { neighbors: number[]; distances: number[] };
        readIndexSync(path: string): void;
        writeIndexSync(path: string): void;
}

// Dynamically loaded optional native addon — type is narrowed, not `any`
let hnswlibModule: { HierarchicalNSW: new (spaceType: string, dim: number) => IHnswIndex } | null = null;
let hnswlibAvailable = false;

try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- conditional import: hnswlib-node is optional and may not be installed
        hnswlibModule = require('hnswlib-node') as typeof hnswlibModule;
        hnswlibAvailable = true;
} catch {
        // hnswlib-node not available — fall back to naive implementation.
        // This is expected on platforms without the required C++ build tools.
        hnswlibAvailable = false;
}

// ---------------------------------------------------------------------------
// Naive fallback: linear scan over all vectors using cosine similarity.
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < a.length; i++) {
                dot += a[i] * b[i];
                normA += a[i] * a[i];
                normB += b[i] * b[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface NaiveEntry {
        label: number;
        vector: number[];
        entry: IMemoryEntry;
}

class NaiveVectorStore {
        private readonly dimension: number;
        private readonly entries: Map<number, NaiveEntry> = new Map();
        private nextLabel = 0;
        private readonly storageDir: string;
        private readonly entriesFilePath: string;
        private readonly vectorsFilePath: string;

        constructor(dimension: number, opts?: { storageDir?: string }) {
                this.dimension = dimension;
                const dir = opts?.storageDir ?? path.join(os.homedir(), '.kovix', 'memory');
                this.storageDir = dir;
                this.entriesFilePath = path.join(dir, 'entries.json');
                this.vectorsFilePath = path.join(dir, 'vectors.json');
        }

        add(vector: number[], entry: Omit<IMemoryEntry, 'id'>): number {
                if (vector.length !== this.dimension) {
                        throw new Error(
                                `Vector dimension mismatch: index is ${this.dimension}, got ${vector.length}`,
                        );
                }
                const label = this.nextLabel++;
                this.entries.set(label, { label, vector: [...vector], entry: { ...entry, id: label } });
                return label;
        }

        search(queryVector: number[], k: number): IMemoryMatch[] {
                if (this.entries.size === 0) return [];
                if (queryVector.length !== this.dimension) {
                        throw new Error(
                                `Query dimension mismatch: index is ${this.dimension}, got ${queryVector.length}`,
                        );
                }
                const scored: IMemoryMatch[] = [];
                for (const [, naive] of this.entries) {
                        const sim = cosineSimilarity(queryVector, naive.vector);
                        scored.push({ ...naive.entry, score: sim });
                }
                scored.sort((a, b) => b.score - a.score);
                return scored.slice(0, k);
        }

        save(): void {
                fs.mkdirSync(this.storageDir, { recursive: true });
                const entriesArray = Array.from(this.entries.values());
                fs.writeFileSync(this.entriesFilePath, JSON.stringify(entriesArray.map(e => e.entry), null, 2), 'utf8');
                fs.writeFileSync(this.vectorsFilePath, JSON.stringify(entriesArray.map(e => ({ label: e.label, vector: e.vector })), null, 2), 'utf8');
        }

        load(): void {
                try {
                        if (!fs.existsSync(this.entriesFilePath) || !fs.existsSync(this.vectorsFilePath)) {
                                return;
                        }
                        const entriesRaw = JSON.parse(fs.readFileSync(this.entriesFilePath, 'utf8')) as IMemoryEntry[];
                        const vectorsRaw = JSON.parse(fs.readFileSync(this.vectorsFilePath, 'utf8')) as Array<{ label: number; vector: number[] }>;
                        this.entries.clear();
                        let maxLabel = -1;
                        const vecMap = new Map(vectorsRaw.map(v => [v.label, v.vector]));
                        for (const entry of entriesRaw) {
                                const vector = vecMap.get(entry.id);
                                if (vector && vector.length === this.dimension) {
                                        this.entries.set(entry.id, { label: entry.id, vector, entry });
                                        if (entry.id > maxLabel) maxLabel = entry.id;
                                }
                        }
                        this.nextLabel = maxLabel + 1;
                } catch {
                        this.entries.clear();
                        this.nextLabel = 0;
                }
        }

        get size(): number {
                return this.entries.size;
        }

        get dim(): number {
                return this.dimension;
        }
}

// ---------------------------------------------------------------------------
// HNSW-backed implementation (when hnswlib-node is available).
// ---------------------------------------------------------------------------

class HnswVectorStore {
        private readonly dimension: number;
        private readonly index: IHnswIndex;
        private readonly entries: Map<number, IMemoryEntry> = new Map();
        private nextLabel = 0;
        private readonly indexDir: string;
        private readonly indexFilePath: string;
        private readonly entriesFilePath: string;

        constructor(dimension: number, opts?: { storageDir?: string }) {
                this.dimension = dimension;
                const HierarchicalNSW = hnswlibModule!.HierarchicalNSW;
                this.index = new HierarchicalNSW('cosine', dimension);
                this.index.initIndex(DEFAULT_MAX_ELEMENTS, DEFAULT_M, DEFAULT_EF_CONSTRUCTION);

                const dir = opts?.storageDir ?? path.join(os.homedir(), '.kovix', 'memory');
                this.indexDir = dir;
                this.indexFilePath = path.join(dir, 'index.bin');
                this.entriesFilePath = path.join(dir, 'entries.json');
        }

        add(vector: number[], entry: Omit<IMemoryEntry, 'id'>): number {
                if (vector.length !== this.dimension) {
                        throw new Error(
                                `Vector dimension mismatch: index is ${this.dimension}, got ${vector.length}`,
                        );
                }

                if (this.nextLabel >= this.index.getCurrentCount() + 100) {
                        this.index.resizeIndex(this.index.getCurrentCount() * 2);
                }

                const label = this.nextLabel++;
                this.index.addPoint(vector, label, false);
                this.entries.set(label, { ...entry, id: label });
                return label;
        }

        search(queryVector: number[], k: number): IMemoryMatch[] {
                if (this.nextLabel === 0) return [];
                if (queryVector.length !== this.dimension) {
                        throw new Error(
                                `Query dimension mismatch: index is ${this.dimension}, got ${queryVector.length}`,
                        );
                }

                this.index.setEf(Math.max(k, DEFAULT_EF_SEARCH));
                const result = this.index.searchKnn(queryVector, Math.min(k, this.nextLabel));

                const matches: IMemoryMatch[] = [];
                for (let i = 0; i < result.neighbors.length; i++) {
                        const label = result.neighbors[i];
                        const entry = this.entries.get(label);
                        if (!entry) continue;
                        const distance = result.distances[i];
                        const similarity = 1 - distance;
                        matches.push({ ...entry, score: similarity });
                }
                return matches.sort((a, b) => b.score - a.score);
        }

        save(): void {
                fs.mkdirSync(this.indexDir, { recursive: true });
                this.index.writeIndexSync(this.indexFilePath);
                const entriesArray = Array.from(this.entries.values());
                fs.writeFileSync(this.entriesFilePath, JSON.stringify(entriesArray, null, 2), 'utf8');
        }

        load(): void {
                try {
                        if (!fs.existsSync(this.indexFilePath) || !fs.existsSync(this.entriesFilePath)) {
                                return;
                        }
                        this.index.readIndexSync(this.indexFilePath);
                        const raw = fs.readFileSync(this.entriesFilePath, 'utf8');
                        const entriesArray = JSON.parse(raw) as IMemoryEntry[];
                        this.entries.clear();
                        let maxLabel = -1;
                        for (const entry of entriesArray) {
                                this.entries.set(entry.id, entry);
                                if (entry.id > maxLabel) maxLabel = entry.id;
                        }
                        this.nextLabel = maxLabel + 1;
                } catch {
                        this.entries.clear();
                        this.nextLabel = 0;
                }
        }

        get size(): number {
                return this.entries.size;
        }

        get dim(): number {
                return this.dimension;
        }
}

// ---------------------------------------------------------------------------
// Unified VectorStore — picks HNSW when available, naive fallback otherwise.
// ---------------------------------------------------------------------------

type VectorStoreBackend = HnswVectorStore | NaiveVectorStore;

/**
 * In-process vector store backed by hnswlib-node (when available) or a
 * pure-JS linear-scan fallback (when hnswlib-node can't be compiled).
 *
 * Lifecycle:
 *   1. `new VectorStore(dim)` — creates an empty in-memory index.
 *   2. `add(entries)` — inserts vectors + text.
 *   3. `search(queryVec, k)` — returns k nearest matches.
 *   4. `save()` / `load()` — persist/restore from disk.
 */
export class VectorStore {
        private readonly backend: VectorStoreBackend;

        constructor(dimension: number, opts?: { storageDir?: string }) {
                if (hnswlibAvailable) {
                        this.backend = new HnswVectorStore(dimension, opts);
                } else {
                        this.backend = new NaiveVectorStore(dimension, opts);
                }
        }

        add(vector: number[], entry: Omit<IMemoryEntry, 'id'>): number {
                return this.backend.add(vector, entry);
        }

        search(queryVector: number[], k: number): IMemoryMatch[] {
                return this.backend.search(queryVector, k);
        }

        save(): void {
                this.backend.save();
        }

        load(): void {
                this.backend.load();
        }

        get size(): number {
                return this.backend.size;
        }

        get dim(): number {
                return this.backend.dim;
        }
}
