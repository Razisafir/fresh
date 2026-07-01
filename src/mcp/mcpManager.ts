/**
 * mcpManager.ts — Multi-server MCP manager (M6, v1.0-beta).
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.workspace.getConfiguration → getAppState().config
 *
 * SSE transport addition: supports both stdio (local child process) and
 * SSE (remote HTTP/SSE) MCP server connections. The `transport` field on
 * each server config determines which client implementation to use.
 */

import { McpClient } from './mcpClient';
import { McpSseClient } from './mcpSseClient';
import { sanitise as sanitiseForLlm } from '../security/promptSanitiser';
import { redactSecrets } from '../security/secretPatterns';
import { validateToolName } from '../security/workspaceGuard';
import { logger } from '../util/logger';
import type { IConstructToolRegistry, ITool, ToolExecuteFn, IToolResult } from '../types/tools';
import type { IMcpServerConfig, IMcpToolDefinition, IMcpCallResult } from './types';
import type { IMcpSseServerConfig } from './mcpSseTypes';
import { getAppState } from '../platform/appState';

const MCP_TOOL_CATEGORY = 'mcp' as const;
const MCP_TOOL_PREFIX = '__';

/**
 * Common interface shared by both stdio and SSE MCP client implementations.
 * Both McpClient and McpSseClient satisfy this interface.
 */
interface IMcpClient {
        connect(): Promise<void>;
        disconnect(): Promise<void>;
        listTools(): Promise<IMcpToolDefinition[]>;
        callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<IMcpCallResult>;
        readonly connected: boolean;
}

export class McpManager {
        private readonly registry: IConstructToolRegistry;
        private readonly clients = new Map<string, IMcpClient>();
        private readonly registeredToolNames: string[] = [];

        constructor(registry: IConstructToolRegistry) {
                this.registry = registry;
        }

        async start(): Promise<void> {
                const configs = this.readConfig();
                if (configs.length === 0) {
                        logger.info('[MCP] No servers configured.');
                        return;
                }

                for (const config of configs) {
                        try {
                                await this.connectServer(config);
                        } catch (err) {
                                logger.error(`[MCP ${config.name}] Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
                        }
                }
        }

        async stop(): Promise<void> {
                for (const name of this.registeredToolNames) {
                        try {
                                this.registry.unregisterTool(name);
                        } catch (err) {
                                logger.verbose(`[MCP] Failed to unregister tool ${name}: ${err}`);
                        }
                }
                this.registeredToolNames.length = 0;

                for (const [name, client] of this.clients) {
                        try {
                                await client.disconnect();
                        } catch (err) {
                                logger.verbose(`[MCP ${name}] Error during disconnect: ${err}`);
                        }
                }
                this.clients.clear();
        }

        get connectedServerCount(): number {
                return this.clients.size;
        }

        get registeredToolCount(): number {
                return this.registeredToolNames.length;
        }

        private async connectServer(config: IMcpServerConfig): Promise<void> {
                const transport = config.transport ?? 'stdio';

                if (transport === 'sse') {
                        await this.connectSseServer(config);
                } else {
                        await this.connectStdioServer(config);
                }
        }

        private async connectStdioServer(config: IMcpServerConfig): Promise<void> {
                if (!config.command) {
                        throw new Error(`MCP server ${config.name} is configured as stdio but has no command`);
                }
                logger.info(`[MCP ${config.name}] Connecting (stdio): ${config.command} ${(config.args ?? []).join(' ')}`);

                const client = new McpClient(config);
                await client.connect();
                this.clients.set(config.name, client);

                const tools = await client.listTools();
                logger.info(`[MCP ${config.name}] Discovered ${tools.length} tools`);

                for (const tool of tools) {
                        this.registerMcpTool(config.name, tool, client);
                }
        }

        private async connectSseServer(config: IMcpServerConfig): Promise<void> {
                if (!config.url) {
                        throw new Error(`MCP server ${config.name} is configured as SSE but has no url`);
                }
                logger.info(`[MCP ${config.name}] Connecting (SSE): ${config.url}`);

                const sseConfig: IMcpSseServerConfig = {
                        ...config,
                        transport: 'sse',
                        url: config.url,
                        headers: config.headers,
                        reconnect: config.reconnect,
                        maxReconnectAttempts: config.maxReconnectAttempts,
                        reconnectBaseDelayMs: config.reconnectBaseDelayMs,
                };

                const client = new McpSseClient(sseConfig);
                await client.connect();
                this.clients.set(config.name, client);

                const tools = await client.listTools();
                logger.info(`[MCP ${config.name}] Discovered ${tools.length} tools`);

                for (const tool of tools) {
                        this.registerMcpTool(config.name, tool, client);
                }
        }

        private registerMcpTool(serverName: string, tool: IMcpToolDefinition, client: IMcpClient): void {
                const fullToolName = `${serverName}${MCP_TOOL_PREFIX}${tool.name}`;

                // SEC-4: Validate MCP tool name against allowed pattern.
                // MCP tool names follow the pattern: serverName__toolName
                // We validate the tool part to prevent injection via malicious MCP servers.
                if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) {
                        logger.warn(`[MCP ${serverName}] Rejecting tool with invalid name: "${tool.name}" (must match /^[a-zA-Z0-9_-]+$/)`);
                        return;
                }

                // Also validate using the built-in validateToolName for the built-in set,
                // but allow MCP tools that aren't in the built-in set (they have a different namespace).
                // The regex check above is the primary guard for MCP tools.
                void validateToolName; // kept for future use when we enforce built-in name overlap checks

                const mcpTool: ITool = {
                        name: fullToolName,
                        description: `[MCP:${serverName}] ${tool.description}`,
                        inputSchema: this.adaptInputSchema(tool.inputSchema),
                        modifiesFiles: true,
                        requiresNetwork: false,
                        category: MCP_TOOL_CATEGORY,
                };

                const executeFn: ToolExecuteFn = async (input, signal) => {
                        return this.executeMcpTool(client, serverName, tool.name, input, signal);
                };

                this.registry.registerTool(mcpTool, executeFn);
                this.registeredToolNames.push(fullToolName);
                logger.verbose(`[MCP ${serverName}] Registered tool: ${tool.name} → ${fullToolName}`);
        }

        private async executeMcpTool(
                client: IMcpClient,
                serverName: string,
                toolName: string,
                input: Record<string, unknown>,
                signal?: AbortSignal,
        ): Promise<IToolResult> {
                const timeoutMs = getAppState().config.mcpToolTimeoutMs;
                const startTime = Date.now();

                try {
                        if (signal?.aborted) {
                                return { success: false, output: 'Aborted before MCP tool call', truncated: false };
                        }

                        const result = await client.callTool(toolName, input, timeoutMs);
                        const durationMs = Date.now() - startTime;

                        const rawText = result.content
                                .map((item) => {
                                        if (item.type === 'text' && item.text) return item.text;
                                        return `[${item.type} content]`;
                                })
                                .join('\n');

                        const redacted = redactSecrets(rawText);
                        const sanitised = sanitiseForLlm(redacted);

                        return {
                                success: !result.isError,
                                output: sanitised,
                                truncated: false,
                                metadata: {
                                        durationMs,
                                        tool: `${serverName}${MCP_TOOL_PREFIX}${toolName}`,
                                },
                        };
                } catch (err) {
                        const durationMs = Date.now() - startTime;
                        return {
                                success: false,
                                output: `MCP tool ${serverName}/${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
                                truncated: false,
                                metadata: { durationMs, tool: `${serverName}${MCP_TOOL_PREFIX}${toolName}` },
                        };
                }
        }

        private adaptInputSchema(schema: Record<string, unknown>): ITool['inputSchema'] {
                return {
                        type: 'object',
                        properties: (schema.properties as ITool['inputSchema']['properties']) ?? {},
                        required: (schema.required as string[]) ?? [],
                };
        }

        private readConfig(): IMcpServerConfig[] {
                const raw = getAppState().config.mcpServers;
                if (!Array.isArray(raw)) return [];

                return raw.filter((c) => {
                        if (!c || typeof c.name !== 'string') return false;
                        const transport = c.transport ?? 'stdio';
                        if (transport === 'sse') {
                                return typeof c.url === 'string';
                        }
                        return typeof c.command === 'string';
                }) as IMcpServerConfig[];
        }
}
