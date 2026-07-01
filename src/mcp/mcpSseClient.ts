/**
 * mcpSseClient.ts — MCP client over SSE (Server-Sent Events) transport.
 *
 * Manages the lifecycle of one remote MCP server connection via HTTP/SSE:
 *   1. Open SSE connection to server endpoint (GET with Accept: text/event-stream)
 *   2. Send JSON-RPC 2.0 requests via HTTP POST
 *   3. Receive responses and notifications via the SSE stream
 *   4. initialize handshake → tools/list → tools/call
 *   5. Clean shutdown on disconnect()
 *
 * Transport spec:
 *   - Client sends JSON-RPC requests via HTTP POST to the server endpoint
 *   - Server sends responses and notifications via SSE stream
 *   - Connection lifecycle: connect → initialize handshake → use → disconnect
 *
 * Features:
 *   - Auto-reconnect with exponential backoff (configurable)
 *   - Request timeout handling (same pattern as stdio client)
 *   - Health check via ping/heartbeat
 *   - EventEmitter pattern for server-initiated notifications
 *
 * Security:
 *   - SEC-6/SEC-7: the CALLER (mcpManager) is responsible for sanitising
 *     tool outputs before returning to the LLM. This layer returns raw text.
 *   - Custom headers (e.g. Authorization) are passed through as-is — the
 *     caller is responsible for not leaking secrets via header logging.
 *
 * Decisions referenced: D-002, Phase 8-B (SSE transport addition).
 */

import { EventEmitter } from 'events';
import { validateMcpMethod } from '../security/workspaceGuard';
import { logger } from '../util/logger';
import type { IMcpToolDefinition, IMcpCallResult, IJsonRpcMessage } from './types';
import type { IMcpSseServerConfig, IMcpSseConnectionState } from './mcpSseTypes';

const INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT = true;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const PING_INTERVAL_MS = 30_000;

/**
 * MCP SSE client — one instance per remote MCP server.
 *
 * Lifecycle:
 *   const client = new McpSseClient(config);
 *   await client.connect();          // open SSE connection + initialize handshake
 *   const tools = await client.listTools();  // tools/list
 *   const result = await client.callTool('toolName', { args });  // tools/call
 *   await client.disconnect();       // close SSE connection
 */
export class McpSseClient extends EventEmitter {
        private readonly config: IMcpSseServerConfig;
        private nextId = 1;
        private readonly pending = new Map<number, {
                resolve: (msg: IJsonRpcMessage) => void;
                reject: (err: Error) => void;
                timer: ReturnType<typeof setTimeout>;
        }>();
        private _state: IMcpSseConnectionState = 'disconnected';
        private abortController: AbortController | null = null;
        private reconnectAttempts = 0;
        private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        private pingTimer: ReturnType<typeof setInterval> | null = null;
        private _messageEndpoint: string | null = null;

        constructor(config: IMcpSseServerConfig) {
                super();
                this.config = config;
        }

        /** Current connection state. */
        get state(): IMcpSseConnectionState {
                return this._state;
        }

        /** Whether the SSE connection is alive and handshake is complete. */
        get connected(): boolean {
                return this._state === 'connected';
        }

        /** Open SSE connection and perform the initialize handshake. */
        async connect(): Promise<void> {
                if (this._state === 'connected' || this._state === 'connecting') {
                        throw new Error(`[MCP SSE ${this.config.name}] Already connecting or connected`);
                }

                this._state = 'connecting';
                logger.info(`[MCP SSE ${this.config.name}] Connecting to ${this.config.url}`);

                try {
                        await this.openSseConnection();
                        await this.initialize();
                        this._state = 'connected';
                        this.reconnectAttempts = 0;
                        this.startPing();
                        logger.info(`[MCP SSE ${this.config.name}] Connected`);
                } catch (err) {
                        this._state = 'disconnected';
                        const msg = err instanceof Error ? err.message : String(err);
                        logger.error(`[MCP SSE ${this.config.name}] Connection failed: ${msg}`);

                        if (this.shouldReconnect()) {
                                this.scheduleReconnect();
                        }
                        throw err;
                }
        }

        /** Call `tools/list` and return the tool definitions. */
        async listTools(): Promise<IMcpToolDefinition[]> {
                const response = await this.request('tools/list', {}, DEFAULT_TOOL_TIMEOUT_MS);
                const tools = (response.result as { tools?: IMcpToolDefinition[] })?.tools ?? [];
                return tools;
        }

        /** Call `tools/call` and return the raw result. */
        async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<IMcpCallResult> {
                const response = await this.request('tools/call', {
                        name,
                        arguments: args,
                }, timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
                return response.result as IMcpCallResult;
        }

        /** Close the SSE connection and reject any pending requests. */
        async disconnect(): Promise<void> {
                this._state = 'disconnected';
                this.rejectAllPending(new Error(`MCP SSE client ${this.config.name} disconnecting`));
                this.stopPing();
                this.clearReconnectTimer();

                if (this.abortController) {
                        this.abortController.abort();
                        this.abortController = null;
                }

                this._messageEndpoint = null;
                logger.info(`[MCP SSE ${this.config.name}] Disconnected`);
        }

        // --- SSE connection management ---

        /**
         * Open the SSE connection to the server endpoint.
         * Discovers the message endpoint from the SSE stream.
         */
        private async openSseConnection(): Promise<void> {
                this.abortController = new AbortController();

                return new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => {
                                reject(new Error(`SSE connection to ${this.config.url} timed out after ${INITIALIZE_TIMEOUT_MS}ms`));
                        }, INITIALIZE_TIMEOUT_MS);

                        const headers: Record<string, string> = {
                                'Accept': 'text/event-stream',
                                ...this.config.headers,
                        };

                        fetch(this.config.url, {
                                method: 'GET',
                                headers,
                                signal: this.abortController!.signal,
                        }).then((response) => {
                                if (!response.ok) {
                                        clearTimeout(timeout);
                                        reject(new Error(`SSE connection returned HTTP ${response.status}: ${response.statusText}`));
                                        return;
                                }

                                if (!response.body) {
                                        clearTimeout(timeout);
                                        reject(new Error('SSE connection returned no body stream'));
                                        return;
                                }

                                const reader = response.body.getReader();
                                const decoder = new TextDecoder();
                                let buffer = '';
                                let endpointDiscovered = false;

                                const processChunk = (chunk: string): void => {
                                        buffer += chunk;
                                        const lines = buffer.split('\n');
                                        // Keep the last incomplete line in the buffer
                                        buffer = lines.pop() ?? '';

                                        let currentEvent = '';
                                        let currentData = '';

                                        for (const line of lines) {
                                                if (line.startsWith('event:')) {
                                                        currentEvent = line.slice(6).trim();
                                                } else if (line.startsWith('data:')) {
                                                        currentData += (currentData ? '\n' : '') + line.slice(5).trim();
                                                } else if (line === '') {
                                                        // Empty line = end of SSE event
                                                        if (currentData) {
                                                                this.handleSseEvent(currentEvent, currentData, !endpointDiscovered ? resolve : undefined, !endpointDiscovered ? timeout : undefined);
                                                                // Check if we discovered the endpoint from this event
                                                                if (!endpointDiscovered && this._messageEndpoint) {
                                                                        endpointDiscovered = true;
                                                                }
                                                        }
                                                        currentEvent = '';
                                                        currentData = '';
                                                }
                                        }
                                };

                                const readLoop = (): void => {
                                        reader.read().then(({ done, value }) => {
                                                if (done) {
                                                        clearTimeout(timeout);
                                                        if (!endpointDiscovered) {
                                                                reject(new Error('SSE stream ended before message endpoint was discovered'));
                                                        }
                                                        // Stream ended — handle reconnect
                                                        this.handleStreamEnd();
                                                        return;
                                                }
                                                processChunk(decoder.decode(value, { stream: true }));
                                                readLoop();
                                        }).catch((err) => {
                                                clearTimeout(timeout);
                                                if (!endpointDiscovered) {
                                                        reject(new Error(`SSE stream read error: ${err instanceof Error ? err.message : String(err)}`));
                                                }
                                                this.handleStreamEnd();
                                        });
                                };

                                readLoop();
                        }).catch((err) => {
                                clearTimeout(timeout);
                                if (err instanceof DOMException && err.name === 'AbortError') {
                                        reject(new Error('SSE connection aborted'));
                                } else {
                                        reject(new Error(`SSE connection failed: ${err instanceof Error ? err.message : String(err)}`));
                                }
                        });
                });
        }

        /**
         * Handle a single SSE event from the server stream.
         * The first 'endpoint' event tells us where to POST JSON-RPC messages.
         * Subsequent 'message' events contain JSON-RPC responses/notifications.
         */
        private handleSseEvent(
                event: string,
                data: string,
                resolveConnect?: () => void,
                connectTimeout?: ReturnType<typeof setTimeout>,
        ): void {
                if (event === 'endpoint') {
                        // The server tells us the URL to POST messages to.
                        // It may be a relative path — resolve against the base URL.
                        const endpoint = data.trim();
                        if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
                                this._messageEndpoint = endpoint;
                        } else {
                                // Relative path — resolve against the SSE base URL
                                try {
                                        const base = new URL(this.config.url);
                                        this._messageEndpoint = `${base.origin}${endpoint}`;
                                } catch {
                                        // Fallback: use as-is
                                        this._messageEndpoint = endpoint;
                                }
                        }
                        logger.verbose(`[MCP SSE ${this.config.name}] Message endpoint: ${this._messageEndpoint}`);

                        if (resolveConnect) {
                                clearTimeout(connectTimeout!);
                                resolveConnect();
                        }
                        return;
                }

                // Default event type is 'message' — parse as JSON-RPC
                try {
                        const msg = JSON.parse(data) as IJsonRpcMessage;
                        this.handleMessage(msg);
                } catch {
                        logger.verbose(`[MCP SSE ${this.config.name}] Non-JSON SSE event: ${data.slice(0, 100)}`);
                }
        }

        /** Handle stream end — attempt reconnect if configured. */
        private handleStreamEnd(): void {
                if (this._state === 'disconnected') return;

                logger.warn(`[MCP SSE ${this.config.name}] SSE stream ended`);
                this.rejectAllPending(new Error(`MCP SSE server ${this.config.name} stream ended`));

                if (this.shouldReconnect()) {
                        this._state = 'reconnecting';
                        this.scheduleReconnect();
                } else {
                        this._state = 'disconnected';
                }
        }

        // --- JSON-RPC plumbing ---

        /**
         * Handle a JSON-RPC message received from the SSE stream.
         * Responses (with id) resolve pending requests.
         * Notifications (without id) are emitted as events.
         */
        private handleMessage(msg: IJsonRpcMessage): void {
                // Responses have an id matching a pending request
                if (msg.id !== undefined && typeof msg.id === 'number') {
                        const pending = this.pending.get(msg.id);
                        if (!pending) return; // stale or duplicate
                        this.pending.delete(msg.id);
                        clearTimeout(pending.timer);
                        if (msg.error) {
                                pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
                        } else {
                                pending.resolve(msg);
                        }
                }
                // Notifications (no id or string id) are emitted for subscribers
                if (msg.method && msg.id === undefined) {
                        this.emit('notification', msg);
                        this.emit(`notification:${msg.method}`, msg.params);
                }
        }

        /**
         * Send a JSON-RPC request via HTTP POST and wait for the response
         * via the SSE stream.
         */
        private request(method: string, params: unknown, timeoutMs: number): Promise<IJsonRpcMessage> {
                if (!validateMcpMethod(method)) {
                        return Promise.reject(new Error(`MCP method not allowed: ${method}`));
                }
                if (!this._messageEndpoint) {
                        return Promise.reject(new Error(`MCP SSE server ${this.config.name} has no message endpoint`));
                }
                if (this._state !== 'connected' && this._state !== 'connecting') {
                        return Promise.reject(new Error(`MCP SSE server ${this.config.name} is not connected (state: ${this._state})`));
                }

                const id = this.nextId++;
                const message: IJsonRpcMessage = { jsonrpc: '2.0', id, method, params };

                return new Promise<IJsonRpcMessage>((resolve, reject) => {
                        const timer = setTimeout(() => {
                                this.pending.delete(id);
                                reject(new Error(`MCP SSE request ${method} timed out after ${timeoutMs}ms`));
                        }, timeoutMs);

                        this.pending.set(id, { resolve, reject, timer });

                        const headers: Record<string, string> = {
                                'Content-Type': 'application/json',
                                ...this.config.headers,
                        };

                        fetch(this._messageEndpoint!, {
                                method: 'POST',
                                headers,
                                body: JSON.stringify(message),
                        }).catch((fetchErr) => {
                                // If the POST itself fails, reject the pending request
                                this.pending.delete(id);
                                clearTimeout(timer);
                                reject(new Error(`MCP SSE POST failed for ${method}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`));
                        });
                });
        }

        /** Send a JSON-RPC notification (no response expected). */
        private notify(method: string, params: unknown): void {
                if (!this._messageEndpoint) {
                        logger.verbose(`[MCP SSE ${this.config.name}] Cannot send notification ${method}: no message endpoint`);
                        return;
                }

                const message: IJsonRpcMessage = { jsonrpc: '2.0', method, params };

                const headers: Record<string, string> = {
                        'Content-Type': 'application/json',
                        ...this.config.headers,
                };

                fetch(this._messageEndpoint!, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(message),
                }).catch((err) => {
                        logger.verbose(`[MCP SSE ${this.config.name}] Failed to send notification ${method}: ${err}`);
                });
        }

        /** Perform the MCP initialize handshake. */
        private async initialize(): Promise<void> {
                await this.request('initialize', {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: { name: 'kovix', version: '0.1.0-alpha' },
                }, INITIALIZE_TIMEOUT_MS);

                // Send initialized notification (no response expected)
                this.notify('notifications/initialized', {});
        }

        // --- Reconnect logic ---

        /** Whether auto-reconnect is enabled and attempts remain. */
        private shouldReconnect(): boolean {
                const enabled = this.config.reconnect ?? DEFAULT_RECONNECT;
                const maxAttempts = this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
                return enabled && this.reconnectAttempts < maxAttempts;
        }

        /** Schedule a reconnect attempt with exponential backoff. */
        private scheduleReconnect(): void {
                const baseDelay = this.config.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
                const delay = baseDelay * Math.pow(2, this.reconnectAttempts);
                // Add jitter: random value between 0 and baseDelay
                const jitter = Math.floor(Math.random() * baseDelay);
                const totalDelay = delay + jitter;

                this.reconnectAttempts++;
                logger.info(`[MCP SSE ${this.config.name}] Reconnecting in ${totalDelay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS})`);

                this.reconnectTimer = setTimeout(async () => {
                        this.reconnectTimer = null;
                        try {
                                // Clean up old connection state
                                if (this.abortController) {
                                        this.abortController.abort();
                                        this.abortController = null;
                                }
                                this._messageEndpoint = null;

                                await this.openSseConnection();
                                await this.initialize();
                                this._state = 'connected';
                                this.reconnectAttempts = 0;
                                this.startPing();
                                logger.info(`[MCP SSE ${this.config.name}] Reconnected successfully`);
                                this.emit('reconnected');
                        } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                logger.error(`[MCP SSE ${this.config.name}] Reconnect attempt ${this.reconnectAttempts} failed: ${msg}`);

                                if (this.shouldReconnect()) {
                                        this.scheduleReconnect();
                                } else {
                                        this._state = 'disconnected';
                                        logger.error(`[MCP SSE ${this.config.name}] Max reconnect attempts reached, giving up`);
                                        this.emit('reconnect_failed');
                                }
                        }
                }, totalDelay);
        }

        /** Clear any pending reconnect timer. */
        private clearReconnectTimer(): void {
                if (this.reconnectTimer !== null) {
                        clearTimeout(this.reconnectTimer);
                        this.reconnectTimer = null;
                }
        }

        // --- Health check / ping ---

        /** Start periodic health check pings. */
        private startPing(): void {
                this.stopPing();
                this.pingTimer = setInterval(() => {
                        if (this._state !== 'connected') return;
                        // MCP uses 'ping' method for health checks
                        this.request('ping', {}, DEFAULT_TOOL_TIMEOUT_MS).catch((err) => {
                                logger.warn(`[MCP SSE ${this.config.name}] Ping failed: ${err instanceof Error ? err.message : String(err)}`);
                        });
                }, PING_INTERVAL_MS);
        }

        /** Stop periodic health check pings. */
        private stopPing(): void {
                if (this.pingTimer !== null) {
                        clearInterval(this.pingTimer);
                        this.pingTimer = null;
                }
        }

        // --- Utility ---

        /** Reject all pending requests with the given error. */
        private rejectAllPending(err: Error): void {
                for (const [id, pending] of this.pending) {
                        clearTimeout(pending.timer);
                        pending.reject(err);
                        this.pending.delete(id);
                }
        }
}
