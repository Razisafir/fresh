/**
 * workspaceRoots.ts — Platform adapter that exposes workspace folders
 * as an IWorkspaceRootsProvider for use with assertWithinWorkspace().
 *
 * Phase 0 pivot (D-015): now reads from getAppState().workspaceRoots
 * instead of vscode.workspace.workspaceFolders. The interface is unchanged
 * — workspaceGuard.ts (Layer 1) still uses IWorkspaceRootsProvider and
 * is not coupled to any platform.
 */

import { getAppState } from '../platform/appState';
import type { IWorkspaceRootsProvider } from './workspaceGuard';

/**
 * Returns an IWorkspaceRootsProvider backed by getAppState().workspaceRoots.
 *
 * The provider is a fresh object on each call (cheap — it's a 1-method closure)
 * so callers don't need to worry about staleness. The underlying
 * getAppState().workspaceRoots.roots is read lazily on each
 * getWorkspaceRoots() call.
 *
 * Use this when calling assertWithinWorkspace() from tool implementations.
 */
export function getWorkspaceRootsProvider(): IWorkspaceRootsProvider {
	return {
		getWorkspaceRoots: () =>
			getAppState().workspaceRoots.roots as readonly string[],
	};
}
