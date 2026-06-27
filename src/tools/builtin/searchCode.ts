/**
 * searchCode.ts — Layer 2 built-in tool: search_code.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.workspace.workspaceFolders → getAppState().workspaceRoots.roots
 */

import * as path from 'path';
import type { ITool, IToolResult, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { terminalExecutor } from '../../terminal/terminalExecutor';
import { logger } from '../../util/logger';
import { getAppState } from '../../platform/appState';

const MAX_OUTPUT_LENGTH = 100_000;
const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 200;

export const searchCodeTool: ITool = {
	name: 'search_code',
	description: 'Search the workspace for a regex pattern using ripgrep. Returns matching file paths, line numbers, and lines.',
	inputSchema: {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'Regex pattern to search for (case-insensitive by default).',
			},
			path: {
				type: 'string',
				description: 'Optional sub-directory to search (relative to workspace root).',
			},
			max_results: {
				type: 'number',
				description: 'Maximum number of matches to return. Defaults to 50.',
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

export const executeSearchCode: ToolExecuteFn = async (input, signal) => {
	const pattern = input.pattern as string;
	if (!pattern) {
		return {
			success: false,
			output: 'Missing required parameter: pattern',
			truncated: false,
		};
	}

	const workspaceRoot = getAppState().workspaceRoots.roots[0];
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

		if (result.exitCode === 2) {
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
			output: `Search failed (grep not available): ${msg}. Install ripgrep for best results.`,
			truncated: false,
		};
	}
}

export function registerSearchCodeTool(registry: IConstructToolRegistry): void {
	registry.registerTool(searchCodeTool, executeSearchCode);
}
