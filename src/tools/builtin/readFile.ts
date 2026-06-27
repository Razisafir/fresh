/**
 * readFile.ts — Layer 2 built-in tool: read_file.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.workspace.fs.readFile → platformFs.readFile
 *   - vscode.Uri.file → Uri.file from platform/uris.ts
 *   - vscode.workspace.workspaceFolders → getAppState().workspaceRoots.roots
 *
 * SEC-4 (path traversal) is enforced via assertWithinWorkspace().
 */

import * as path from 'path';
import type { ITool, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { assertWithinWorkspace } from '../../security/workspaceGuard';
import { getWorkspaceRootsProvider } from '../../security/workspaceRoots';
import { sanitise as sanitiseForLlm } from '../../security/promptSanitiser';
import { logger } from '../../util/logger';
import * as platformFs from '../../platform/fs';
import { getAppState } from '../../platform/appState';

const MAX_OUTPUT_LENGTH = 100_000;

export const readFileTool: ITool = {
        name: 'read_file',
        description: 'Read the contents of a file from the workspace. Returns the file content as a string.',
        inputSchema: {
                type: 'object',
                properties: {
                        path: {
                                type: 'string',
                                description: 'Absolute or workspace-relative path to the file to read.',
                        },
                },
                required: ['path'],
        },
        modifiesFiles: false,
        requiresNetwork: false,
        category: 'file',
};

export const executeReadFile: ToolExecuteFn = async (input) => {
        const filePath = input.path as string;
        if (!filePath) {
                return {
                        success: false,
                        output: 'Missing required parameter: path',
                        truncated: false,
                };
        }

        try {
                assertWithinWorkspace(filePath, getWorkspaceRootsProvider());

                const resolvedPath = resolvePath(filePath);
                const text = await platformFs.readFileText(resolvedPath);

                const truncated = text.length > MAX_OUTPUT_LENGTH;
                const rawOutput = truncated
                        ? text.substring(0, MAX_OUTPUT_LENGTH) + '\n... [truncated]'
                        : text;

                const output = sanitiseForLlm(rawOutput);

                logger.verbose(`[read_file] Read ${resolvedPath} (${text.length} chars${truncated ? ', truncated' : ''})`);

                return {
                        success: true,
                        output,
                        truncated,
                        metadata: { bytesProcessed: text.length },
                };
        } catch (error) {
                return {
                        success: false,
                        output: `Failed to read file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
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

export function registerReadFileTool(registry: IConstructToolRegistry): void {
        registry.registerTool(readFileTool, executeReadFile);
}
