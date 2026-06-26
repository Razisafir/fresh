/**
 * writeFile.ts — Layer 2 built-in tool: write_file.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/tools/constructToolRegistryService.ts` (lines 217-244 schema, 939-1001 impl)
 * Port strategy: PORT WITH TRANSLATION + BEHAVIOR CHANGE.
 *
 * 02_ARCHITECTURE.md §4.3 lists this as a v0.1 built-in tool.
 *
 * CRITICAL BEHAVIOR CHANGE vs old repo:
 *   The old repo's write_file tool wrote DIRECTLY to disk via
 *   `fileService.writeFile(uri, encoded)`. The "USER IN CONTROL" comment
 *   in the old code stated the approval flow was supposed to happen BEFORE
 *   the agent loop called write_file — i.e., the LLM's request would show
 *   a diff, the user would approve, then the agent loop would call
 *   write_file which wrote directly.
 *
 *   This was fragile: any code path that called write_file without first
 *   showing a diff would silently persist changes. The P0-5 fix
 *   (preserved in `src/diff/pendingChangesService.ts`) makes the staging
 *   explicit — write_file ALWAYS routes through `pendingChangesService.stageFile()`,
 *   NEVER writes to disk directly. The user must explicitly call
 *   `pendingChangesService.accept(uri)` (typically via a "Accept" button in
 *   the agent panel UI) before the change lands on disk.
 *
 *   This is the foundation of the Plan→Approve→Execute→Verify workflow.
 *
 * Translation notes:
 *   - `IFileService.writeFile` → never called here. The tool delegates to
 *     `pendingChangesService.stageFile()`.
 *   - `assertWithinWorkspace(path, workspaceRoot)` uses our multi-root-aware
 *     signature (R1 fix preserved).
 *   - `mode: 'overwrite' | 'append' | 'create_only'` is preserved. For
 *     'append', the existing file content is read first and prepended.
 *     For 'create_only', if the file exists, an error is returned.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route),
 * P0-5 fix (no direct disk writes from agent loop), SEC-4 (path traversal).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { ITool, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { assertWithinWorkspace } from '../../security/workspaceGuard';
import { pendingChangesService } from '../../diff/pendingChangesService';
import { logger } from '../../util/logger';

/**
 * Tool definition for write_file.
 */
export const writeFileTool: ITool = {
        name: 'write_file',
        description: 'Write content to a file. Stages the change for user review (diff preview) — does NOT write to disk until the user accepts. Creates the file if it does not exist.',
        inputSchema: {
                type: 'object',
                properties: {
                        path: {
                                type: 'string',
                                description: 'Absolute or workspace-relative path to the file to write.',
                        },
                        content: {
                                type: 'string',
                                description: 'The content to write to the file.',
                        },
                        mode: {
                                type: 'string',
                                description: 'Write mode: "overwrite" replaces the file, "append" adds to the end, "create_only" fails if the file already exists.',
                                enum: ['overwrite', 'append', 'create_only'],
                                default: 'overwrite',
                        },
                },
                required: ['path', 'content'],
        },
        modifiesFiles: true,
        requiresNetwork: false,
        category: 'file',
};

/**
 * Execute function for write_file.
 *
 * Stages the file change via `pendingChangesService.stageFile()`. The
 * user reviews the diff in the agent panel UI and accepts/rejects. Only
 * on accept does the change land on disk.
 *
 * For 'append' mode, the existing file content (if any) is read first and
 * prepended to the new content before staging. For 'create_only' mode, if
 * the file already exists, an error is returned without staging.
 */
export const executeWriteFile: ToolExecuteFn = async (input) => {
        const filePath = input.path as string;
        const content = input.content as string;
        const mode = (input.mode as string) ?? 'overwrite';

        if (!filePath || content === undefined) {
                return {
                        success: false,
                        output: 'Missing required parameters: path and content',
                        truncated: false,
                };
        }

        try {
                // SEC-4: Path traversal prevention
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (root) {
                        assertWithinWorkspace(filePath, root);
                }

                const uri = resolveUri(filePath);

                // Handle 'create_only' mode: if file exists, refuse.
                if (mode === 'create_only') {
                        try {
                                await vscode.workspace.fs.stat(uri);
                                return {
                                        success: false,
                                        output: `File already exists: ${filePath}. Use mode "overwrite" or "append" instead.`,
                                        truncated: false,
                                };
                        } catch {
                                // File doesn't exist — proceed with staging.
                        }
                }

                // Handle 'append' mode: read existing content, prepend.
                let contentToStage = content;
                if (mode === 'append') {
                        try {
                                const bytes = await vscode.workspace.fs.readFile(uri);
                                const existingText = Buffer.from(bytes).toString('utf8');
                                contentToStage = existingText + content;
                        } catch {
                                // File doesn't exist yet — stage as a new file.
                        }
                }

                // P0-5: Stage the change. NEVER write directly to disk.
                // The user must accept the change in the agent panel UI before
                // it lands on disk.
                await pendingChangesService.stageFile(uri, contentToStage);

                logger.verbose(`[write_file] Staged ${uri.fsPath} (${contentToStage.length} chars, mode: ${mode})`);

                return {
                        success: true,
                        output: `File change staged: ${filePath} (${contentToStage.length} bytes, mode: ${mode}). Review and accept/reject in the diff view.`,
                        truncated: false,
                        metadata: { bytesProcessed: contentToStage.length },
                };
        } catch (error) {
                return {
                        success: false,
                        output: `Failed to stage file change "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
                        truncated: false,
                };
        }
};

/**
 * Resolve a path string to a vscode.Uri (relative paths resolved against
 * first workspace folder).
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
 * Register the write_file tool with the given registry.
 */
export function registerWriteFileTool(registry: IConstructToolRegistry): void {
        registry.registerTool(writeFileTool, executeWriteFile);
}
