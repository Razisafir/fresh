/**
 * codebaseIndexer.ts — Codebase indexing & RAG service for Kovix (v1.0-beta).
 *
 * Indexes the workspace codebase and provides relevant context for AI queries.
 * Integrates with the existing memory service (embeddingService + vectorStore).
 *
 * Architecture:
 *   1. Scanning phase  — Walk directory tree, filter by patterns, skip excluded dirs
 *   2. Reading phase   — Read file contents in parallel (capped concurrency)
 *   3. Chunking phase  — Split files into overlapping chunks by line count
 *   4. Embedding phase — If embeddings enabled, embed each chunk via embeddingService
 *                        and store in the vectorStore
 *   5. Keyword index   — Build inverted index (word → Set<chunkId>) for BM25 fallback
 *   6. Search          — Hybrid search: combine embedding similarity + keyword BM25
 *   7. File context    — Parse imports/exports/symbols via regex, build import graph
 *   8. Persistence     — Save index to appData/codebase-index/ as JSON files
 *
 * Change detection: content hashing (SHA-256) to only re-index modified files.
 * Debouncing: reindexFile() debounces rapid consecutive calls.
 *
 * Decisions referenced: D-007, Phase 8-A (local-only embeddings).
 * Security: all indexing stays on the user's machine (no remote calls).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createEmbeddingService, type IEmbeddingService } from './embeddingService';
import { VectorStore } from './vectorStore';
import type { IMemoryConfig } from './types';
import { getAppState, isAppStateInitialized } from '../platform/appState';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ICodebaseIndexer {
        indexWorkspace(rootPath: string, options?: IIndexOptions): AsyncIterable<IIndexProgress>;
        search(query: string, options?: ISearchOptions): Promise<ISearchResult[]>;
        getFileContext(filePath: string, options?: IContextOptions): Promise<IFileContext>;
        getIndexStatus(): IIndexStatus;
        reindexFile(filePath: string): Promise<void>;
        removeFile(filePath: string): Promise<void>;
        dispose(): void;
}

export interface IIndexOptions {
        maxFileSize?: number;        // Skip files larger than this (default: 100KB)
        maxFiles?: number;           // Max files to index (default: 10000)
        filePatterns?: string[];     // Glob patterns to include (default: common code files)
        excludePatterns?: string[];  // Glob patterns to exclude (default: node_modules, .git, dist, build, vendor)
        chunkSize?: number;          // Lines per chunk (default: 50)
        chunkOverlap?: number;       // Overlap lines between chunks (default: 10)
        useEmbeddings?: boolean;     // Use embedding search vs keyword-only (default: true)
}

export interface IIndexProgress {
        phase: 'scanning' | 'reading' | 'chunking' | 'embedding' | 'complete';
        filesProcessed: number;
        totalFiles: number;
        currentFile?: string;
        chunksCreated: number;
        errors: number;
}

export interface ISearchOptions {
        maxResults?: number;         // Default: 10
        minScore?: number;           // Default: 0.5
        fileTypes?: string[];        // Filter by file extension
        directory?: string;          // Limit search to a subdirectory
        includeContent?: boolean;    // Include chunk content in results (default: true)
}

export interface ISearchResult {
        filePath: string;
        score: number;
        chunk: ICodeChunk;
        surroundingChunks?: ICodeChunk[];  // Adjacent chunks for context
}

export interface ICodeChunk {
        id: string;
        filePath: string;
        startLine: number;
        endLine: number;
        content: string;
        language: string;
        hash: string;             // Content hash for change detection
}

export interface IFileContext {
        filePath: string;
        summary: string;
        imports: string[];
        exports: string[];
        symbols: ICodeSymbol[];
        relatedFiles: string[];
}

export interface ICodeSymbol {
        name: string;
        kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'constant' | 'enum' | 'namespace';
        startLine: number;
        endLine: number;
        export: boolean;
}

export interface IIndexStatus {
        indexed: boolean;
        lastIndexed: number | null;
        fileCount: number;
        chunkCount: number;
        totalSize: number;
        isIndexing: boolean;
        progress?: IIndexProgress;
}

export interface IContextOptions {
        /** Include up to N levels of import dependencies. Default: 1 */
        depth?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILE_SIZE = 100_000;   // 100KB
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_CHUNK_SIZE = 50;
const DEFAULT_CHUNK_OVERLAP = 10;
const DEFAULT_USE_EMBEDDINGS = true;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SCORE = 0.5;
const CONCURRENCY_LIMIT = 10;
const DEBOUNCE_MS = 500;

const DEFAULT_FILE_PATTERNS: string[] = [
        '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
        '**/*.py', '**/*.rs', '**/*.go', '**/*.java',
        '**/*.c', '**/*.cpp', '**/*.h', '**/*.hpp',
        '**/*.css', '**/*.scss', '**/*.less',
        '**/*.html', '**/*.xml', '**/*.json', '**/*.yaml', '**/*.yml',
        '**/*.md', '**/*.txt', '**/*.sh', '**/*.bash',
        '**/*.swift', '**/*.kt', '**/*.rb', '**/*.php',
        '**/*.sql', '**/*.graphql', '**/*.vue', '**/*.svelte',
];

const DEFAULT_EXCLUDE_PATTERNS: string[] = [
        '**/node_modules/**', '**/.git/**', '**/dist/**',
        '**/build/**', '**/vendor/**', '**/.next/**',
        '**/coverage/**', '**/__pycache__/**', '**/.cache/**',
        '**/*.min.js', '**/*.min.css', '**/*.bundle.js',
        '**/target/**', '**/.gradle/**', '**/.idea/**',
        '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml',
];

// ---------------------------------------------------------------------------
// Language detection from file extension
// ---------------------------------------------------------------------------

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript',
        '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
        '.py': 'python', '.pyw': 'python',
        '.rs': 'rust', '.go': 'go', '.java': 'java',
        '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
        '.css': 'css', '.scss': 'scss', '.less': 'less',
        '.html': 'html', '.xml': 'xml', '.json': 'json',
        '.yaml': 'yaml', '.yml': 'yaml',
        '.md': 'markdown', '.txt': 'text',
        '.sh': 'shell', '.bash': 'shell',
        '.swift': 'swift', '.kt': 'kotlin', '.kts': 'kotlin',
        '.rb': 'ruby', '.php': 'php',
        '.sql': 'sql', '.graphql': 'graphql',
        '.vue': 'vue', '.svelte': 'svelte',
        '.cs': 'csharp', '.fs': 'fsharp',
        '.dart': 'dart', '.lua': 'lua',
        '.zig': 'zig', '.nim': 'nim',
        '.toml': 'toml', '.ini': 'ini',
        '.env': 'dotenv',
};

function languageFromPath(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        return EXTENSION_LANGUAGE_MAP[ext] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

function contentHash(content: string): string {
        return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Glob matching helpers (simplified — no external dep)
// ---------------------------------------------------------------------------

/**
 * Match a file path against a list of glob patterns.
 * Supports: `**` (any depth), `*` (single segment), extensions like `*.ts`.
 */
function matchGlob(filePath: string, patterns: string[]): boolean {
        const normalized = filePath.replace(/\\/g, '/');
        for (const pattern of patterns) {
                const regex = globToRegex(pattern);
                if (regex.test(normalized)) return true;
        }
        return false;
}

function globToRegex(pattern: string): RegExp {
        let re = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex specials (except * and ?)
                .replace(/\*\*/g, '{{GLOBSTAR}}')
                .replace(/\*/g, '[^/]*')
                .replace(/\?/g, '[^/]')
                .replace(/\{\{GLOBSTAR\}\}/g, '.*');
        return new RegExp(`^${re}$`, 'i');
}

// ---------------------------------------------------------------------------
// Import / Export / Symbol parsing per language (regex-based)
// ---------------------------------------------------------------------------

interface IParsedFile {
        imports: string[];
        exports: string[];
        symbols: ICodeSymbol[];
}

// TypeScript / JavaScript patterns
const TS_IMPORT_RE = /import\s+(?:type\s+)?(?:[\w{}\s,*\s]+from\s+)?['"]([^'"]+)['"]/g;
const TS_EXPORT_RE = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum|namespace)\s+([\w]+)/g;
const TS_FUNCTION_RE = /(?:export\s+)?(?:async\s+)?function\s+([\w]+)/g;
const TS_CLASS_RE = /(?:export\s+)?class\s+([\w]+)/g;
const TS_INTERFACE_RE = /(?:export\s+)?interface\s+([\w]+)/g;
const TS_TYPE_RE = /(?:export\s+)?type\s+([\w]+)\s*[=<{]/g;
const TS_ENUM_RE = /(?:export\s+)?enum\s+([\w]+)/g;
const TS_CONST_RE = /(?:export\s+)?const\s+([\w]+)\s*[=:]/g;
const TS_NAMESPACE_RE = /(?:export\s+)?namespace\s+([\w]+)/g;

// Python patterns
const PY_IMPORT_RE = /(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
const PY_CLASS_RE = /class\s+([\w]+)/g;
const PY_FUNCTION_RE = /def\s+([\w]+)/g;

// Go patterns
const GO_IMPORT_RE = /import\s+(?:\([\s\S]*?\)|"([^"]+)")/g;
const GO_FUNC_RE = /func\s+(?:\([\w\s\*]+\)\s*)?([\w]+)\s*\(/g;
const GO_TYPE_RE = /type\s+([\w]+)\s+(?:struct|interface)/g;

function parseFileContent(content: string, language: string): IParsedFile {
        const imports: string[] = [];
        const exports: string[] = [];
        const symbols: ICodeSymbol[] = [];
        const lines = content.split('\n');

        switch (language) {
                case 'typescript':
                case 'javascript': {
                        // Imports
                        collectMatches(content, TS_IMPORT_RE, 1, imports);
                        // Exports
                        collectMatches(content, TS_EXPORT_RE, 1, exports);
                        // Symbols
                        collectSymbols(content, lines, TS_FUNCTION_RE, 'function', symbols);
                        collectSymbols(content, lines, TS_CLASS_RE, 'class', symbols);
                        collectSymbols(content, lines, TS_INTERFACE_RE, 'interface', symbols);
                        collectSymbols(content, lines, TS_TYPE_RE, 'type', symbols);
                        collectSymbols(content, lines, TS_ENUM_RE, 'enum', symbols);
                        collectSymbols(content, lines, TS_CONST_RE, 'constant', symbols);
                        collectSymbols(content, lines, TS_NAMESPACE_RE, 'namespace', symbols);
                        break;
                }
                case 'python': {
                        collectMatchesDual(content, PY_IMPORT_RE, 1, 2, imports);
                        collectSymbols(content, lines, PY_CLASS_RE, 'class', symbols);
                        collectSymbols(content, lines, PY_FUNCTION_RE, 'function', symbols);
                        // Python exports are convention-based (__all__), not syntax
                        const allMatch = content.match(/__all__\s*=\s*\[([^\]]+)\]/);
                        if (allMatch) {
                                const items = allMatch[1].match(/['"]([\w]+)['"]/g);
                                if (items) {
                                        for (const item of items) {
                                                exports.push(item.replace(/['"]/g, ''));
                                        }
                                }
                        }
                        break;
                }
                case 'go': {
                        collectMatches(content, GO_IMPORT_RE, 1, imports);
                        collectSymbols(content, lines, GO_FUNC_RE, 'function', symbols);
                        collectSymbols(content, lines, GO_TYPE_RE, 'type', symbols);
                        // Go exports: symbols starting with uppercase are exported
                        for (const sym of symbols) {
                                if (sym.name[0] === sym.name[0].toUpperCase() && sym.name[0] !== sym.name[0].toLowerCase()) {
                                        exports.push(sym.name);
                                }
                        }
                        break;
                }
                default: {
                        // Generic: try TS/JS patterns as best effort
                        collectMatches(content, TS_IMPORT_RE, 1, imports);
                        collectMatches(content, TS_EXPORT_RE, 1, exports);
                        break;
                }
        }

        return { imports: dedupe(imports), exports: dedupe(exports), symbols };
}

function collectMatches(text: string, re: RegExp, group: number, out: string[]): void {
        let m: RegExpExecArray | null;
        const localRe = new RegExp(re.source, re.flags);
        while ((m = localRe.exec(text)) !== null) {
                if (m[group]) out.push(m[group]);
        }
}

function collectMatchesDual(text: string, re: RegExp, group1: number, group2: number, out: string[]): void {
        let m: RegExpExecArray | null;
        const localRe = new RegExp(re.source, re.flags);
        while ((m = localRe.exec(text)) !== null) {
                if (m[group1]) out.push(m[group1]);
                else if (m[group2]) out.push(m[group2]);
        }
}

function collectSymbols(
        text: string,
        lines: string[],
        re: RegExp,
        kind: ICodeSymbol['kind'],
        out: ICodeSymbol[],
): void {
        let m: RegExpExecArray | null;
        const localRe = new RegExp(re.source, re.flags);
        while ((m = localRe.exec(text)) !== null) {
                const name = m[1];
                if (!name) continue;
                const startLine = lineNumberFromIndex(text, m.index);
                const isExport = lineStartsWithExport(lines, startLine);
                // Estimate end line: find next declaration or end of file
                const endLine = estimateEndLine(lines, startLine, kind);
                out.push({ name, kind, startLine: startLine + 1, endLine: endLine + 1, export: isExport });
        }
}

function lineNumberFromIndex(text: string, index: number): number {
        let count = 0;
        for (let i = 0; i < index && i < text.length; i++) {
                if (text[i] === '\n') count++;
        }
        return count;
}

function lineStartsWithExport(lines: string[], lineNum: number): boolean {
        if (lineNum >= lines.length) return false;
        return /^\s*export\s/.test(lines[lineNum]);
}

function estimateEndLine(lines: string[], startLine: number, _kind: ICodeSymbol['kind']): number {
        // Simple heuristic: find the next line at same or lower indentation that's not blank
        const startIndent = lines[startLine]?.search(/\S/) ?? 0;
        for (let i = startLine + 1; i < lines.length; i++) {
                const line = lines[i];
                if (line.trim() === '') continue;
                const indent = line.search(/\S/);
                if (indent <= startIndent && indent >= 0) {
                        // Check if this line starts a new declaration
                        if (/^(export\s+)?(function|class|interface|type|enum|const|let|var|namespace|def|func)\b/.test(line.trim())) {
                                return Math.max(startLine, i - 1);
                        }
                }
        }
        return lines.length - 1;
}

function dedupe(arr: string[]): string[] {
        return [...new Set(arr)];
}

// ---------------------------------------------------------------------------
// Inverted index (word → Set<chunkId>) for BM25 keyword search
// ---------------------------------------------------------------------------

class InvertedIndex {
        /** word → Set of chunk IDs containing that word */
        private readonly index = new Map<string, Set<string>>();
        /** chunkId → document frequency (number of unique words) */
        private readonly docLengths = new Map<string, number>();
        /** Total number of indexed documents (chunks) */
        private docCount = 0;

        /** Average document length (in unique words) */
        private avgDocLength = 0;

        add(chunkId: string, content: string): void {
                const words = tokenize(content);
                const uniqueWords = new Set(words);
                this.docLengths.set(chunkId, uniqueWords.size);

                for (const word of uniqueWords) {
                        let set = this.index.get(word);
                        if (!set) {
                                set = new Set();
                                this.index.set(word, set);
                        }
                        set.add(chunkId);
                }

                this.docCount++;
                // Update average doc length incrementally
                const totalLength = this.avgDocLength * (this.docCount - 1) + uniqueWords.size;
                this.avgDocLength = totalLength / this.docCount;
        }

        remove(chunkId: string): void {
                const docLen = this.docLengths.get(chunkId);
                if (docLen === undefined) return;

                for (const [, set] of this.index) {
                        set.delete(chunkId);
                }

                this.docLengths.delete(chunkId);
                this.docCount = Math.max(0, this.docCount - 1);

                // Recalculate average (approximate)
                if (this.docCount > 0) {
                        let totalLen = 0;
                        for (const [, len] of this.docLengths) totalLen += len;
                        this.avgDocLength = totalLen / this.docCount;
                } else {
                        this.avgDocLength = 0;
                }
        }

        /**
         * BM25 scoring for a query against all indexed chunks.
         * Returns a map of chunkId → score.
         */
        bm25(query: string, k1 = 1.2, b = 0.75): Map<string, number> {
                const queryWords = tokenize(query);
                const scores = new Map<string, number>();

                for (const word of queryWords) {
                        const posting = this.index.get(word);
                        if (!posting) continue;

                        const df = posting.size;
                        // IDF component
                        const idf = Math.log(1 + (this.docCount - df + 0.5) / (df + 0.5));

                        for (const chunkId of posting) {
                                const docLen = this.docLengths.get(chunkId) ?? 1;
                                // TF: count occurrences of word in the chunk
                                // We approximate TF=1 since we only store unique words per doc
                                // A more accurate approach would require re-reading chunk content
                                const tf = 1;
                                const numerator = tf * (k1 + 1);
                                const denominator = tf + k1 * (1 - b + b * (docLen / (this.avgDocLength || 1)));
                                const score = idf * (numerator / denominator);

                                scores.set(chunkId, (scores.get(chunkId) ?? 0) + score);
                        }
                }

                return scores;
        }

        /** Get all chunk IDs that contain any of the query words */
        searchKeyword(query: string): Set<string> {
                const queryWords = tokenize(query);
                const result = new Set<string>();
                for (const word of queryWords) {
                        const posting = this.index.get(word);
                        if (posting) {
                                for (const id of posting) result.add(id);
                        }
                }
                return result;
        }

        clear(): void {
                this.index.clear();
                this.docLengths.clear();
                this.docCount = 0;
                this.avgDocLength = 0;
        }

        get size(): number {
                return this.docCount;
        }

        /** Serialize for persistence */
        toJSON(): object {
                const indexObj: Record<string, string[]> = {};
                for (const [word, set] of this.index) {
                        indexObj[word] = [...set];
                }
                const docLengthsObj: Record<string, number> = {};
                for (const [id, len] of this.docLengths) {
                        docLengthsObj[id] = len;
                }
                return {
                        index: indexObj,
                        docLengths: docLengthsObj,
                        docCount: this.docCount,
                        avgDocLength: this.avgDocLength,
                };
        }

        /** Deserialize from persistence */
        static fromJSON(data: {
                index: Record<string, string[]>;
                docLengths: Record<string, number>;
                docCount: number;
                avgDocLength: number;
        }): InvertedIndex {
                const ii = new InvertedIndex();
                for (const [word, ids] of Object.entries(data.index)) {
                        ii.index.set(word, new Set(ids));
                }
                for (const [id, len] of Object.entries(data.docLengths)) {
                        ii.docLengths.set(id, len);
                }
                ii.docCount = data.docCount;
                ii.avgDocLength = data.avgDocLength;
                return ii;
        }
}

function tokenize(text: string): string[] {
        return text
                .toLowerCase()
                .replace(/[^\w\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 1);  // Skip single-char tokens
}

// ---------------------------------------------------------------------------
// Index persistence types
// ---------------------------------------------------------------------------

interface IPersistedIndex {
        version: 1;
        lastIndexed: number;
        fileHashes: Record<string, string>;     // filePath → content hash
        chunks: Record<string, ICodeChunk>;     // chunkId → chunk
        importGraph: Record<string, string[]>;  // filePath → imported module paths
        fileSymbols: Record<string, IParsedFile>; // filePath → parsed symbols/imports/exports
        totalSize: number;
}

// ---------------------------------------------------------------------------
// CodebaseIndexer implementation
// ---------------------------------------------------------------------------

class CodebaseIndexerImpl implements ICodebaseIndexer {
        // Index storage
        private readonly chunks = new Map<string, ICodeChunk>();
        private readonly fileHashes = new Map<string, string>();
        private readonly importGraph = new Map<string, string[]>();
        private readonly fileSymbols = new Map<string, IParsedFile>();
        private readonly keywordIndex = new InvertedIndex();

        // Vector store for embedding search
        private vectorStore: VectorStore | null = null;
        private embedder: IEmbeddingService;

        // Index status
        private _isIndexing = false;
        private _progress: IIndexProgress | undefined;
        private _lastIndexed: number | null = null;
        private _totalSize = 0;

        // Reindex debounce
        private readonly pendingReindexes = new Map<string, NodeJS.Timeout>();

        // Persistence directory
        private readonly persistDir: string;

        // Config
        private readonly config: IMemoryConfig;

        constructor(baseDir: string) {
                this.persistDir = path.join(baseDir, 'codebase-index');
                this.config = this.readConfig();
                this.embedder = createEmbeddingService(this.config);
        }

        // -----------------------------------------------------------------------
        // indexWorkspace
        // -----------------------------------------------------------------------

        async *indexWorkspace(rootPath: string, options?: IIndexOptions): AsyncIterable<IIndexProgress> {
                if (this._isIndexing) {
                        logger.warn('[CodebaseIndexer] Indexing already in progress, skipping.');
                        return;
                }

                this._isIndexing = true;
                const opts = this.mergeDefaults(options);

                try {
                        // Phase 1: Scanning
                        let progress: IIndexProgress = {
                                phase: 'scanning',
                                filesProcessed: 0,
                                totalFiles: 0,
                                chunksCreated: 0,
                                errors: 0,
                        };
                        this._progress = progress;

                        const allFiles = this.scanFiles(rootPath, opts);
                        progress = { ...progress, totalFiles: allFiles.length };
                        this._progress = progress;
                        yield progress;

                        if (allFiles.length === 0) {
                                this._progress = { ...progress, phase: 'complete' };
                                yield this._progress;
                                return;
                        }

                        // Phase 2: Reading
                        progress = { ...progress, phase: 'reading' };
                        this._progress = progress;
                        yield progress;

                        const fileContents = await this.readFilesParallel(allFiles, opts, (fp, total) => {
                                progress = { ...progress, filesProcessed: fp, totalFiles: total };
                                this._progress = progress;
                        });

                        // Phase 3: Chunking
                        progress = { ...progress, phase: 'chunking', filesProcessed: allFiles.length };
                        this._progress = progress;
                        yield progress;

                        const newChunks: ICodeChunk[] = [];
                        const chunkContents = new Map<string, string>(); // chunkId → content for embedding

                        for (const [filePath, content] of fileContents) {
                                try {
                                        const hash = contentHash(content);
                                        const existingHash = this.fileHashes.get(filePath);

                                        // Skip unchanged files
                                        if (existingHash === hash) continue;

                                        // Remove old chunks for this file
                                        this.removeFileChunks(filePath);

                                        // Update hash
                                        this.fileHashes.set(filePath, hash);

                                        // Parse symbols
                                        const language = languageFromPath(filePath);
                                        const parsed = parseFileContent(content, language);
                                        this.fileSymbols.set(filePath, parsed);
                                        this.importGraph.set(filePath, parsed.imports);

                                        // Chunk the file
                                        const fileChunks = this.chunkFile(filePath, content, language, opts.chunkSize!, opts.chunkOverlap!);
                                        for (const chunk of fileChunks) {
                                                this.chunks.set(chunk.id, chunk);
                                                newChunks.push(chunk);
                                                chunkContents.set(chunk.id, chunk.content);
                                                this.keywordIndex.add(chunk.id, chunk.content);
                                        }
                                } catch (err) {
                                        logger.warn(`[CodebaseIndexer] Error chunking ${filePath}: ${err}`);
                                        progress = { ...progress, errors: progress.errors + 1 };
                                        this._progress = progress;
                                }
                        }

                        progress = { ...progress, chunksCreated: newChunks.length };
                        this._progress = progress;
                        yield progress;

                        // Phase 4: Embedding
                        if (opts.useEmbeddings && this.embedder.isEnabled() && newChunks.length > 0) {
                                progress = { ...progress, phase: 'embedding' };
                                this._progress = progress;
                                yield progress;

                                await this.embedChunks(newChunks, chunkContents);

                                progress = { ...progress };
                                this._progress = progress;
                                yield progress;
                        }

                        // Update stats
                        this._lastIndexed = Date.now();
                        this._totalSize = 0;
                        for (const [, content] of fileContents) {
                                this._totalSize += Buffer.byteLength(content, 'utf8');
                        }

                        // Persist
                        await this.saveIndex();

                        // Complete
                        this._progress = { ...progress, phase: 'complete' };
                        yield this._progress;
                } finally {
                        this._isIndexing = false;
                }
        }

        // -----------------------------------------------------------------------
        // search
        // -----------------------------------------------------------------------

        async search(query: string, options?: ISearchOptions): Promise<ISearchResult[]> {
                if (!query.trim()) return [];

                const opts = {
                        maxResults: options?.maxResults ?? DEFAULT_MAX_RESULTS,
                        minScore: options?.minScore ?? DEFAULT_MIN_SCORE,
                        fileTypes: options?.fileTypes,
                        directory: options?.directory,
                        includeContent: options?.includeContent ?? true,
                };

                // Collect candidate scores from both sources
                const candidateScores = new Map<string, number>();

                // 1. Keyword BM25 search
                const bm25Scores = this.keywordIndex.bm25(query);
                // Normalize BM25 scores to [0, 1] range
                let maxBm25 = 0;
                for (const [, score] of bm25Scores) {
                        if (score > maxBm25) maxBm25 = score;
                }
                for (const [chunkId, score] of bm25Scores) {
                        const normalized = maxBm25 > 0 ? score / maxBm25 : 0;
                        candidateScores.set(chunkId, normalized * 0.4); // 40% weight for keywords
                }

                // 2. Embedding similarity search (if available)
                if (this.embedder.isEnabled() && this.vectorStore) {
                        const embedding = await this.embedder.embed(query);
                        if (embedding) {
                                const matches = this.vectorStore.search(embedding, opts.maxResults * 3);
                                for (const match of matches) {
                                        // match.id is the vector store label, match.text contains the chunkId
                                        // We store the chunkId as the text field in the vector store
                                        const chunkId = match.text;
                                        const embScore = match.score * 0.6; // 60% weight for embeddings
                                        candidateScores.set(chunkId, (candidateScores.get(chunkId) ?? 0) + embScore);
                                }
                        }
                }

                // 3. If no embedding results, use pure keyword scores (re-weight to 100%)
                if (!this.embedder.isEnabled() || !this.vectorStore) {
                        candidateScores.clear();
                        for (const [chunkId, score] of bm25Scores) {
                                const normalized = maxBm25 > 0 ? score / maxBm25 : 0;
                                candidateScores.set(chunkId, normalized);
                        }
                }

                // 4. Sort and filter
                const sorted = [...candidateScores.entries()]
                        .filter(([, score]) => score >= opts.minScore)
                        .sort((a, b) => b[1] - a[1]);

                // 5. Build results
                const results: ISearchResult[] = [];
                for (const [chunkId, score] of sorted) {
                        const chunk = this.chunks.get(chunkId);
                        if (!chunk) continue;

                        // Apply file type filter
                        if (opts.fileTypes && opts.fileTypes.length > 0) {
                                const ext = path.extname(chunk.filePath).toLowerCase();
                                if (!opts.fileTypes.includes(ext)) continue;
                        }

                        // Apply directory filter
                        if (opts.directory) {
                                const normalizedDir = opts.directory.replace(/\\/g, '/');
                                const normalizedPath = chunk.filePath.replace(/\\/g, '/');
                                if (!normalizedPath.startsWith(normalizedDir)) continue;
                        }

                        // Get surrounding chunks for context
                        const surrounding = this.getSurroundingChunks(chunk);

                        results.push({
                                filePath: chunk.filePath,
                                score,
                                chunk: opts.includeContent ? chunk : { ...chunk, content: '' },
                                surroundingChunks: opts.includeContent ? surrounding : surrounding.map(c => ({ ...c, content: '' })),
                        });

                        if (results.length >= opts.maxResults) break;
                }

                return results;
        }

        // -----------------------------------------------------------------------
        // getFileContext
        // -----------------------------------------------------------------------

        async getFileContext(filePath: string, options?: IContextOptions): Promise<IFileContext> {
                const depth = options?.depth ?? 1;
                const parsed = this.fileSymbols.get(filePath);
                const normalized = filePath.replace(/\\/g, '/');

                // Build summary
                const language = languageFromPath(filePath);
                const symCount = parsed?.symbols.length ?? 0;
                const importCount = parsed?.imports.length ?? 0;
                const exportCount = parsed?.exports.length ?? 0;

                const summaryParts: string[] = [
                        `${path.basename(filePath)} (${language})`,
                ];
                if (importCount > 0) summaryParts.push(`${importCount} import${importCount > 1 ? 's' : ''}`);
                if (exportCount > 0) summaryParts.push(`${exportCount} export${exportCount > 1 ? 's' : ''}`);
                if (symCount > 0) summaryParts.push(`${symCount} symbol${symCount > 1 ? 's' : ''}`);
                const summary = summaryParts.join(', ');

                // Find related files via import graph (BFS up to depth)
                const relatedFiles = this.findRelatedFiles(normalized, depth);

                return {
                        filePath: normalized,
                        summary,
                        imports: parsed?.imports ?? [],
                        exports: parsed?.exports ?? [],
                        symbols: parsed?.symbols ?? [],
                        relatedFiles,
                };
        }

        // -----------------------------------------------------------------------
        // getIndexStatus
        // -----------------------------------------------------------------------

        getIndexStatus(): IIndexStatus {
                return {
                        indexed: this.chunks.size > 0,
                        lastIndexed: this._lastIndexed,
                        fileCount: this.fileHashes.size,
                        chunkCount: this.chunks.size,
                        totalSize: this._totalSize,
                        isIndexing: this._isIndexing,
                        progress: this._progress,
                };
        }

        // -----------------------------------------------------------------------
        // reindexFile
        // -----------------------------------------------------------------------

        async reindexFile(filePath: string): Promise<void> {
                // Debounce rapid consecutive calls for the same file
                const existing = this.pendingReindexes.get(filePath);
                if (existing) {
                        clearTimeout(existing);
                }

                return new Promise<void>((resolve) => {
                        this.pendingReindexes.set(filePath, setTimeout(async () => {
                                this.pendingReindexes.delete(filePath);
                                try {
                                        await this.doReindexFile(filePath);
                                } catch (err) {
                                        logger.warn(`[CodebaseIndexer] Error reindexing ${filePath}: ${err}`);
                                }
                                resolve();
                        }, DEBOUNCE_MS));
                });
        }

        // -----------------------------------------------------------------------
        // removeFile
        // -----------------------------------------------------------------------

        async removeFile(filePath: string): Promise<void> {
                this.removeFileChunks(filePath);
                this.fileHashes.delete(filePath);
                this.fileSymbols.delete(filePath);
                this.importGraph.delete(filePath);
                await this.saveIndex();
        }

        // -----------------------------------------------------------------------
        // dispose
        // -----------------------------------------------------------------------

        dispose(): void {
                // Clear pending reindexes
                for (const [, timeout] of this.pendingReindexes) {
                        clearTimeout(timeout);
                }
                this.pendingReindexes.clear();

                this.chunks.clear();
                this.fileHashes.clear();
                this.importGraph.clear();
                this.fileSymbols.clear();
                this.keywordIndex.clear();
                this.vectorStore = null;
                this._isIndexing = false;
                this._progress = undefined;
        }

        // =======================================================================
        // Private helpers
        // =======================================================================

        private mergeDefaults(opts?: IIndexOptions): Required<IIndexOptions> {
                return {
                        maxFileSize: opts?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
                        maxFiles: opts?.maxFiles ?? DEFAULT_MAX_FILES,
                        filePatterns: opts?.filePatterns ?? DEFAULT_FILE_PATTERNS,
                        excludePatterns: opts?.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
                        chunkSize: opts?.chunkSize ?? DEFAULT_CHUNK_SIZE,
                        chunkOverlap: opts?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
                        useEmbeddings: opts?.useEmbeddings ?? DEFAULT_USE_EMBEDDINGS,
                };
        }

        // -----------------------------------------------------------------------
        // Scanning
        // -----------------------------------------------------------------------

        private scanFiles(rootPath: string, opts: Required<IIndexOptions>): string[] {
                const results: string[] = [];
                const excludeSet = new Set(opts.excludePatterns);

                const walk = (dir: string): void => {
                        if (results.length >= opts.maxFiles) return;

                        let entries: fs.Dirent[];
                        try {
                                entries = fs.readdirSync(dir, { withFileTypes: true });
                        } catch {
                                return; // Permission denied or similar
                        }

                        for (const entry of entries) {
                                if (results.length >= opts.maxFiles) break;

                                const fullPath = path.join(dir, entry.name);
                                const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/');

                                if (entry.isDirectory()) {
                                        // Check if directory is excluded
                                        if (matchGlob(relativePath, [...excludeSet]) || matchGlob(entry.name, [...excludeSet])) {
                                                continue;
                                        }
                                        // Skip hidden directories
                                        if (entry.name.startsWith('.')) continue;
                                        walk(fullPath);
                                } else if (entry.isFile()) {
                                        // Check file patterns
                                        if (!matchGlob(relativePath, opts.filePatterns) && !matchGlob(entry.name, opts.filePatterns)) {
                                                continue;
                                        }
                                        // Check size
                                        try {
                                                const stat = fs.statSync(fullPath);
                                                if (stat.size > opts.maxFileSize) continue;
                                        } catch {
                                                continue;
                                        }
                                        results.push(fullPath);
                                }
                        }
                };

                walk(rootPath);
                return results;
        }

        // -----------------------------------------------------------------------
        // Reading (parallel with concurrency limit)
        // -----------------------------------------------------------------------

        private async readFilesParallel(
                filePaths: string[],
                _opts: Required<IIndexOptions>,
                onProgress: (filesProcessed: number, totalFiles: number) => void,
        ): Promise<Map<string, string>> {
                const results = new Map<string, string>();
                let processed = 0;
                const total = filePaths.length;

                // Process in batches of CONCURRENCY_LIMIT
                for (let i = 0; i < total; i += CONCURRENCY_LIMIT) {
                        const batch = filePaths.slice(i, i + CONCURRENCY_LIMIT);
                        const reads = batch.map(async (fp) => {
                                try {
                                        const content = await fs.promises.readFile(fp, 'utf8');
                                        return { fp, content };
                                } catch (err) {
                                        logger.verbose(`[CodebaseIndexer] Error reading ${fp}: ${err}`);
                                        return null;
                                }
                        });

                        const batchResults = await Promise.all(reads);
                        for (const result of batchResults) {
                                if (result) {
                                        results.set(result.fp, result.content);
                                }
                                processed++;
                        }
                        onProgress(processed, total);
                }

                return results;
        }

        // -----------------------------------------------------------------------
        // Chunking
        // -----------------------------------------------------------------------

        private chunkFile(
                filePath: string,
                content: string,
                language: string,
                chunkSize: number,
                chunkOverlap: number,
        ): ICodeChunk[] {
                const lines = content.split('\n');
                const chunks: ICodeChunk[] = [];
                const effectiveOverlap = Math.min(chunkOverlap, Math.floor(chunkSize / 2));

                let startLine = 0;
                while (startLine < lines.length) {
                        const endLine = Math.min(startLine + chunkSize, lines.length);
                        const chunkContent = lines.slice(startLine, endLine).join('\n');

                        if (chunkContent.trim().length === 0) {
                                startLine = endLine;
                                continue;
                        }

                        const id = this.chunkId(filePath, startLine, endLine);
                        const hash = contentHash(chunkContent);

                        chunks.push({
                                id,
                                filePath: filePath.replace(/\\/g, '/'),
                                startLine: startLine + 1,  // 1-based
                                endLine: endLine,          // 1-based inclusive
                                content: chunkContent,
                                language,
                                hash,
                        });

                        startLine = endLine - effectiveOverlap;
                        if (startLine <= chunks[chunks.length - 1].startLine - 1) {
                                // Prevent infinite loop: force advance
                                startLine = endLine;
                        }
                }

                return chunks;
        }

        private chunkId(filePath: string, startLine: number, endLine: number): string {
                const normalized = filePath.replace(/\\/g, '/');
                const hash = contentHash(`${normalized}:${startLine}:${endLine}`);
                return hash.substring(0, 16);
        }

        // -----------------------------------------------------------------------
        // Embedding
        // -----------------------------------------------------------------------

        private async embedChunks(
                chunks: ICodeChunk[],
                chunkContents: Map<string, string>,
        ): Promise<void> {
                // Ensure vector store is initialized
                const dim = this.embedder.getDimension() ?? 768; // Default dimension for nomic-embed-text
                if (!this.vectorStore || this.vectorStore.dim !== dim) {
                        this.vectorStore = new VectorStore(dim, { storageDir: this.persistDir });
                        this.vectorStore.load();
                }

                // Embed chunks in batches
                for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
                        const batch = chunks.slice(i, i + CONCURRENCY_LIMIT);
                        const embedPromises = batch.map(async (chunk) => {
                                const content = chunkContents.get(chunk.id) ?? chunk.content;
                                // Include file path + content for better context
                                const textToEmbed = `${chunk.filePath}\n${content}`;
                                const embedding = await this.embedder.embed(textToEmbed);
                                return { chunk, embedding };
                        });

                        const results = await Promise.all(embedPromises);
                        for (const { chunk, embedding } of results) {
                                if (embedding) {
                                        // Store chunk ID as the text field so we can look it up during search
                                        this.vectorStore.add(embedding, {
                                                text: chunk.id,
                                                timestamp: new Date().toISOString(),
                                                metadata: {
                                                        filePath: chunk.filePath,
                                                        startLine: chunk.startLine,
                                                        endLine: chunk.endLine,
                                                        language: chunk.language,
                                                },
                                        });
                                }
                        }
                }

                // Save vector store
                this.vectorStore.save();
        }

        // -----------------------------------------------------------------------
        // Reindex single file
        // -----------------------------------------------------------------------

        private async doReindexFile(filePath: string): Promise<void> {
                const normalized = filePath.replace(/\\/g, '/');

                try {
                        const content = await fs.promises.readFile(filePath, 'utf8');
                        const hash = contentHash(content);
                        const existingHash = this.fileHashes.get(normalized);

                        // Skip if unchanged
                        if (existingHash === hash) return;

                        // Remove old chunks
                        this.removeFileChunks(normalized);

                        // Update hash
                        this.fileHashes.set(normalized, hash);

                        // Parse and chunk
                        const language = languageFromPath(filePath);
                        const parsed = parseFileContent(content, language);
                        this.fileSymbols.set(normalized, parsed);
                        this.importGraph.set(normalized, parsed.imports);

                        const fileChunks = this.chunkFile(normalized, content, language, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP);

                        // Add chunks
                        const chunkContents = new Map<string, string>();
                        for (const chunk of fileChunks) {
                                this.chunks.set(chunk.id, chunk);
                                this.keywordIndex.add(chunk.id, chunk.content);
                                chunkContents.set(chunk.id, chunk.content);
                        }

                        // Embed
                        if (this.embedder.isEnabled()) {
                                await this.embedChunks(fileChunks, chunkContents);
                        }

                        await this.saveIndex();
                        logger.verbose(`[CodebaseIndexer] Reindexed: ${normalized}`);
                } catch (err) {
                        logger.warn(`[CodebaseIndexer] Failed to reindex ${normalized}: ${err}`);
                }
        }

        // -----------------------------------------------------------------------
        // Remove chunks for a file
        // -----------------------------------------------------------------------

        private removeFileChunks(filePath: string): void {
                const normalized = filePath.replace(/\\/g, '/');
                const toRemove: string[] = [];
                for (const [id, chunk] of this.chunks) {
                        if (chunk.filePath === normalized) {
                                toRemove.push(id);
                        }
                }
                for (const id of toRemove) {
                        this.chunks.delete(id);
                        this.keywordIndex.remove(id);
                }
        }

        // -----------------------------------------------------------------------
        // Get surrounding chunks
        // -----------------------------------------------------------------------

        private getSurroundingChunks(chunk: ICodeChunk): ICodeChunk[] {
                const surrounding: ICodeChunk[] = [];
                for (const [, other] of this.chunks) {
                        if (other.filePath !== chunk.filePath || other.id === chunk.id) continue;
                        // Adjacent if the start/end lines are within chunkSize
                        if (
                                other.startLine <= chunk.endLine + 1 &&
                                other.endLine >= chunk.startLine - 1
                        ) {
                                surrounding.push(other);
                        }
                }
                // Sort by start line
                surrounding.sort((a, b) => a.startLine - b.startLine);
                return surrounding.slice(0, 2); // At most 2 surrounding chunks
        }

        // -----------------------------------------------------------------------
        // Find related files (BFS via import graph)
        // -----------------------------------------------------------------------

        private findRelatedFiles(startPath: string, depth: number): string[] {
                const visited = new Set<string>([startPath]);
                const queue: Array<{ path: string; depth: number }> = [{ path: startPath, depth: 0 }];
                const related: string[] = [];

                while (queue.length > 0) {
                        const { path: current, depth: currentDepth } = queue.shift()!;

                        if (currentDepth >= depth) continue;

                        const imports = this.importGraph.get(current) ?? [];
                        // Also find files that import the current file (reverse edges)
                        const reverseImports = this.findReverseImports(current);

                        const neighbors = [...imports, ...reverseImports];
                        for (const neighbor of neighbors) {
                                if (visited.has(neighbor)) continue;
                                visited.add(neighbor);

                                // Only include files that we have indexed
                                if (this.fileHashes.has(neighbor)) {
                                        related.push(neighbor);
                                }

                                queue.push({ path: neighbor, depth: currentDepth + 1 });
                        }
                }

                return related;
        }

        /** Find files that import the given path */
        private findReverseImports(filePath: string): string[] {
                const result: string[] = [];
                const basename = path.basename(filePath, path.extname(filePath));

                for (const [otherPath, imports] of this.importGraph) {
                        for (const imp of imports) {
                                // Simple heuristic: check if the import path contains the file basename
                                if (imp.includes(basename) || imp.endsWith(filePath.replace(/\\/g, '/'))) {
                                        result.push(otherPath);
                                        break;
                                }
                        }
                }

                return result;
        }

        // -----------------------------------------------------------------------
        // Persistence
        // -----------------------------------------------------------------------

        private async saveIndex(): Promise<void> {
                try {
                        await fs.promises.mkdir(this.persistDir, { recursive: true });

                        const data: IPersistedIndex = {
                                version: 1,
                                lastIndexed: this._lastIndexed ?? Date.now(),
                                fileHashes: Object.fromEntries(this.fileHashes),
                                chunks: Object.fromEntries(this.chunks),
                                importGraph: Object.fromEntries(this.importGraph),
                                fileSymbols: Object.fromEntries(this.fileSymbols),
                                totalSize: this._totalSize,
                        };

                        const indexPath = path.join(this.persistDir, 'index.json');
                        await fs.promises.writeFile(indexPath, JSON.stringify(data, null, 2), 'utf8');

                        // Save keyword index separately (can be large)
                        const keywordPath = path.join(this.persistDir, 'keyword-index.json');
                        await fs.promises.writeFile(keywordPath, JSON.stringify(this.keywordIndex.toJSON(), null, 2), 'utf8');

                        logger.verbose(`[CodebaseIndexer] Index saved to ${this.persistDir}`);
                } catch (err) {
                        logger.warn(`[CodebaseIndexer] Failed to save index: ${err}`);
                }
        }

        async loadIndex(): Promise<void> {
                try {
                        const indexPath = path.join(this.persistDir, 'index.json');
                        const raw = await fs.promises.readFile(indexPath, 'utf8');
                        const data = JSON.parse(raw) as IPersistedIndex;

                        if (data.version !== 1) {
                                logger.warn('[CodebaseIndexer] Index version mismatch, skipping load.');
                                return;
                        }

                        this._lastIndexed = data.lastIndexed;
                        this._totalSize = data.totalSize;

                        // Restore file hashes
                        this.fileHashes.clear();
                        for (const [fp, hash] of Object.entries(data.fileHashes)) {
                                this.fileHashes.set(fp, hash);
                        }

                        // Restore chunks
                        this.chunks.clear();
                        for (const [id, chunk] of Object.entries(data.chunks)) {
                                this.chunks.set(id, chunk);
                        }

                        // Restore import graph
                        this.importGraph.clear();
                        for (const [fp, imports] of Object.entries(data.importGraph)) {
                                this.importGraph.set(fp, imports);
                        }

                        // Restore file symbols
                        this.fileSymbols.clear();
                        for (const [fp, parsed] of Object.entries(data.fileSymbols)) {
                                this.fileSymbols.set(fp, parsed);
                        }

                        // Restore keyword index
                        const keywordPath = path.join(this.persistDir, 'keyword-index.json');
                        try {
                                const kwRaw = await fs.promises.readFile(keywordPath, 'utf8');
                                const kwData = JSON.parse(kwRaw);
                                InvertedIndex.fromJSON(kwData); // Validate the data format
                                // Replace the internal state
                                this.keywordIndex.clear();
                                // Re-add all chunks to the keyword index from the loaded chunks
                                for (const [, chunk] of this.chunks) {
                                        this.keywordIndex.add(chunk.id, chunk.content);
                                }
                        } catch {
                                // Keyword index not found or corrupted — rebuild from chunks
                                this.keywordIndex.clear();
                                for (const [, chunk] of this.chunks) {
                                        this.keywordIndex.add(chunk.id, chunk.content);
                                }
                        }

                        logger.info(`[CodebaseIndexer] Index loaded: ${this.chunks.size} chunks, ${this.fileHashes.size} files`);
                } catch (err) {
                        // No saved index or corrupted — start fresh
                        logger.verbose(`[CodebaseIndexer] No saved index found, starting fresh: ${err}`);
                }
        }

        // -----------------------------------------------------------------------
        // Config
        // -----------------------------------------------------------------------

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
                        ollamaBaseUrl: undefined,
                };
        }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: ICodebaseIndexer | undefined;

/**
 * Get the singleton codebase indexer instance.
 * Must call initCodebaseIndexer() first.
 */
export function getCodebaseIndexer(): ICodebaseIndexer {
        if (!_instance) {
                throw new Error('CodebaseIndexer not initialized. Call initCodebaseIndexer() first.');
        }
        return _instance;
}

/**
 * Initialize the codebase indexer with the given base directory.
 * The base directory is used for persisting the index data.
 * Typically: appData/codebase-index/
 */
export async function initCodebaseIndexer(baseDir: string): Promise<ICodebaseIndexer> {
        if (_instance) {
                return _instance;
        }

        const persistDir = path.join(baseDir, 'codebase-index');
        const indexer = new CodebaseIndexerImpl(baseDir);

        // Try to load existing index
        await indexer.loadIndex();

        _instance = indexer;
        logger.info(`[CodebaseIndexer] Initialized (persistDir: ${persistDir})`);

        return _instance;
}

/**
 * Reset the codebase indexer (for testing only).
 */
export function resetCodebaseIndexer(): void {
        _instance?.dispose();
        _instance = undefined;
}
