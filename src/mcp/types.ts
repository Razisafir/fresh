/**
 * types.ts — Shared types for the MCP server host (M6, v1.0-beta).
 *
 * MCP (Model Context Protocol) is a JSON-RPC 2.0 protocol for
 * communicating with external tool servers. See https://modelcontextprotocol.io
 *
 * Supports both stdio (local child process) and SSE (remote HTTP/SSE)
 * transports. The `transport` field on `IMcpServerConfig` selects which
 * transport to use — defaults to 'stdio' for backward compatibility.
 *
 * Decisions referenced: D-002 (MCP deferred to v1.0-beta), Phase 8-B.
 * Security: SEC-9 (child env sanitised via buildChildEnv), SEC-6/SEC-7
 * (tool outputs sanitised + secrets redacted before returning to LLM).
 */

/**
 * Transport type for an MCP server connection.
 * - 'stdio' — local child process (spawn command, newline-delimited JSON-RPC)
 * - 'sse'   — remote HTTP/SSE (POST requests, SSE response stream)
 */
export type McpTransportType = 'stdio' | 'sse';

/**
 * Configuration for a single MCP server, as declared in the
 * `kovix.mcp.servers` setting.
 *
 * Example stdio settings entry:
 *   {
 *     "name": "filesystem",
 *     "command": "npx",
 *     "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
 *   }
 *
 * Example SSE settings entry:
 *   {
 *     "name": "cognee-cloud",
 *     "transport": "sse",
 *     "url": "https://api.cognee.ai/mcp/sse",
 *     "headers": { "Authorization": "Bearer sk-..." }
 *   }
 */
export interface IMcpServerConfig {
        /** Unique name for this server. Used as a prefix for tool names: `<name>__<tool>`. */
        name: string;
        /** Transport type. Defaults to 'stdio' for backward compatibility. */
        transport?: McpTransportType;
        /**
         * The executable to spawn for stdio transport (e.g. "npx", "python", "node").
         * Required when transport is 'stdio'. Ignored for 'sse'.
         */
        command?: string;
        /** Arguments to pass to the command (stdio only). */
        args?: string[];
        /** Optional environment variables for the child process (sanitised via buildChildEnv, stdio only). */
        env?: Record<string, string>;
        /** Optional working directory for the child process. Defaults to cwd (stdio only). */
        cwd?: string;
        /**
         * The SSE endpoint URL for SSE transport (e.g. "https://api.cognee.ai/mcp/sse").
         * Required when transport is 'sse'. Ignored for 'stdio'.
         */
        url?: string;
        /** Custom HTTP headers for SSE requests (e.g. Authorization). SSE only. */
        headers?: Record<string, string>;
        /** Auto-reconnect on disconnect. SSE only. Default: true. */
        reconnect?: boolean;
        /** Maximum reconnect attempts before giving up. SSE only. Default: 5. */
        maxReconnectAttempts?: number;
        /** Base delay in ms for exponential backoff on reconnect. SSE only. Default: 1000. */
        reconnectBaseDelayMs?: number;
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
