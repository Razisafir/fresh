/**
 * editFile.ts — Layer 2 built-in tool: edit_file.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.Uri.file → Uri.file from platform/uris.ts
 *   - vscode.workspace.workspaceFolders → getAppState().workspaceRoots.roots
 *
 * P0-5 fix preserved: ALWAYS routes through pendingChangesService.
 */

import * as path from 'path';
import type { ITool, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { assertWithinWorkspace } from '../../security/workspaceGuard';
import { getWorkspaceRootsProvider } from '../../security/workspaceRoots';
import { pendingChangesService } from '../../diff/pendingChangesService';
import { logger } from '../../util/logger';
import { Uri } from '../../platform/uris';
import { getAppState } from '../../platform/appState';

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
				description: 'The full new content of the file (v0.1 — the diff is applied as a full-content replacement at accept time).',
			},
		},
		required: ['path', 'diff'],
	},
	modifiesFiles: true,
	requiresNetwork: false,
	category: 'file',
};

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
		assertWithinWorkspace(filePath, getWorkspaceRootsProvider());

		const uri = Uri.file(resolvePath(filePath));

		// P0-5: Stage the edit. NEVER write directly to disk.
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

function resolvePath(filePath: string): string {
	if (!path.isAbsolute(filePath) && !filePath.match(/^[A-Z]:\\/i)) {
		const root = getAppState().workspaceRoots.roots[0];
		if (root) {
			return path.join(root, filePath);
		}
	}
	return filePath;
}

export function registerEditFileTool(registry: IConstructToolRegistry): void {
	registry.registerTool(editFileTool, executeEditFile);
}
