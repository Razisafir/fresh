/**
 * cogneeIntegration.ts — Cognee knowledge-graph memory integration service.
 *
 * Manages the Cognee Python process lifecycle, wraps Cognee's MCP server as
 * a managed subprocess, and provides a TypeScript API mirroring Cognee's key
 * operations: remember, recall, search, forget, improve, cognify.
 *
 * Design decisions:
 *   - Cognee runs as an MCP server subprocess (python -m cognee.mcp or
 *     cognee-mcp), communicating over JSON-RPC 2.0 / stdio.
 *   - Falls back to the existing MemoryService when Cognee is unavailable
 *     (graceful degradation — the agent loop never blocks on Cognee).
 *   - Auto-configures: uses Ollama for embeddings (matching existing setup),
 *     Kuzu for local graph DB (no external deps required).
 *   - Health monitoring: periodic health checks track the Cognee process state.
 *   - Singleton pattern: getCogneeService() / initCogneeService().
 *
 * Security:
 *   - SEC-3: uses spawn() (no shell). No child_process.exec.
 *   - SEC-9: child env is sanitised via buildChildEnv().
 *   - Tool outputs are NOT sanitised here — the caller (tool registry / agent
 *     loop) is responsible for sanitising before returning to the LLM.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { buildChildEnv } from '../security/childEnv';
import { validateMcpMethod } from '../security/workspaceGuard';
import { getAppState, isAppStateInitialized } from '../platform/appState';
import { getMemoryService, type IMemoryService } from './memoryService';
import { logger } from '../util/logger';
import type {
        ICogneeConfig,
        ICogneeRecallResult,
        ICogneeSearchResult,
        ICogneeGraphViz,
        CogneeServiceState,
} from './cogneeTypes';
import { CogneeSearchType } from './cogneeTypes';
import type { IJsonRpcMessage } from '../mcp/types';

// ---------------------------------------------------------------------------
// Module augmentation: extend IAppConfig with Cognee fields
// ---------------------------------------------------------------------------

declare module '../types/platform' {
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        interface IAppConfig extends ICogneeConfig {}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COGNEE_MCP_MODULE = 'cognee.mcp';
/** Alternative CLI entry point if installed via pip (`cognee-mcp`). Not used
 *  in the default spawn path but documented for future fallback logic. */
// const COGNEE_MCP_CLI = 'cognee-mcp';
const INITIALIZE_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_COGNEE_CONFIG: Required<ICogneeConfig> = {
        cogneeEnabled: false,
        cogneePythonPath: 'python3',
        cogneeGraphDb: 'kuzu',
        cogneeEmbedProvider: 'ollama',
};

// ---------------------------------------------------------------------------
// CogneeService
// ---------------------------------------------------------------------------

/**
 * Cognee integration service — manages the Cognee MCP server subprocess and
 * provides a TypeScript API for Cognee operations.
 *
 * Lifecycle:
 *   1. initCogneeService() — read config, optionally spawn Cognee process
 *   2. isAvailable() — check if Cognee is ready for use
 *   3. remember/recall/search/forget/improve/cognify — call Cognee tools
 *   4. shutdown() — kill the subprocess, clean up
 *
 * When Cognee is unavailable (not configured, process failed, etc.), all
 * operations fall back to the existing MemoryService. The caller never
 * needs to handle Cognee-specific errors — the service degrades gracefully.
 */
class CogneeService {
        private _state: CogneeServiceState = 'disabled';
        private _config: Required<ICogneeConfig>;
        private _fallback: IMemoryService;
        private proc: ChildProcessWithoutNullStreams | null = null;
        private nextId = 1;
        private readonly pending = new Map<number, {
                resolve: (msg: IJsonRpcMessage) => void;
                reject: (err: Error) => void;
                timer: ReturnType<typeof setTimeout>;
        }>();
        private buffer = '';
        private _consecutiveFailures = 0;
        private _lastFailureReason = '';

        /**
         * Get a human-readable status summary of the Cognee service.
         * Useful for debugging and UI display.
         */
        getStatus(): { state: CogneeServiceState; consecutiveFailures: number; lastFailureReason: string } {
                return {
                        state: this._state,
                        consecutiveFailures: this._consecutiveFailures,
                        lastFailureReason: this._lastFailureReason,
                };
        }
        private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
        private _initialized = false;

        constructor() {
                this._config = { ...DEFAULT_COGNEE_CONFIG };
                this._fallback = getMemoryService();
        }

        /**
         * Initialise the Cognee service. Reads configuration from IAppConfig
         * and, if enabled, spawns the Cognee MCP server subprocess.
         */
        async init(): Promise<void> {
                this._config = this.readConfig();
                this._fallback = getMemoryService();

                if (!this._config.cogneeEnabled) {
                        this._state = 'disabled';
                        logger.info('[Cognee] Integration is disabled in configuration.');
                        return;
                }

                this._state = 'starting';
                logger.info(`[Cognee] Starting Cognee MCP server (python: ${this._config.cogneePythonPath}, graphDb: ${this._config.cogneeGraphDb}, embedProvider: ${this._config.cogneeEmbedProvider})`);

                try {
                        await this.spawnAndConnect();
                        this._state = 'available';
                        this._initialized = true;
                        this.startHealthCheck();
                        logger.info('[Cognee] MCP server started successfully.');
                } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        logger.error(`[Cognee] Failed to start MCP server: ${msg}. Falling back to MemoryService.`);
                        this._state = 'unavailable';
                        this._initialized = true;
                }
        }

        /**
         * Whether the Cognee service is available for use.
         * Returns true only if the state is 'available' or 'degraded'.
         */
        isAvailable(): boolean {
                return this._state === 'available' || this._state === 'degraded';
        }

        /**
         * Current service state.
         */
        get state(): CogneeServiceState {
                return this._state;
        }

        /**
         * Whether the service has been initialised (regardless of availability).
         */
        get initialized(): boolean {
                return this._initialized;
        }

        // -----------------------------------------------------------------------
        // Cognee API methods
        // -----------------------------------------------------------------------

        /**
         * Ingest data into the Cognee knowledge graph.
         * Falls back to MemoryService.store() when Cognee is unavailable.
         *
         * @param data  The text data to ingest.
         * @param dataset  Target dataset name (default: 'default').
         */
        async remember(data: string, dataset = 'default'): Promise<void> {
                if (!data.trim()) return;

                if (!this.isAvailable()) {
                        logger.verbose('[Cognee] remember() falling back to MemoryService.store()');
                        await this._fallback.store(data, { source: 'cognee-fallback', dataset });
                        return;
                }

                try {
                        await this.callTool('remember', { data, dataset });
                        logger.verbose(`[Cognee] remember(): ingested ${data.length} chars into dataset "${dataset}"`);
                } catch (err) {
                        this.recordFailure(err);
                        logger.verbose('[Cognee] remember() failed, falling back to MemoryService.store()');
                        await this._fallback.store(data, { source: 'cognee-fallback', dataset });
                }
        }

        /**
         * Process/structure ingested data into the knowledge graph.
         * This is a potentially long-running operation.
         *
         * @param dataset  Dataset to cognify (default: 'default').
         */
        async cognify(dataset = 'default'): Promise<void> {
                if (!this.isAvailable()) {
                        logger.verbose('[Cognee] cognify() skipped — Cognee unavailable');
                        return;
                }

                try {
                        await this.callTool('cognify', { dataset }, TOOL_TIMEOUT_MS);
                        logger.verbose(`[Cognee] cognify(): processed dataset "${dataset}"`);
                } catch (err) {
                        this.recordFailure(err);
                        logger.warn(`[Cognee] cognify() failed for dataset "${dataset}": ${err instanceof Error ? err.message : String(err)}`);
                }
        }

        /**
         * Retrieve from the Cognee knowledge graph + session cache.
         * Falls back to MemoryService.retrieve() when Cognee is unavailable.
         *
         * @param query     Search query.
         * @param datasets  Optional list of datasets to search (default: all).
         * @param topK      Maximum number of results (default: 5).
         */
        async recall(query: string, datasets?: string[], topK = 5): Promise<ICogneeRecallResult[]> {
                if (!query.trim()) return [];

                if (!this.isAvailable()) {
                        logger.verbose('[Cognee] recall() falling back to MemoryService.retrieve()');
                        const context = await this._fallback.retrieve(query, topK);
                        if (!context) return [];
                        return [{
                                content: context,
                                datasets: ['memory-service-fallback'],
                                score: 0.5,
                        }];
                }

                try {
                        const args: Record<string, unknown> = { query, top_k: topK };
                        if (datasets && datasets.length > 0) {
                                args.datasets = datasets;
                        }
                        const raw = await this.callTool('recall', args);
                        return this.parseRecallResults(raw);
                } catch (err) {
                        this.recordFailure(err);
                        logger.verbose('[Cognee] recall() failed, falling back to MemoryService.retrieve()');
                        const context = await this._fallback.retrieve(query, topK);
                        if (!context) return [];
                        return [{
                                content: context,
                                datasets: ['memory-service-fallback'],
                                score: 0.5,
                        }];
                }
        }

        /**
         * Search the Cognee knowledge graph with a specific strategy.
         *
         * @param query       Search query.
         * @param searchType  Cognee search strategy.
         * @param datasets    Optional list of datasets to search.
         */
        async search(query: string, searchType: CogneeSearchType, datasets?: string[]): Promise<ICogneeSearchResult[]> {
                if (!query.trim()) return [];

                if (!this.isAvailable()) {
                        logger.verbose('[Cognee] search() skipped — Cognee unavailable');
                        return [];
                }

                try {
                        const args: Record<string, unknown> = { query, search_type: searchType };
                        if (datasets && datasets.length > 0) {
                                args.datasets = datasets;
                        }
                        const raw = await this.callTool('search', args);
                        return this.parseSearchResults(raw, searchType);
                } catch (err) {
                        this.recordFailure(err);
                        logger.warn(`[Cognee] search() failed: ${err instanceof Error ? err.message : String(err)}`);
                        return [];
                }
        }

        /**
         * Delete a dataset and its knowledge from the Cognee graph.
         *
         * @param dataset  Dataset to forget.
         */
        async forget(dataset: string): Promise<void> {
                if (!this.isAvailable()) {
                        logger.verbose('[Cognee] forget() skipped — Cognee unavailable');
                        return;
                }

                try {
                        await this.callTool('forget', { dataset });
                        logger.verbose(`[Cognee] forget(): removed dataset "${dataset}"`);
                } catch (err) {
                        this.recordFailure(err);
                        logger.warn(`[Cognee] forget() failed for dataset "${dataset}": ${err instanceof Error ? err.message : String(err)}`);
                }
        }

        /**
         * Provide feedback to improve Cognee's memory quality.
         *
         * @param feedback   Free-text feedback on recall quality.
         * @param sessionId  Optional session ID to scope the feedback.
         */
        async improve(feedback: string, sessionId?: string): Promise<void> {
                if (!feedback.trim()) return;

                if (!this.isAvailable()) {
                        logger.verbose('[Cognee] improve() skipped — Cognee unavailable');
                        return;
                }

                try {
                        const args: Record<string, unknown> = { feedback };
                        if (sessionId) {
                                args.session_id = sessionId;
                        }
                        await this.callTool('improve', args);
                        logger.verbose('[Cognee] improve(): feedback submitted');
                } catch (err) {
                        this.recordFailure(err);
                        logger.warn(`[Cognee] improve() failed: ${err instanceof Error ? err.message : String(err)}`);
                }
        }

        /**
         * Get graph visualization data for a dataset.
         *
         * @param dataset  Dataset to visualize (default: 'default').
         */
        async visualizeGraph(dataset = 'default'): Promise<ICogneeGraphViz | null> {
                if (!this.isAvailable()) {
                        logger.verbose('[Cognee] visualizeGraph() skipped — Cognee unavailable');
                        return null;
                }

                try {
                        const raw = await this.callTool('visualize_graph', { dataset });
                        return this.parseGraphViz(raw, dataset);
                } catch (err) {
                        this.recordFailure(err);
                        logger.warn(`[Cognee] visualizeGraph() failed: ${err instanceof Error ? err.message : String(err)}`);
                        return null;
                }
        }

        // -----------------------------------------------------------------------
        // Process lifecycle
        // -----------------------------------------------------------------------

        /**
         * Shut down the Cognee service. Kills the subprocess and cleans up.
         */
        async shutdown(): Promise<void> {
                this.stopHealthCheck();

                if (this.healthCheckTimer) {
                        clearInterval(this.healthCheckTimer);
                        this.healthCheckTimer = null;
                }

                this.rejectAllPending(new Error('Cognee service shutting down'));

                if (this.proc) {
                        logger.info('[Cognee] Shutting down MCP server process...');
                        this.proc.kill('SIGTERM');
                        await new Promise<void>((resolve) => {
                                const timer = setTimeout(() => {
                                        try { this.proc?.kill('SIGKILL'); } catch { /* already dead */ }
                                        resolve();
                                }, 3000);
                                this.proc?.on('exit', () => {
                                        clearTimeout(timer);
                                        resolve();
                                });
                        });
                        this.proc = null;
                }

                this._state = 'disabled';
                logger.info('[Cognee] Service shut down.');
        }

        // -----------------------------------------------------------------------
        // Health monitoring
        // -----------------------------------------------------------------------

        /**
         * Perform a health check by calling a lightweight MCP operation.
         * Updates service state based on the result.
         */
        async healthCheck(): Promise<void> {
                if (this._state === 'disabled' || this._state === 'starting') return;

                if (!this.proc || this.proc.killed) {
                        if (this._state !== 'unavailable') {
                                logger.warn('[Cognee] Health check: process is not running. State → unavailable.');
                                this._state = 'unavailable';
                        }
                        return;
                }

                try {
                        // Ping by calling tools/list (lightweight MCP operation)
                        await this.request('tools/list', {}, 5_000);
                        if (this._state !== 'available') {
                                logger.info('[Cognee] Health check: server is responding. State → available.');
                                this._state = 'available';
                                this._consecutiveFailures = 0;
                        }
                } catch (err) {
                        this._consecutiveFailures++;
                        const msg = err instanceof Error ? err.message : String(err);
                        this._lastFailureReason = msg;

                        if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                                if (this._state !== 'unavailable') {
                                        logger.error(`[Cognee] Health check failed ${this._consecutiveFailures} times. State → unavailable. Last error: ${msg}`);
                                        this._state = 'unavailable';
                                }
                        } else if (this._state !== 'degraded') {
                                logger.warn(`[Cognee] Health check failed: ${msg}. State → degraded.`);
                                this._state = 'degraded';
                        }
                }
        }

        private startHealthCheck(): void {
                if (this.healthCheckTimer) return;
                this.healthCheckTimer = setInterval(() => {
                        this.healthCheck().catch((err) => {
                                logger.verbose(`[Cognee] Health check error: ${err instanceof Error ? err.message : String(err)}`);
                        });
                }, HEALTH_CHECK_INTERVAL_MS);
        }

        private stopHealthCheck(): void {
                if (this.healthCheckTimer) {
                        clearInterval(this.healthCheckTimer);
                        this.healthCheckTimer = null;
                }
        }

        // -----------------------------------------------------------------------
        // Subprocess management
        // -----------------------------------------------------------------------

        /**
         * Spawn the Cognee MCP server process and perform the MCP initialize
         * handshake. Uses buildChildEnv() for SEC-9 compliance.
         */
        private async spawnAndConnect(): Promise<void> {
                const pythonPath = this._config.cogneePythonPath;

                // Build environment with Cognee-specific configuration.
                const cogneeEnv: Record<string, string> = {
                        COGNEE_GRAPH_DB: this._config.cogneeGraphDb,
                        COGNEE_EMBED_PROVIDER: this._config.cogneeEmbedProvider,
                };

                // If using Ollama, pass the same base URL the existing embedding
                // service uses so Cognee's pipeline talks to the same Ollama instance.
                if (this._config.cogneeEmbedProvider === 'ollama') {
                        cogneeEnv.COGNEE_EMBED_BASE_URL = 'http://localhost:11434';
                }

                const { env, strippedKeys } = buildChildEnv(cogneeEnv);
                if (strippedKeys.length > 0) {
                        logger.verbose(`[Cognee] Stripped env keys: ${strippedKeys.join(', ')}`);
                }

                // Try python -m cognee.mcp first, fall back to cognee-mcp CLI
                const command = pythonPath;
                const args = ['-m', COGNEE_MCP_MODULE];

                logger.info(`[Cognee] Spawning: ${command} ${args.join(' ')}`);

                this.proc = spawn(command, args, {
                        env,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        // No shell — SEC-3.
                });

                this.proc.stdout.setEncoding('utf8');
                this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
                this.proc.stderr.setEncoding('utf8');
                this.proc.stderr.on('data', (chunk: string) => {
                        logger.verbose(`[Cognee] stderr: ${chunk.trim()}`);
                });
                this.proc.on('error', (err) => {
                        logger.error(`[Cognee] Process error: ${err.message}`);
                        this.rejectAllPending(err);
                });
                this.proc.on('exit', (code, signal) => {
                        logger.info(`[Cognee] Process exited: code=${code} signal=${signal}`);
                        this.rejectAllPending(new Error(`Cognee process exited (code=${code}, signal=${signal})`));
                        this.proc = null;
                        if (this._state !== 'disabled') {
                                this._state = 'unavailable';
                        }
                });

                // MCP initialize handshake
                await this.request('initialize', {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: { name: 'kovix-cognee', version: '0.1.0-alpha' },
                }, INITIALIZE_TIMEOUT_MS);

                // Send initialized notification
                this.notify('notifications/initialized', {});
        }

        // -----------------------------------------------------------------------
        // JSON-RPC 2.0 plumbing (mirrors mcpClient.ts)
        // -----------------------------------------------------------------------

        private onStdout(chunk: string): void {
                this.buffer += chunk;
                let newlineIdx: number;
                while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
                        const line = this.buffer.slice(0, newlineIdx).trim();
                        this.buffer = this.buffer.slice(newlineIdx + 1);
                        if (!line) continue;
                        try {
                                const msg = JSON.parse(line) as IJsonRpcMessage;
                                this.handleMessage(msg);
                        } catch (_err) {
                                logger.verbose(`[Cognee] Non-JSON stdout line: ${line.slice(0, 100)}`);
                        }
                }
        }

        private handleMessage(msg: IJsonRpcMessage): void {
                if (msg.id !== undefined && typeof msg.id === 'number') {
                        const pending = this.pending.get(msg.id);
                        if (!pending) return;
                        this.pending.delete(msg.id);
                        clearTimeout(pending.timer);
                        if (msg.error) {
                                pending.reject(new Error(`Cognee MCP error ${msg.error.code}: ${msg.error.message}`));
                        } else {
                                pending.resolve(msg);
                        }
                }
        }

        private request(method: string, params: unknown, timeoutMs: number): Promise<IJsonRpcMessage> {
                if (!validateMcpMethod(method)) {
                        return Promise.reject(new Error(`MCP method not allowed: ${method}`));
                }
                if (!this.proc) {
                        return Promise.reject(new Error('Cognee MCP server is not connected'));
                }

                const id = this.nextId++;
                const message: IJsonRpcMessage = { jsonrpc: '2.0', id, method, params };

                return new Promise<IJsonRpcMessage>((resolve, reject) => {
                        const timer = setTimeout(() => {
                                this.pending.delete(id);
                                reject(new Error(`Cognee MCP request ${method} timed out after ${timeoutMs}ms`));
                        }, timeoutMs);

                        this.pending.set(id, { resolve, reject, timer });
                        try {
                                this.proc!.stdin.write(JSON.stringify(message) + '\n');
                        } catch (err) {
                                clearTimeout(timer);
                                this.pending.delete(id);
                                reject(new Error(`Cognee MCP write failed: ${err instanceof Error ? err.message : String(err)}`));
                        }
                });
        }

        private notify(method: string, params: unknown): void {
                if (!this.proc) return;
                const message: IJsonRpcMessage = { jsonrpc: '2.0', method, params };
                try {
                        this.proc.stdin.write(JSON.stringify(message) + '\n');
                } catch (err) {
                        logger.verbose(`[Cognee] Failed to send notification ${method}: ${err}`);
                }
        }

        private rejectAllPending(err: Error): void {
                for (const [id, pending] of this.pending) {
                        clearTimeout(pending.timer);
                        pending.reject(err);
                        this.pending.delete(id);
                }
        }

        // -----------------------------------------------------------------------
        // MCP tool invocation
        // -----------------------------------------------------------------------

        /**
         * Call a Cognee MCP tool by name.
         * Returns the raw text content from the MCP response.
         */
        private async callTool(name: string, args: Record<string, unknown>, timeoutMs = TOOL_TIMEOUT_MS): Promise<string> {
                const response = await this.request('tools/call', {
                        name,
                        arguments: args,
                }, timeoutMs);

                const result = response.result as {
                        content?: Array<{ type: string; text?: string }>;
                        isError?: boolean;
                } | undefined;

                if (!result) {
                        throw new Error(`Cognee tool ${name} returned no result`);
                }

                if (result.isError) {
                        const errorText = result.content?.map(c => c.text ?? '').join('\n') ?? 'Unknown error';
                        throw new Error(`Cognee tool ${name} error: ${errorText}`);
                }

                // Reset failure counter on success
                if (this._consecutiveFailures > 0) {
                        logger.info(`[Cognee] Recovered after ${this._consecutiveFailures} failures. State → available.`);
                        this._consecutiveFailures = 0;
                        this._lastFailureReason = '';
                        if (this._state === 'degraded' || this._state === 'unavailable') {
                                this._state = 'available';
                        }
                }

                return result.content?.map(c => c.text ?? '').join('\n') ?? '';
        }

        // -----------------------------------------------------------------------
        // Result parsing
        // -----------------------------------------------------------------------

        private parseRecallResults(raw: string): ICogneeRecallResult[] {
                try {
                        const parsed = JSON.parse(raw);
                        if (Array.isArray(parsed)) {
                                return parsed.map((item: Record<string, unknown>) => ({
                                        content: String(item.content ?? item.text ?? ''),
                                        datasets: Array.isArray(item.datasets) ? item.datasets as string[] : ['default'],
                                        score: typeof item.score === 'number' ? item.score : 0,
                                        nodeId: typeof item.nodeId === 'string' ? item.nodeId : undefined,
                                        ingestedAt: typeof item.ingestedAt === 'string' ? item.ingestedAt : undefined,
                                }));
                        }
                        // Single result
                        return [{
                                content: String(parsed.content ?? parsed.text ?? raw),
                                datasets: Array.isArray(parsed.datasets) ? parsed.datasets as string[] : ['default'],
                                score: typeof parsed.score === 'number' ? parsed.score : 0,
                        }];
                } catch {
                        // Not JSON — treat the raw text as a single result
                        if (!raw.trim()) return [];
                        return [{
                                content: raw,
                                datasets: ['default'],
                                score: 0,
                        }];
                }
        }

        private parseSearchResults(raw: string, searchType: CogneeSearchType): ICogneeSearchResult[] {
                try {
                        const parsed = JSON.parse(raw);
                        if (Array.isArray(parsed)) {
                                return parsed.map((item: Record<string, unknown>) => ({
                                        content: String(item.content ?? item.text ?? ''),
                                        searchType,
                                        datasets: Array.isArray(item.datasets) ? item.datasets as string[] : ['default'],
                                        score: typeof item.score === 'number' ? item.score : 0,
                                        metadata: typeof item.metadata === 'object' && item.metadata !== null ? item.metadata as Record<string, unknown> : undefined,
                                }));
                        }
                        return [{
                                content: String(parsed.content ?? parsed.text ?? raw),
                                searchType,
                                datasets: ['default'],
                                score: 0,
                        }];
                } catch {
                        if (!raw.trim()) return [];
                        return [{
                                content: raw,
                                searchType,
                                datasets: ['default'],
                                score: 0,
                        }];
                }
        }

        private parseGraphViz(raw: string, dataset: string): ICogneeGraphViz | null {
                try {
                        const parsed = JSON.parse(raw);
                        return {
                                nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
                                edges: Array.isArray(parsed.edges) ? parsed.edges : [],
                                dataset: parsed.dataset ?? dataset,
                        };
                } catch {
                        logger.verbose('[Cognee] visualize_graph returned non-JSON response');
                        return null;
                }
        }

        // -----------------------------------------------------------------------
        // Failure tracking (mirrors H-1 pattern from embeddingService)
        // -----------------------------------------------------------------------

        private recordFailure(err: unknown): void {
                const msg = err instanceof Error ? err.message : String(err);
                this._consecutiveFailures++;
                this._lastFailureReason = msg;

                if (this._consecutiveFailures === 1) {
                        logger.warn(`[Cognee] Operation failed: ${msg}. State → degraded.`);
                        this._state = 'degraded';
                } else if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        logger.error(
                                `[Cognee] UNAVAILABLE after ${this._consecutiveFailures} consecutive failures. ` +
                                `Last failure: ${msg}. Falling back to MemoryService.`,
                        );
                        this._state = 'unavailable';
                } else {
                        logger.warn(`[Cognee] Failure #${this._consecutiveFailures}: ${msg}`);
                }
        }

        // -----------------------------------------------------------------------
        // Configuration
        // -----------------------------------------------------------------------

        private readConfig(): Required<ICogneeConfig> {
                if (!isAppStateInitialized()) {
                        return { ...DEFAULT_COGNEE_CONFIG };
                }
                const cfg = getAppState().config;
                return {
                        cogneeEnabled: cfg.cogneeEnabled ?? DEFAULT_COGNEE_CONFIG.cogneeEnabled,
                        cogneePythonPath: cfg.cogneePythonPath ?? DEFAULT_COGNEE_CONFIG.cogneePythonPath,
                        cogneeGraphDb: cfg.cogneeGraphDb ?? DEFAULT_COGNEE_CONFIG.cogneeGraphDb,
                        cogneeEmbedProvider: cfg.cogneeEmbedProvider ?? DEFAULT_COGNEE_CONFIG.cogneeEmbedProvider,
                };
        }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: CogneeService | undefined;

/**
 * Get the Cognee service singleton. Must call initCogneeService() first.
 * Returns the service regardless of its state — use isAvailable() to check.
 */
export function getCogneeService(): CogneeService {
        if (!_instance) {
                _instance = new CogneeService();
        }
        return _instance;
}

/**
 * Initialise the Cognee service singleton. Reads configuration and
 * optionally spawns the Cognee MCP server subprocess.
 *
 * This is idempotent — calling it multiple times is safe (subsequent
 * calls are no-ops after the first initialisation).
 */
export async function initCogneeService(): Promise<void> {
        const svc = getCogneeService();
        if (svc.initialized) return;
        await svc.init();
}

/**
 * Shut down and reset the Cognee service. For use in tests or when
 * the application is closing.
 */
export async function resetCogneeService(): Promise<void> {
        if (_instance) {
                await _instance.shutdown();
                _instance = undefined;
        }
}

// Re-export types for convenience
export type { CogneeService };
export type {
        ICogneeConfig,
        ICogneeRecallResult,
        ICogneeSearchResult,
        ICogneeGraphViz,
        CogneeServiceState,
} from './cogneeTypes';
export { CogneeSearchType } from './cogneeTypes';
