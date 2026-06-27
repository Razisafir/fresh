/**
 * fs.ts — Thin wrapper around Node.js fs/promises that replaces
 * vscode.workspace.fs for the Electron standalone app.
 *
 * All functions use plain string paths instead of vscode.Uri.
 * This is the platform layer that built-in tools and services call
 * instead of `vscode.workspace.fs.readFile/writeFile/stat/...`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * Read a file and return its content as a Uint8Array.
 * Equivalent to vscode.workspace.fs.readFile(uri).
 */
export async function readFile(filePath: string): Promise<Uint8Array> {
	return fs.readFile(filePath);
}

/**
 * Read a file and return its content as a UTF-8 string.
 * Convenience method — most callers want text, not bytes.
 */
export async function readFileText(filePath: string): Promise<string> {
	return fs.readFile(filePath, 'utf8');
}

/**
 * Write content to a file, creating parent directories as needed.
 * Equivalent to vscode.workspace.fs.writeFile(uri, content).
 */
export async function writeFile(filePath: string, content: Uint8Array | string): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	if (typeof content === 'string') {
		await fs.writeFile(filePath, content, 'utf8');
	} else {
		await fs.writeFile(filePath, content);
	}
}

/**
 * Stat a file/directory. Returns basic info.
 * Equivalent to vscode.workspace.fs.stat(uri).
 */
export async function stat(filePath: string): Promise<{ type: 'file' | 'directory'; size: number; mtime: number }> {
	const stats = await fs.stat(filePath);
	return {
		type: stats.isDirectory() ? 'directory' : 'file',
		size: stats.size,
		mtime: stats.mtimeMs,
	};
}

/**
 * Check if a file or directory exists.
 */
export async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * List the contents of a directory.
 * Equivalent to vscode.workspace.fs.readDirectory(uri).
 * Returns [name, type] tuples where type is 'file' or 'directory'.
 */
export async function listDirectory(dirPath: string): Promise<Array<[string, 'file' | 'directory']>> {
	const entries = await fs.readdir(dirPath, { withFileTypes: true });
	return entries.map(entry => [
		entry.name,
		(entry.isDirectory() ? 'directory' : 'file') as 'file' | 'directory',
	]);
}

/**
 * Create a directory (and any parent directories) if it doesn't exist.
 * Equivalent to vscode.workspace.fs.createDirectory(uri).
 */
export async function createDirectory(dirPath: string): Promise<void> {
	await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Delete a file or directory.
 * Equivalent to vscode.workspace.fs.delete(uri, opts).
 */
export async function deletePath(filePath: string, options?: { recursive?: boolean }): Promise<void> {
	await fs.rm(filePath, { recursive: options?.recursive ?? false, force: true });
}

/**
 * Join path segments.
 * Replaces vscode.Uri.joinPath(uri, ...segments).fsPath.
 */
export function joinPath(base: string, ...segments: string[]): string {
	return path.join(base, ...segments);
}
