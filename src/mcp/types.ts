/**
 * types.ts — Shared types for the MCP server host (M6, v1.0-beta).
 *
 * MCP (Model Context Protocol) is a JSON-RPC 2.0 protocol over stdio for
 * communicating with external tool servers. See https://modelcontextprotocol.io
 *
 * v1.0-beta scope: stdio transport only. SSE/remote MCP servers are a later
 * addition (don't build it now just because it's possible).
 *
 * Decisions referenced: D-002 (MCP deferred to v1.0-beta), Phase 8-B.
 * Security: SEC-9 (child env sanitised via buildChildEnv), SEC-6/SEC-7
 * (tool outputs sanitised + secrets redacted before returning to LLM).
 */

/**
 * Configuration for a single MCP server, as declared in the
 * `kovix.mcp.servers` setting in VS Code's settings.json.
 *
 * Example settings.json entry:
 *   "kovix.mcp.servers": [
 *     {
 *       "name": "filesystem",
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
 *     }
 *   ]
 */
export interface IMcpServerConfig {
	/** Unique name for this server. Used as a prefix for tool names: `<name>__<tool>`. */
	name: string;
	/** The executable to spawn (e.g. "npx", "python", "node"). */
	command: string;
	/** Arguments to pass to the command. */
	args?: string[];
	/** Optional environment variables for the child process (sanitised via buildChildEnv). */
	env?: Record<string, string>;
	/** Optional working directory for the child process. Defaults to cwd. */
	cwd?: string;
}

/**
 * A tool definition as reported by an MCP server's `tools/list` response.
 * Translated into an ITool for registration with the toolRegistry.
 */
export interface IMcpToolDefinition {
	/** Tool name (without the server prefix). */
	name: string;
	/** Human-readable description. */
	description: string;
	/** JSON Schema for the tool's input parameters. */
	inputSchema: Record<string, unknown>;
}

/**
 * The result of an MCP `tools/call` — the `content` array is the raw
 * response from the server. We concatenate all text content items into
 * a single string for the IToolResult.output.
 */
export interface IMcpCallResult {
	content: Array<{
		type: 'text' | 'image' | 'resource';
		text?: string;
		[key: string]: unknown;
	}>;
	isError?: boolean;
}

/**
 * JSON-RPC 2.0 request/response envelope.
 */
export interface IJsonRpcMessage {
	jsonrpc: '2.0';
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}
