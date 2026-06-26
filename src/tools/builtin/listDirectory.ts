/**
 * listDirectory.ts — Layer 2 built-in tool: list_directory.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/tools/constructToolRegistryService.ts` (lines 319-340 schema, 1588-1635 impl)
 * Port strategy: PORT WITH TRANSLATION.
 *
 * 02_ARCHITECTURE.md §4.3 lists this as a v0.1 built-in tool.
 *
 * Translation notes:
 *   - `IFileService.resolve(uri)` (returns children array) →
 *     `vscode.workspace.fs.readDirectory(uri)` (returns [name, FileType][]).
 *   - `child.isDirectory` (VS Code FileStat flag) → `entry[1] === vscode.FileType.Directory`.
 *   - `assertWithinWorkspace(path, workspaceRoot)` uses our multi-root-aware
 *     signature.
 *
 * The `recursive` parameter from the old schema is supported but not
 * deeply recursive in v0.1 — it lists one level deep and notes in the
 * output if any of the entries are themselves directories the agent can
 * drill into. A true recursive listing would be expensive for large
 * workspaces and risks huge outputs. The agent can call list_directory
 * again on a sub-directory.
 *
 * SEC-4 (path traversal) is enforced via `assertWithinWorkspace()`.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route),
 * SEC-4 (path traversal defence).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ITool, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { assertWithinWorkspace } from '../../security/workspaceGuard';
import { logger } from '../../util/logger';

const MAX_OUTPUT_LENGTH = 100_000;

/**
 * Tool definition for list_directory.
 */
export const listDirectoryTool: ITool = {
        name: 'list_directory',
        description: 'List the contents of a directory. Returns file and directory names within the specified path. Use to explore the workspace structure.',
        inputSchema: {
                type: 'object',
                properties: {
                        path: {
                                type: 'string',
                                description: 'Absolute or workspace-relative path to the directory to list.',
                        },
                        recursive: {
                                type: 'boolean',
                                description: 'Whether to list contents recursively. Defaults to false. When true, lists one level deep and notes which entries are directories (call list_directory again on a sub-directory to drill in).',
                                default: false,
                        },
                },
                required: ['path'],
        },
        modifiesFiles: false,
        requiresNetwork: false,
        category: 'file',
};

/**
 * Execute function for list_directory.
 */
export const executeListDirectory: ToolExecuteFn = async (input) => {
        const dirPath = input.path as string;
        if (!dirPath) {
                return {
                        success: false,
                        output: 'Missing required parameter: path',
                        truncated: false,
                };
        }

        try {
                // SEC-4: Path traversal prevention
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (root) {
                        assertWithinWorkspace(dirPath, root);
                }

                const uri = resolveUri(dirPath);
                const entries = await vscode.workspace.fs.readDirectory(uri);

                // Sort: directories first, then files, alphabetically within each group.
                entries.sort((a, b) => {
                        const aIsDir = a[1] === vscode.FileType.Directory;
                        const bIsDir = b[1] === vscode.FileType.Directory;
                        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
                        return a[0].localeCompare(b[0]);
                });

                if (entries.length === 0) {
                        return {
                                success: true,
                                output: `Directory is empty: ${dirPath}`,
                                truncated: false,
                        };
                }

                const lines: string[] = [];
                for (const [name, type] of entries) {
                        const isDir = type === vscode.FileType.Directory;
                        const isSymlink = type === vscode.FileType.SymbolicLink;
                        const prefix = isDir ? '[DIR]  ' : isSymlink ? '[LINK] ' : '[FILE] ';
                        lines.push(prefix + name);
                }

                const output = lines.join('\n');
                const truncated = output.length > MAX_OUTPUT_LENGTH;

                logger.verbose(`[list_directory] Listed ${uri.fsPath} (${entries.length} entries${truncated ? ', truncated' : ''})`);

                return {
                        success: true,
                        output: truncated
                                ? output.substring(0, MAX_OUTPUT_LENGTH) + '\n... [truncated]'
                                : output,
                        truncated,
                };
        } catch (error) {
                return {
                        success: false,
                        output: `Failed to list directory "${dirPath}": ${error instanceof Error ? error.message : String(error)}`,
                        truncated: false,
                };
        }
};

/**
 * Resolve a path string to a vscode.Uri.
 */
function resolveUri(filePath: string): vscode.Uri {
        if (!path.isAbsolute(filePath) && !filePath.match(/^[A-Z]:\\/i)) {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (root) {
                        return vscode.Uri.file(path.join(root, filePath));
                }
        }
        return vscode.Uri.file(filePath);
}

/**
 * Register the list_directory tool with the given registry.
 */
export function registerListDirectoryTool(registry: IConstructToolRegistry): void {
        registry.registerTool(listDirectoryTool, executeListDirectory);
}
