/**
 * mcpManager.ts — Multi-server MCP manager (M6, v1.0-beta).
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.workspace.getConfiguration → getAppState().config
 */

import { McpClient } from './mcpClient';
import { sanitise as sanitiseForLlm } from '../security/promptSanitiser';
import { redactSecrets } from '../security/secretPatterns';
import { validateToolName } from '../security/workspaceGuard';
import { logger } from '../util/logger';
import type { IConstructToolRegistry, ITool, ToolExecuteFn, IToolResult } from '../types/tools';
import type { IMcpServerConfig, IMcpToolDefinition } from './types';
import { getAppState } from '../platform/appState';

const MCP_TOOL_CATEGORY = 'mcp' as const;
const MCP_TOOL_PREFIX = '__';

export class McpManager {
	private readonly registry: IConstructToolRegistry;
	private readonly clients = new Map<string, McpClient>();
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
		logger.info(`[MCP ${config.name}] Connecting: ${config.command} ${(config.args ?? []).join(' ')}`);

		const client = new McpClient(config);
		await client.connect();
		this.clients.set(config.name, client);

		const tools = await client.listTools();
		logger.info(`[MCP ${config.name}] Discovered ${tools.length} tools`);

		for (const tool of tools) {
			this.registerMcpTool(config.name, tool, client);
		}
	}

	private registerMcpTool(serverName: string, tool: IMcpToolDefinition, client: McpClient): void {
		const fullToolName = `${serverName}${MCP_TOOL_PREFIX}${tool.name}`;

		void validateToolName;

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
		client: McpClient,
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
		return raw.filter((c) => c && typeof c.name === 'string' && typeof c.command === 'string');
	}
}
