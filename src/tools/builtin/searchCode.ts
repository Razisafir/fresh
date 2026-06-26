/**
 * searchCode.ts — Layer 2 built-in tool: search_code.
 *
 * NOT PORTED — this is a NEW tool for v0.1. The old repo's `search_codebase`
 * used Qdrant (vector store) for semantic search. Per 02_ARCHITECTURE.md §4.3
 * and the v0.1 MUST list, vector-store-backed semantic search is deferred
 * to v1.0-beta (M5 memory work). For v0.1 we need a simpler regex-based
 * code search that runs offline with no external dependencies.
 *
 * 02_ARCHITECTURE.md §4.3: "search_code tool (ripgrep via child_process)".
 * 02_ARCHITECTURE.md §6.1 open architecture question: "Terminal executor
 * implementation. Use vscode.tasks (integrated terminal, visible to user)
 * or child_process (hidden, faster, no UI)? Lead recommendation: child_process
 * for run_command tool; vscode.tasks only for verification harness."
 *
 * Implementation: spawns `rg` (ripgrep) directly via the terminal executor.
 * - `rg` is bundled with VS Code (in `<vscode-dir>/resources/app/`)
 *   but we don't depend on that — we use whatever `rg` is on PATH. If
 *   `rg` is not installed, we fall back to `grep -r` (slower, but works
 *   everywhere). If neither is available, we return an error.
 * - Search is rooted at the first workspace folder.
 * - Results are limited to MAX_RESULTS (default 50) matches.
 * - Each match shows file path, line number, and the matching line (trimmed).
 *
 * This tool does NOT use the SSRF guard (no network), does NOT modify files,
 * and does NOT require user approval. It's safe to run autonomously in any
 * mode.
 *
 * Decisions referenced: D-011 (extension route), 02_ARCHITECTURE.md §4.3
 * (v0.1 tool list), §6.1 (child_process for agent tools).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ITool, IToolResult, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { terminalExecutor } from '../../terminal/terminalExecutor';
import { logger } from '../../util/logger';

const MAX_OUTPUT_LENGTH = 100_000;
const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 200;

/**
 * Tool definition for search_code.
 */
export const searchCodeTool: ITool = {
        name: 'search_code',
        description: 'Search the workspace for a regex pattern using ripgrep. Returns matching file paths, line numbers, and lines. Use to find code by content (function names, error messages, API endpoints, etc.).',
        inputSchema: {
                type: 'object',
                properties: {
                        pattern: {
                                type: 'string',
                                description: 'Regex pattern to search for (case-insensitive by default). Use anchors (^, $) and character classes ([a-z]) as needed.',
                        },
                        path: {
                                type: 'string',
                                description: 'Optional sub-directory to search (relative to workspace root). Defaults to the workspace root.',
                        },
                        max_results: {
                                type: 'number',
                                description: 'Maximum number of matches to return. Defaults to 50. Hard-capped at 200.',
                                default: DEFAULT_MAX_RESULTS,
                        },
                        case_sensitive: {
                                type: 'boolean',
                                description: 'Whether the search is case-sensitive. Defaults to false.',
                                default: false,
                        },
                },
                required: ['pattern'],
        },
        modifiesFiles: false,
        requiresNetwork: false,
        category: 'search',
};

/**
 * Execute function for search_code.
 *
 * Spawns `rg` (ripgrep) with:
 *   --line-number        Show line numbers.
 *   --no-heading         Don't print filename as a heading.
 *   --color never        Plain text output.
 *   --max-count N        Limit matches per file (we cap total below).
 *   -i or no flag        Case-insensitive toggle.
 *   <pattern>            The regex.
 *   <cwd>                The search root.
 *
 * Falls back to `grep -r` if `rg` is not on PATH. If neither is available,
 * returns an error.
 */
export const executeSearchCode: ToolExecuteFn = async (input, signal) => {
        const pattern = input.pattern as string;
        if (!pattern) {
                return {
                        success: false,
                        output: 'Missing required parameter: pattern',
                        truncated: false,
                };
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
                return {
                        success: false,
                        output: 'No workspace folder open. Open a folder to search.',
                        truncated: false,
                };
        }

        const subPath = input.path as string | undefined;
        const searchRoot = subPath
                ? path.resolve(workspaceRoot, subPath)
                : workspaceRoot;

        const maxResults = Math.min(
                (input.max_results as number | undefined) ?? DEFAULT_MAX_RESULTS,
                HARD_MAX_RESULTS,
        );
        const caseSensitive = (input.case_sensitive as boolean | undefined) ?? false;

        // Build rg args.
        const rgArgs = [
                '--line-number',
                '--no-heading',
                '--color', 'never',
                '--max-count', String(maxResults),
        ];
        if (!caseSensitive) {
                rgArgs.push('-i');
        }
        rgArgs.push('--', pattern, '.');

        try {
                const result = await terminalExecutor.execute('rg', rgArgs, {
                        cwd: searchRoot,
                        timeoutMs: 30_000,
                        signal,
                });

                // rg exits 0 on matches, 1 on no matches, 2 on error.
                if (result.exitCode === 2) {
                        // Fall back to grep -r if rg is not installed (ENOENT shows up
                        // as a thrown error, but rg might also exit 2 on some systems).
                        logger.verbose(`[search_code] rg exited 2, trying grep fallback. stderr: ${result.stderr}`);
                        return await grepFallback(pattern, searchRoot, maxResults, caseSensitive, signal);
                }

                const output = (result.stdout ?? '').trim();
                if (!output) {
                        return {
                                success: true,
                                output: `No matches found for pattern: "${pattern}"`,
                                truncated: false,
                        };
                }

                const truncated = output.length > MAX_OUTPUT_LENGTH;
                const displayOutput = truncated
                        ? output.substring(0, MAX_OUTPUT_LENGTH) + '\n... [truncated]'
                        : output;

                return {
                        success: true,
                        output: displayOutput,
                        truncated,
                };
        } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // rg not on PATH → fall back to grep -r.
                if (msg.includes('ENOENT') || msg.includes('not found')) {
                        logger.verbose('[search_code] rg not found, falling back to grep -r');
                        return await grepFallback(pattern, searchRoot, maxResults, caseSensitive, signal);
                }
                return {
                        success: false,
                        output: `Search failed: ${msg}`,
                        truncated: false,
                };
        }
};

/**
 * Fallback: use `grep -r` when ripgrep is not available.
 *
 * Slower and less featureful than rg, but works on every POSIX system.
 * Output format is the same (file:line:content) so the agent can parse
 * either uniformly.
 */
async function grepFallback(
        pattern: string,
        searchRoot: string,
        maxResults: number,
        caseSensitive: boolean,
        signal?: AbortSignal,
): Promise<IToolResult> {
        const grepArgs = ['-rn', '--color=never'];
        if (!caseSensitive) {
                grepArgs.push('-i');
        }
        grepArgs.push('--', pattern, '.');

        try {
                const result = await terminalExecutor.execute('grep', grepArgs, {
                        cwd: searchRoot,
                        timeoutMs: 60_000,
                        signal,
                });

                // grep exits 0 on matches, 1 on no matches, 2 on error.
                if (result.exitCode === 2) {
                        return {
                                success: false,
                                output: `Search failed (grep error): ${result.stderr || 'unknown error'}`,
                                truncated: false,
                        };
                }

                const output = (result.stdout ?? '').trim();
                if (!output) {
                        return {
                                success: true,
                                output: `No matches found for pattern: "${pattern}"`,
                                truncated: false,
                        };
                }

                // Truncate to maxResults lines.
                const lines = output.split('\n').slice(0, maxResults);
                const truncatedOutput = lines.join('\n');
                const truncated = truncatedOutput.length > MAX_OUTPUT_LENGTH ||
                        output.split('\n').length > maxResults;

                return {
                        success: true,
                        output: truncated && output.length > truncatedOutput.length
                                ? truncatedOutput + `\n... [truncated to ${maxResults} matches]`
                                : truncatedOutput,
                        truncated,
                };
        } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                        success: false,
                        output: `Search failed (grep not available): ${msg}. Install ripgrep for best results, or grep as a fallback.`,
                        truncated: false,
                };
        }
}

/**
 * Register the search_code tool with the given registry.
 */
export function registerSearchCodeTool(registry: IConstructToolRegistry): void {
        registry.registerTool(searchCodeTool, executeSearchCode);
}
