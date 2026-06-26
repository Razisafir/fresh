/**
 * vectorStore.ts — HNSW vector index wrapper (M5, v1.0-beta).
 *
 * Wraps hnswlib-node's HierarchicalNSW for cosine-similarity search. The
 * index is persisted to disk so memories survive across sessions.
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
import { HierarchicalNSW } from 'hnswlib-node';
import type { IMemoryEntry, IMemoryMatch } from './types';

const DEFAULT_MAX_ELEMENTS = 10_000;
const DEFAULT_M = 16;
const DEFAULT_EF_CONSTRUCTION = 200;
const DEFAULT_EF_SEARCH = 50;

/**
 * In-process vector store backed by hnswlib-node.
 *
 * Lifecycle:
 *   1. `new VectorStore(dim)` — creates an empty in-memory index.
 *   2. `add(entries)` — inserts vectors + text.
 *   3. `search(queryVec, k)` — returns k nearest matches.
 *   4. `save()` / `load()` — persist/restore from disk.
 */
export class VectorStore {
        private readonly dimension: number;
        private readonly index: HierarchicalNSW;
        private readonly entries: Map<number, IMemoryEntry> = new Map();
        private nextLabel = 0;
        private readonly indexDir: string;
        private readonly indexFilePath: string;
        private readonly entriesFilePath: string;

        constructor(dimension: number, opts?: { storageDir?: string }) {
                this.dimension = dimension;
                this.index = new HierarchicalNSW('cosine', dimension);
                this.index.initIndex(DEFAULT_MAX_ELEMENTS, DEFAULT_M, DEFAULT_EF_CONSTRUCTION);

                const dir = opts?.storageDir ?? path.join(os.homedir(), '.kovix', 'memory');
                this.indexDir = dir;
                this.indexFilePath = path.join(dir, 'index.bin');
                this.entriesFilePath = path.join(dir, 'entries.json');
        }

        /**
         * Add a vector + its text entry to the index.
         * Returns the assigned label (ID).
         */
        add(vector: number[], entry: Omit<IMemoryEntry, 'id'>): number {
                if (vector.length !== this.dimension) {
                        throw new Error(
                                `Vector dimension mismatch: index is ${this.dimension}, got ${vector.length}`,
                        );
                }

                // Grow the index if we're about to exceed capacity.
                if (this.nextLabel >= this.index.getCurrentCount() + 100) {
                        this.index.resizeIndex(this.index.getCurrentCount() * 2);
                }

                const label = this.nextLabel++;
                this.index.addPoint(vector, label, false);
                this.entries.set(label, { ...entry, id: label });
                return label;
        }

        /**
         * Search for the k nearest vectors to the query.
         * Returns matches sorted by descending similarity (best first).
         */
        search(queryVector: number[], k: number): IMemoryMatch[] {
                if (this.nextLabel === 0) {
                        return [];
                }
                if (queryVector.length !== this.dimension) {
                        throw new Error(
                                `Query dimension mismatch: index is ${this.dimension}, got ${queryVector.length}`,
                        );
                }

                // Set efSearch before each query — higher = more accurate, slower.
                this.index.setEf(Math.max(k, DEFAULT_EF_SEARCH));
                const result = this.index.searchKnn(queryVector, Math.min(k, this.nextLabel));

                const matches: IMemoryMatch[] = [];
                for (let i = 0; i < result.neighbors.length; i++) {
                        const label = result.neighbors[i];
                        const entry = this.entries.get(label);
                        if (!entry) continue;
                        // hnswlib cosine distance = 1 - cosine_similarity. Convert back.
                        const distance = result.distances[i];
                        const similarity = 1 - distance;
                        matches.push({ ...entry, score: similarity });
                }
                return matches.sort((a, b) => b.score - a.score);
        }

        /**
         * Persist the index + entries to disk.
         * Creates the storage directory if it doesn't exist.
         */
        save(): void {
                fs.mkdirSync(this.indexDir, { recursive: true });
                this.index.writeIndexSync(this.indexFilePath);
                const entriesArray = Array.from(this.entries.values());
                fs.writeFileSync(this.entriesFilePath, JSON.stringify(entriesArray, null, 2), 'utf8');
        }

        /**
         * Load the index + entries from disk.
         * If the files don't exist or are corrupted, starts fresh (no throw).
         */
        load(): void {
                try {
                        if (!fs.existsSync(this.indexFilePath) || !fs.existsSync(this.entriesFilePath)) {
                                return; // fresh start
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
                        // Corrupted index/entries — start fresh. Don't crash the agent.
                        this.entries.clear();
                        this.nextLabel = 0;
                }
        }

        /** Number of entries currently in the store. */
        get size(): number {
                return this.entries.size;
        }

        /** The vector dimension this store was initialised with. */
        get dim(): number {
                return this.dimension;
        }
}
