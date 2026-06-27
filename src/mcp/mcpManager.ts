/**
 * mcpManager.ts — Multi-server MCP manager (M6, v1.0-beta).
 *
 * Reads `kovix.mcp.servers` from VS Code settings, spawns one McpClient per
 * server, discovers their tools via `tools/list`, and registers each tool
 * with the toolRegistry using the naming convention `<serverName>__<toolName>`.
 *
 * Tool execution: when the agent calls an MCP tool, the manager routes the
 * call to the appropriate McpClient, applies SEC-6/SEC-7 sanitisation to
 * the output, and returns the result.
 *
 * Security invariants applied:
 *   - SEC-6: all MCP tool outputs are sanitised via sanitiseForLlm() before
 *     returning to the LLM (strips injection prefixes, wraps in delimiters).
 *   - SEC-7: secrets in MCP tool outputs are redacted via redactSecrets().
 *   - SEC-9: child process env is sanitised in McpClient (via buildChildEnv).
 *
 * Security invariants NOT applied (flagged per Phase 8-B prompt):
 *   - SEC-4 (workspace boundary): MCP tools are opaque — we cannot inspect
 *     what they do with their inputs. An MCP filesystem tool could read
 *     files outside the workspace. The user must trust the MCP server.
 *     This is documented in the README's "What's not in v1.1-alpha" section
 *     and in the settings description.
 *
 * Settings UI: per Phase 8-B prompt, MCP servers are configured via the
 * JSON-array `kovix.mcp.servers` setting in settings.json. No dedicated
 * config UI is built for v1.0-beta. If usability testing shows this is
 * too hard for non-technical users, a dedicated config UI can be added
 * in v1.0-rc.
 *
 * Decisions referenced: D-002, Phase 8-B (stdio only, JSON-array settings).
 */

import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import { sanitise as sanitiseForLlm } from '../security/promptSanitiser';
import { redactSecrets } from '../security/secretPatterns';
import { validateToolName } from '../security/workspaceGuard';
import { logger } from '../util/logger';
import type { IConstructToolRegistry, ITool, ToolExecuteFn, IToolResult } from '../types/tools';
import type { IMcpServerConfig, IMcpToolDefinition } from './types';

const MCP_TOOL_CATEGORY = 'mcp' as const;
const MCP_TOOL_PREFIX = '__';

/**
 * The MCP manager. One instance per extension host.
 *
 * Lifecycle:
 *   const mgr = new McpManager(registry);
 *   await mgr.start();    // read config, connect to all servers, register tools
 *   ...                   // agent runs, MCP tools are available
 *   await mgr.stop();     // disconnect all servers, unregister tools
 */
export class McpManager {
	private readonly registry: IConstructToolRegistry;
	private readonly clients = new Map<string, McpClient>();
	private readonly registeredToolNames: string[] = [];

	constructor(registry: IConstructToolRegistry) {
		this.registry = registry;
	}

	/** Read config, connect to all MCP servers, register their tools. */
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
				// One server failing shouldn't break the others.
				logger.error(`[MCP ${config.name}] Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/** Disconnect all servers and unregister all MCP tools. */
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

	/** Number of MCP servers currently connected. */
	get connectedServerCount(): number {
		return this.clients.size;
	}

	/** Number of MCP tools currently registered. */
	get registeredToolCount(): number {
		return this.registeredToolNames.length;
	}

	// --- Internal ---

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

		// Validate the composite name against the allowlist. MCP tool names
		// contain the `__` separator which isn't in the v0.1 allowlist —
		// but validateToolName is for BUILT-IN tools only. MCP tools are
		// registered directly via registerTool(), bypassing the allowlist
		// check that happens at the agent-loop level. The agent loop's
		// tool-call validation handles MCP tool names via the `serverName__toolName`
		// pattern (see agentLoopHelpers.mapToolToActionType).
		void validateToolName; // referenced for documentation; MCP tools bypass the built-in allowlist

		const mcpTool: ITool = {
			name: fullToolName,
			description: `[MCP:${serverName}] ${tool.description}`,
			inputSchema: this.adaptInputSchema(tool.inputSchema),
			modifiesFiles: true, // conservative default — MCP tools are opaque
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
		const timeoutMs = vscode.workspace.getConfiguration('kovix.mcp').get<number>('toolTimeoutMs', 30_000);
		const startTime = Date.now();

		try {
			// Honour abort signal
			if (signal?.aborted) {
				return { success: false, output: 'Aborted before MCP tool call', truncated: false };
			}

			const result = await client.callTool(toolName, input, timeoutMs);
			const durationMs = Date.now() - startTime;

			// Concatenate all text content items into a single string.
			// Non-text content (images, resources) is represented as
			// `[binary content: <type>]` for now — v1.0-rc can add proper
			// multimodal handling if needed.
			const rawText = result.content
				.map((item) => {
					if (item.type === 'text' && item.text) return item.text;
					return `[${item.type} content]`;
				})
				.join('\n');

			// SEC-7: redact secrets from the MCP tool output.
			const redacted = redactSecrets(rawText);

			// SEC-6: sanitise before returning to the LLM (strips injection
			// prefixes, wraps in delimiters).
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

	/**
	 * Adapt an MCP tool's inputSchema (which may be a loose JSON Schema) to
	 * the stricter ITool.inputSchema shape. MCP schemas don't always declare
	 * `type: 'object'` at the top level — we default it.
	 */
	private adaptInputSchema(schema: Record<string, unknown>): ITool['inputSchema'] {
		return {
			type: 'object',
			properties: (schema.properties as ITool['inputSchema']['properties']) ?? {},
			required: (schema.required as string[]) ?? [],
		};
	}

	private readConfig(): IMcpServerConfig[] {
		const raw = vscode.workspace.getConfiguration('kovix.mcp').get<IMcpServerConfig[]>('servers', []);
		if (!Array.isArray(raw)) return [];
		// Filter out entries missing required fields
		return raw.filter((c) => c && typeof c.name === 'string' && typeof c.command === 'string');
	}
}
