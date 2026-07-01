/**
 * mcpClient.ts — Single MCP server connection over stdio (M6, v1.0-beta).
 *
 * Manages the lifecycle of one MCP server child process:
 *   1. spawn(command, args, { env: buildChildEnv(...).env }) — SEC-9
 *   2. JSON-RPC 2.0 over stdin/stdout (newline-delimited JSON)
 *   3. initialize handshake → tools/list → tools/call
 *   4. clean shutdown on dispose()
 *
 * v1.0-beta scope: stdio transport only. SSE/remote servers are a later
 * addition.
 *
 * Security:
 *   - SEC-3: uses spawn() (no shell). ESLint enforces no child_process.exec.
 *   - SEC-9: child env is sanitised via buildChildEnv() — strips NODE_OPTIONS,
 *     LD_PRELOAD, PYTHONPATH, etc.
 *   - SEC-6/SEC-7: the CALLER (mcpManager) is responsible for sanitising
 *     tool outputs before returning to the LLM. This layer returns raw text.
 *
 * Decisions referenced: D-002, Phase 8-B (stdio only).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { buildChildEnv } from '../security/childEnv';
import { validateMcpMethod } from '../security/workspaceGuard';
import { logger } from '../util/logger';
import type { IMcpServerConfig, IMcpToolDefinition, IMcpCallResult, IJsonRpcMessage } from './types';

const INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * MCP client — one instance per MCP server.
 *
 * Lifecycle:
 *   const client = new McpClient(config);
 *   await client.connect();          // spawn + initialize handshake
 *   const tools = await client.listTools();  // tools/list
 *   const result = await client.callTool('toolName', { args });  // tools/call
 *   await client.disconnect();       // kill child process
 */
export class McpClient {
        private readonly config: IMcpServerConfig;
        private proc: ChildProcessWithoutNullStreams | null = null;
        private nextId = 1;
        private readonly pending = new Map<number, {
                resolve: (msg: IJsonRpcMessage) => void;
                reject: (err: Error) => void;
                timer: ReturnType<typeof setTimeout>;
        }>();
        private buffer = '';

        constructor(config: IMcpServerConfig) {
                this.config = config;
        }

        /** Spawn the server process and perform the initialize handshake. */
        async connect(): Promise<void> {
                if (!this.config.command) {
                        throw new Error(`MCP server ${this.config.name} requires a command for stdio transport`);
                }

                const { env, strippedKeys } = buildChildEnv(this.config.env);
                if (strippedKeys.length > 0) {
                        logger.verbose(`[MCP ${this.config.name}] Stripped env keys: ${strippedKeys.join(', ')}`);
                }

                this.proc = spawn(this.config.command, this.config.args ?? [], {
                        env,
                        cwd: this.config.cwd,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        // No shell — SEC-3. spawn() directly, not exec().
                });

                this.proc.stdout.setEncoding('utf8');
                this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
                this.proc.stderr.setEncoding('utf8');
                this.proc.stderr.on('data', (chunk: string) => {
                        // MCP servers log to stderr; surface in verbose mode for debugging.
                        logger.verbose(`[MCP ${this.config.name}] stderr: ${chunk.trim()}`);
                });
                this.proc.on('error', (err) => {
                        logger.error(`[MCP ${this.config.name}] Process error: ${err.message}`);
                        this.rejectAllPending(err);
                });
                this.proc.on('exit', (code, signal) => {
                        logger.info(`[MCP ${this.config.name}] Process exited: code=${code} signal=${signal}`);
                        this.rejectAllPending(new Error(`MCP server ${this.config.name} exited (code=${code}, signal=${signal})`));
                        this.proc = null;
                });

                // Initialize handshake
                await this.request('initialize', {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: { name: 'kovix', version: '0.1.0-alpha' },
                }, INITIALIZE_TIMEOUT_MS);

                // Send initialized notification (no response expected)
                this.notify('notifications/initialized', {});
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

        /** Kill the child process and reject any pending requests. */
        async disconnect(): Promise<void> {
                if (!this.proc) return;
                this.rejectAllPending(new Error('MCP client disconnecting'));
                this.proc.kill('SIGTERM');
                // Give it 2s to exit gracefully, then SIGKILL
                await new Promise<void>((resolve) => {
                        const timer = setTimeout(() => {
                                try { this.proc?.kill('SIGKILL'); } catch { /* already dead */ }
                                resolve();
                        }, 2000);
                        this.proc?.on('exit', () => { clearTimeout(timer); resolve(); });
                });
                this.proc = null;
        }

        /** Whether the underlying process is still alive. */
        get connected(): boolean {
                return this.proc !== null && !this.proc.killed;
        }

        // --- JSON-RPC plumbing ---

        private onStdout(chunk: string): void {
                this.buffer += chunk;
                // Newline-delimited JSON — process each complete line
                let newlineIdx: number;
                while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
                        const line = this.buffer.slice(0, newlineIdx).trim();
                        this.buffer = this.buffer.slice(newlineIdx + 1);
                        if (!line) continue;
                        try {
                                const msg = JSON.parse(line) as IJsonRpcMessage;
                                this.handleMessage(msg);
                        } catch (_err) {
                                logger.verbose(`[MCP ${this.config.name}] Non-JSON stdout line: ${line.slice(0, 100)}`);
                        }
                }
        }

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
                // Notifications (no id) are ignored in v1.0-beta — we don't subscribe
                // to server-initiated notifications. Can be added later if needed.
        }

        private request(method: string, params: unknown, timeoutMs: number): Promise<IJsonRpcMessage> {
                if (!validateMcpMethod(method)) {
                        return Promise.reject(new Error(`MCP method not allowed: ${method}`));
                }
                if (!this.proc) {
                        return Promise.reject(new Error(`MCP server ${this.config.name} is not connected`));
                }
                const id = this.nextId++;
                const message: IJsonRpcMessage = { jsonrpc: '2.0', id, method, params };

                return new Promise<IJsonRpcMessage>((resolve, reject) => {
                        const timer = setTimeout(() => {
                                this.pending.delete(id);
                                reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
                        }, timeoutMs);

                        this.pending.set(id, { resolve, reject, timer });
                        this.proc!.stdin.write(JSON.stringify(message) + '\n');
                });
        }

        private notify(method: string, params: unknown): void {
                if (!this.proc) return;
                const message: IJsonRpcMessage = { jsonrpc: '2.0', method, params };
                try {
                        this.proc.stdin.write(JSON.stringify(message) + '\n');
                } catch (err) {
                        logger.verbose(`[MCP ${this.config.name}] Failed to send notification ${method}: ${err}`);
                }
        }

        private rejectAllPending(err: Error): void {
                for (const [id, pending] of this.pending) {
                        clearTimeout(pending.timer);
                        pending.reject(err);
                        this.pending.delete(id);
                }
        }
}
