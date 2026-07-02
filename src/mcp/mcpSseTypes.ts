/**
 * mcpSseTypes.ts — SSE transport types for remote MCP servers.
 *
 * Extends the base MCP types with SSE-specific configuration and state
 * for connecting to remote MCP servers over HTTP/SSE (e.g. cloud-hosted
 * Cognee, or any MCP server that exposes an HTTP/SSE endpoint).
 *
 * MCP SSE transport spec:
 *   - Client sends JSON-RPC requests via HTTP POST to the server endpoint
 *   - Server sends responses and notifications via SSE stream
 *   - Connection lifecycle: connect → initialize handshake → use → disconnect
 *
 * Decisions referenced: D-002, Phase 8-B (SSE transport addition).
 */

import type { IMcpServerConfig } from './types';

/**
 * Configuration for a single SSE-based MCP server, as declared in the
 * `kovix.mcp.servers` setting.
 *
 * Example settings entry:
 *   {
 *     "name": "cognee-cloud",
 *     "transport": "sse",
 *     "url": "https://api.cognee.ai/mcp/sse",
 *     "headers": { "Authorization": "Bearer sk-..." }
 *   }
 */
export interface IMcpSseServerConfig extends IMcpServerConfig {
        /** Transport type — always 'sse' for this config type. */
        transport: 'sse';
        /** The SSE endpoint URL (e.g. "https://api.cognee.ai/mcp/sse"). */
        url: string;
        /** Custom HTTP headers to include in requests (for auth, etc.). */
        headers?: Record<string, string>;
        /** Auto-reconnect on disconnect (default: true). */
        reconnect?: boolean;
        /** Maximum reconnect attempts before giving up (default: 5). */
        maxReconnectAttempts?: number;
        /** Base delay in ms for exponential backoff on reconnect (default: 1000). */
        reconnectBaseDelayMs?: number;
}

/**
 * Shape of an SSE event received from the server.
 * Follows the standard SSE `MessageEvent` data format with JSON-RPC payloads.
 */
export interface IMcpSseEvent {
        /** SSE event type (e.g. 'message', 'endpoint', 'error'). */
        event?: string;
        /** JSON-RPC message data (parsed from the SSE `data` field). */
        data: unknown;
        /** SSE event ID (for resuming interrupted streams). */
        id?: string;
}

/**
 * Connection state for an SSE MCP client.
 * Tracks the lifecycle of the HTTP/SSE connection.
 */
export type IMcpSseConnectionState =
        | 'connecting'     // Opening SSE connection, handshake not yet complete
        | 'connected'      // SSE connection open, initialize handshake done
        | 'reconnecting'   // Connection lost, attempting to reconnect
        | 'disconnected';  // Permanently disconnected (manual or max retries exceeded)
