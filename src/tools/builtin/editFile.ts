/**
 * editFile.ts — Layer 2 built-in tool: edit_file.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/tools/constructToolRegistryService.ts` (lines 361-382 schema, 1667-1699 impl)
 * Port strategy: PORT WITH TRANSLATION.
 *
 * 02_ARCHITECTURE.md §4.3 lists this as a v0.1 built-in tool.
 *
 * What this tool does (preserved from old repo):
 *   - Stages a unified-diff edit to a file via `pendingChangesService.stageEdit()`.
 *   - Does NOT apply the diff to disk — the user must accept the change in
 *     the agent panel UI before it lands.
 *   - The actual diff application (parsing + applying hunks to produce final
 *     file content) is done at accept time by the (future) DiffApplierService.
 *     For v0.1, `pendingChangesService.accept()` treats the proposedContent
 *     as final content — so v0.1 edit_file callers should pass the FULL new
 *     file content as the "diff" parameter, not a unified diff. The v1.0
 *     DiffApplierService will add proper unified-diff parsing.
 *
 *     To make this clear to the LLM, the v0.1 schema description says the
 *     diff parameter is "the full new file content (v0.1) or a unified diff
 *     (v1.0+)". The LLM is instructed via the system prompt to send the
 *     full new content for now.
 *
 * Translation notes:
 *   - `assertWithinWorkspace(path, workspaceRoot)` uses our multi-root-aware
 *     signature.
 *   - `pendingChanges.stageEdit(uri, diff)` →
 *     `pendingChangesService.stageEdit(uri, diff)` (singleton accessor).
 *
 * P0-5 fix preserved: edit_file ALWAYS stages, NEVER writes to disk directly.
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
 * Tool definition for edit_file.
 */
export const editFileTool: ITool = {
        name: 'edit_file',
        description: 'Edit an existing file by replacing its content. The change is staged for user review before applying — does NOT write to disk until the user accepts.',
        inputSchema: {
                type: 'object',
                properties: {
                        path: {
                                type: 'string',
                                description: 'Absolute or workspace-relative path to the file to edit.',
                        },
                        diff: {
                                type: 'string',
                                description: 'The full new content of the file (v0.1 — the diff is applied as a full-content replacement at accept time). In v1.0+, this will accept unified diffs.',
                        },
                },
                required: ['path', 'diff'],
        },
        modifiesFiles: true,
        requiresNetwork: false,
        category: 'file',
};

/**
 * Execute function for edit_file.
 */
export const executeEditFile: ToolExecuteFn = async (input) => {
        const filePath = input.path as string;
        const diff = input.diff as string;

        if (!filePath || !diff) {
                return {
                        success: false,
                        output: 'Missing required parameters: path and diff',
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

                // P0-5: Stage the edit. NEVER write directly to disk.
                // The user reviews the diff in the agent panel UI and accepts/rejects.
                await pendingChangesService.stageEdit(uri, diff);

                logger.verbose(`[edit_file] Staged edit for ${uri.fsPath} (${diff.length} chars)`);

                return {
                        success: true,
                        output: `Edit staged: ${filePath}. Review and accept/reject in the diff view.`,
                        truncated: false,
                };
        } catch (error) {
                return {
                        success: false,
                        output: `Failed to stage edit for "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
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
 * Register the edit_file tool with the given registry.
 */
export function registerEditFileTool(registry: IConstructToolRegistry): void {
        registry.registerTool(editFileTool, executeEditFile);
}
