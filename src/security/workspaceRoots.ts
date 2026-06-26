/**
 * workspaceRoots.ts — Layer 4 adapter that exposes VS Code's workspace
 * folders as an IWorkspaceRootsProvider for use with assertWithinWorkspace().
 *
 * WHY THIS EXISTS:
 *   `workspaceGuard.ts` (Layer 1) deliberately does NOT import `vscode` —
 *   it's pure logic, testable in plain Node without the vscode shim. The
 *   `IWorkspaceRootsProvider` interface lets Layer 1 accept workspace roots
 *   without coupling to VS Code.
 *
 *   This file (Layer 4) is the concrete adapter: it wraps
 *   `vscode.workspace.workspaceFolders` and exposes it as an
 *   IWorkspaceRootsProvider. Tool implementations call `getWorkspaceRootsProvider()`
 *   and pass the result to `assertWithinWorkspace()`.
 *
 *   Added in Phase 8-C (multi-root workspace support). Previously the 4
 *   file tools passed `workspaceFolders[0]` as a single string, which
 *   meant paths in the second+ root of a multi-root workspace were
 *   rejected. This adapter lets `assertWithinWorkspace()` see ALL roots
 *   and accept a path that falls inside ANY of them.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route).
 * Security invariants: SEC-4 (path traversal defence, multi-root expansion).
 */

import * as vscode from 'vscode';
import type { IWorkspaceRootsProvider } from './workspaceGuard';

/**
 * Returns an IWorkspaceRootsProvider backed by vscode.workspace.workspaceFolders.
 *
 * The provider is a fresh object on each call (cheap — it's a 1-method closure)
 * so callers don't need to worry about staleness if the workspace changes
 * mid-flight. The underlying `vscode.workspace.workspaceFolders` is read
 * lazily on each `getWorkspaceRoots()` call, so a folder added/removed
 * during a tool execution will be reflected.
 *
 * Use this when calling `assertWithinWorkspace()` from tool implementations.
 */
export function getWorkspaceRootsProvider(): IWorkspaceRootsProvider {
	return {
		getWorkspaceRoots: () =>
			vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
	};
}
