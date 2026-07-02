/**
 * createDirectory.ts — Layer 2 built-in tool: create_directory.
 *
 * Re-added from old repo (was dropped in v0.1 but write_file's auto-mkdir
 * only covers parent dirs, not explicit directory creation). Useful for
 * scaffold tasks where the agent needs to create empty directory trees.
 *
 * Phase 0 pivot (D-015): uses platformFs.createDirectory instead of
 * vscode.workspace.fs.createDirectory.
 *
 * Security invariants preserved:
 *   - SEC-4: assertWithinWorkspace enforces workspace boundary
 *   - P0-2: path traversal blocked by workspace guard
 */

import * as path from 'path';
import type { ITool, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { assertWithinWorkspace } from '../../security/workspaceGuard';
import { getWorkspaceRootsProvider } from '../../security/workspaceRoots';
import { logger } from '../../util/logger';
import * as platformFs from '../../platform/fs';

export const createDirectoryTool: ITool = {
        name: 'create_directory',
        description:
                'Create a directory at the specified path, including any necessary parent directories. ' +
                'Use this when you need to create an empty directory tree or ensure a directory exists before writing files into it.',
        inputSchema: {
                type: 'object',
                properties: {
                        path: {
                                type: 'string',
                                description: 'Absolute or workspace-relative path of the directory to create.',
                        },
                },
                required: ['path'],
        },
        modifiesFiles: true,
        requiresNetwork: false,
        category: 'file',
};

/**
 * Execute the create_directory tool.
 *
 * Creates the directory (and parents). Returns a confirmation message on
 * success or an error on failure.
 */
export const executeCreateDirectory: ToolExecuteFn = async (input: Record<string, unknown>) => {
        const rawPath = input.path as string;

        if (!rawPath || typeof rawPath !== 'string') {
                return { success: false, output: 'path is required and must be a string.', truncated: false };
        }

        // Resolve workspace-relative path to absolute
        const roots = getWorkspaceRootsProvider().getWorkspaceRoots();
        const workspaceRoot = roots.length > 0 ? roots[0] : process.cwd();
        const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.join(workspaceRoot, rawPath);

        // SEC-4: assert within workspace (pass workspace roots provider like all other tools)
        try {
                assertWithinWorkspace(absolutePath, getWorkspaceRootsProvider());
        } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`[create_directory] Workspace guard rejected: ${msg}`);
                return { success: false, output: `Path is outside the workspace: ${rawPath}`, truncated: false };
        }

        try {
                await platformFs.createDirectory(absolutePath);
                logger.info(`[create_directory] Created: ${absolutePath}`);
                const relPath = path.relative(workspaceRoot, absolutePath) || absolutePath;
                return {
                        success: true,
                        output: `Directory created: ${relPath}`,
                        truncated: false,
                };
        } catch (err: unknown) {
                // If directory already exists, that's not an error
                if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST') {
                        logger.info(`[create_directory] Already exists: ${absolutePath}`);
                        const relPath = path.relative(workspaceRoot, absolutePath) || absolutePath;
                        return {
                                success: true,
                                output: `Directory already exists: ${relPath}`,
                                truncated: false,
                        };
                }
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`[create_directory] Failed: ${msg}`);
                return { success: false, output: `Failed to create directory: ${msg}`, truncated: false };
        }
};

/**
 * Register the create_directory tool with the given registry.
 */
export function registerCreateDirectoryTool(registry: IConstructToolRegistry): void {
        registry.registerTool(createDirectoryTool, executeCreateDirectory);
}
