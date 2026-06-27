/**
 * listDirectory.ts — Layer 2 built-in tool: list_directory.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.workspace.fs.readDirectory → platformFs.listDirectory
 *   - vscode.FileType.Directory → 'directory' string
 *   - vscode.Uri.file → Uri.file from platform/uris.ts
 */

import * as path from 'path';
import type { ITool, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { assertWithinWorkspace } from '../../security/workspaceGuard';
import { getWorkspaceRootsProvider } from '../../security/workspaceRoots';
import { logger } from '../../util/logger';
import * as platformFs from '../../platform/fs';
import { getAppState } from '../../platform/appState';

const MAX_OUTPUT_LENGTH = 100_000;

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
                                description: 'Whether to list contents recursively. Defaults to false.',
                                default: false,
                        },
                },
                required: ['path'],
        },
        modifiesFiles: false,
        requiresNetwork: false,
        category: 'file',
};

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
                assertWithinWorkspace(dirPath, getWorkspaceRootsProvider());

                const resolvedPath = resolvePath(dirPath);
                const entries = await platformFs.listDirectory(resolvedPath);

                // Sort: directories first, then files, alphabetically within each group.
                entries.sort((a, b) => {
                        const aIsDir = a[1] === 'directory';
                        const bIsDir = b[1] === 'directory';
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
                        const prefix = type === 'directory' ? '[DIR]  ' : '[FILE] ';
                        lines.push(prefix + name);
                }

                const output = lines.join('\n');
                const truncated = output.length > MAX_OUTPUT_LENGTH;

                logger.verbose(`[list_directory] Listed ${resolvedPath} (${entries.length} entries${truncated ? ', truncated' : ''})`);

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

function resolvePath(filePath: string): string {
        if (!path.isAbsolute(filePath) && !filePath.match(/^[A-Z]:\\/i)) {
                const root = getAppState().workspaceRoots.roots[0];
                if (root) {
                        return path.join(root, filePath);
                }
        }
        return filePath;
}

export function registerListDirectoryTool(registry: IConstructToolRegistry): void {
        registry.registerTool(listDirectoryTool, executeListDirectory);
}
