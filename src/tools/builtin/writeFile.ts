/**
 * writeFile.ts — Layer 2 built-in tool: write_file.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.workspace.fs.stat → platformFs.exists
 *   - vscode.workspace.fs.readFile → platformFs.readFileText
 *   - vscode.Uri.file → Uri.file from platform/uris.ts
 *
 * P0-5 fix preserved: ALWAYS routes through pendingChangesService.
 */

import * as path from 'path';
import type { ITool, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import { assertWithinWorkspace } from '../../security/workspaceGuard';
import { getWorkspaceRootsProvider } from '../../security/workspaceRoots';
import { pendingChangesService } from '../../diff/pendingChangesService';
import { logger } from '../../util/logger';
import * as platformFs from '../../platform/fs';
import { Uri } from '../../platform/uris';
import { getAppState } from '../../platform/appState';

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
		assertWithinWorkspace(filePath, getWorkspaceRootsProvider());

		const uri = Uri.file(resolvePath(filePath));

		// Handle 'create_only' mode: if file exists, refuse.
		if (mode === 'create_only') {
			try {
				const exists = await platformFs.exists(uri.fsPath);
				if (exists) {
					return {
						success: false,
						output: `File already exists: ${filePath}. Use mode "overwrite" or "append" instead.`,
						truncated: false,
					};
				}
			} catch {
				// File doesn't exist — proceed with staging.
			}
		}

		// Handle 'append' mode: read existing content, prepend.
		let contentToStage = content;
		if (mode === 'append') {
			try {
				const existingText = await platformFs.readFileText(uri.fsPath);
				contentToStage = existingText + content;
			} catch {
				// File doesn't exist yet — stage as a new file.
			}
		}

		// P0-5: Stage the change. NEVER write directly to disk.
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

function resolvePath(filePath: string): string {
	if (!path.isAbsolute(filePath) && !filePath.match(/^[A-Z]:\\/i)) {
		const root = getAppState().workspaceRoots.roots[0];
		if (root) {
			return path.join(root, filePath);
		}
	}
	return filePath;
}

export function registerWriteFileTool(registry: IConstructToolRegistry): void {
	registry.registerTool(writeFileTool, executeWriteFile);
}
