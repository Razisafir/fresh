/**
 * webFetch.ts — Layer 2 built-in tool: web_fetch.
 *
 * NOT PORTED — this is a NEW tool for v0.1. The old repo's `web_search`
 * used an LLM API (OpenAI-compatible) to generate search results, which
 * is fragile (depends on a configured cloud key) and not really "fetch".
 * Per 02_ARCHITECTURE.md §4.3 we ship a simpler `web_fetch` tool that
 * does HTTP GET against a user-supplied URL, with the SSRF guard
 * (`urlGuard.ts`) as the only network gate.
 *
 * 02_ARCHITECTURE.md §4.3: "web_fetch tool (HTTP via node fetch, with URL guard)".
 *
 * What this tool does:
 *   - Validates the URL via `safeFetch()` from `src/security/urlGuard.ts`.
 *     safeFetch() refuses:
 *       - loopback (127/8, ::1) unless KOVIX_ALLOW_LOOPBACK=1
 *       - link-local (169.254/16 — cloud metadata endpoint)
 *       - private ranges (10/8, 172.16/12, 192.168/16) unless
 *         KOVIX_ALLOW_PRIVATE_NET=1 (useful for local Ollama / LM Studio)
 *       - redirects to private IPs (manual redirect following)
 *   - Performs an HTTP GET with a 30s timeout.
 *   - Returns the response body as text (truncated to MAX_OUTPUT_LENGTH).
 *   - Returns metadata: status code, content-type, final URL (after redirects).
 *
 * This tool is intended for "fetch this URL and read its content" use cases
 * (documentation pages, API responses, JSON files). For semantic web search
 * (which the old repo's web_search provided), the v1.0 plan is to integrate
 * with an MCP server (e.g. agent_reach) rather than reinventing search here.
 *
 * Decisions referenced: D-011 (extension route), 02_ARCHITECTURE.md §4.3
 * (v0.1 tool list), SEC-7 (SSRF defence via urlGuard).
 */

import type { ITool, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { safeFetch } from '../../security/urlGuard';
import { logger } from '../../util/logger';

const MAX_OUTPUT_LENGTH = 100_000;
const MAX_TIMEOUT_MS = 60_000;

/**
 * Tool definition for web_fetch.
 */
export const webFetchTool: ITool = {
        name: 'web_fetch',
        description: 'Fetch the content of a web URL via HTTP GET. The URL is validated against an SSRF guard (loopback, link-local, and private IP ranges are blocked unless explicitly allowed via env vars). Returns the response body as text.',
        inputSchema: {
                type: 'object',
                properties: {
                        url: {
                                type: 'string',
                                description: 'The full URL to fetch (e.g. https://example.com/docs). Must include the scheme (http:// or https://).',
                        },
                        timeout: {
                                type: 'number',
                                description: 'Timeout in seconds. Defaults to 30. Hard-capped at 60.',
                                default: 30,
                        },
                },
                required: ['url'],
        },
        modifiesFiles: false,
        requiresNetwork: true,
        category: 'network',
};

/**
 * Execute function for web_fetch.
 *
 * Uses `safeFetch()` from urlGuard.ts which:
 *   - Validates the URL against the SSRF blocklist before connecting.
 *   - Disables automatic redirect-following and re-validates each redirect
 *     target manually (prevents 302-to-private-IP bypass).
 *   - Honours KOVIX_ALLOW_PRIVATE_NET and KOVIX_ALLOW_LOOPBACK env vars
 *     for users who need to fetch from local services.
 */
export const executeWebFetch: ToolExecuteFn = async (input, signal) => {
        const url = input.url as string;
        if (!url) {
                return {
                        success: false,
                        output: 'Missing required parameter: url',
                        truncated: false,
                };
        }

        // Validate URL format up front (safeFetch also validates, but a clearer
        // error message here helps the agent re-plan).
        try {
                new URL(url);
        } catch {
                return {
                        success: false,
                        output: `Invalid URL: "${url}". Must include scheme (http:// or https://).`,
                        truncated: false,
                };
        }

        const timeoutSec = (input.timeout as number | undefined) ?? 30;
        const timeoutMs = Math.min(
                Math.max(1, timeoutSec) * 1000,
                MAX_TIMEOUT_MS,
        );

        // Combine our timeout with the AbortSignal from the caller (if any).
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        if (signal) {
                if (signal.aborted) {
                        clearTimeout(timer);
                        return {
                                success: false,
                                output: 'Aborted before fetch started.',
                                truncated: false,
                        };
                }
                signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        try {
                const response = await safeFetch(url, {
                        method: 'GET',
                        signal: controller.signal,
                        redirect: 'follow', // safeFetch follows manually with re-validation
                        headers: {
                                'User-Agent': 'Kovix-Agent/0.1 (web_fetch tool)',
                                'Accept': 'text/html,application/json,text/plain,*/*',
                        },
                });

                if (!response.ok) {
                        return {
                                success: false,
                                output: `HTTP ${response.status} ${response.statusText} fetching ${url}`,
                                truncated: false,
                                metadata: {
                                        mode: `http_${response.status}`,
                                },
                        };
                }

                const text = await response.text();
                const truncated = text.length > MAX_OUTPUT_LENGTH;
                const output = truncated
                        ? text.substring(0, MAX_OUTPUT_LENGTH) + '\n... [truncated]'
                        : text;

                const contentType = response.headers.get('content-type') ?? 'unknown';
                const finalUrl = response.url || url;

                logger.verbose(`[web_fetch] Fetched ${finalUrl} (${response.status}, ${contentType}, ${text.length} chars${truncated ? ', truncated' : ''})`);

                return {
                        success: true,
                        output,
                        truncated,
                        metadata: {
                                bytesProcessed: text.length,
                                mode: `http_${response.status}`,
                        },
                };
        } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                // Common case: aborted (timeout or user cancellation).
                if (msg.includes('aborted') || msg.includes('Aborted')) {
                        return {
                                success: false,
                                output: `Fetch aborted (timeout or cancellation): ${url}`,
                                truncated: false,
                        };
                }
                return {
                        success: false,
                        output: `Failed to fetch ${url}: ${msg}`,
                        truncated: false,
                };
        } finally {
                clearTimeout(timer);
        }
};

/**
 * Register the web_fetch tool with the given registry.
 */
export function registerWebFetchTool(registry: IConstructToolRegistry): void {
        registry.registerTool(webFetchTool, executeWebFetch);
}
