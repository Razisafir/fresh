/**
 * pendingChanges.ts — Layer 1 type definitions for the pending-changes service.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/diff/pendingChanges.ts` (101L)
 * Port strategy: VERBATIM (interface + types only). The concrete implementation
 * lives in `src/diff/pendingChangesService.ts` (Layer 2, ported in a later
 * Phase 3 round).
 *
 * 02_ARCHITECTURE.md §6 mapping table lists this as Layer 1 port-verbatim.
 *
 * Translation notes:
 *   - `createDecorator<IPendingChangesService>(...)` removed (no DI container).
 *   - `_serviceBrand: undefined` field removed from interface (VS Code DI marker).
 *   - `URI` import changed from VS Code's internal `base/common/uri.js` to
 *     `vscode.Uri` (same shape, exposed by the public extension API).
 *   - `Event<T>` imported from `vscode` instead of VS Code's internal
 *     `base/common/event.js`.
 *
 * The pending-changes service is the P0-5 fix from the old repo: the agent
 * loop no longer writes directly to disk. All changes are staged in memory,
 * and the user must explicitly accept before the change is persisted via
 * the VS Code file system API. This mirrors VS Code's chatEditing modified-
 * file entry pattern.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route).
 */

import type { Event, Uri } from 'vscode';

/**
 * A single pending change entry staged by the agent.
 * The change exists in memory only — disk is not modified until accept().
 */
export interface PendingChangeEntry {
	/** URI of the file being changed. */
	readonly uri: Uri;
	/** The file content BEFORE the agent's change (captured at staging time). */
	readonly originalContent: string;
	/** The content the agent proposes (new file content or patched content). */
	readonly proposedContent: string;
	/** Whether this is a new file creation (no original content on disk). */
	readonly isNewFile: boolean;
	/** Whether the user has accepted or rejected this change. undefined = pending. */
	accepted?: boolean;
}

/**
 * Service for staging agent-proposed file changes in memory.
 *
 * P0-5 FIX (preserved from old repo): The agent loop no longer writes
 * directly to disk. All changes are staged here, and the user must
 * explicitly accept before the change is persisted to disk via the
 * VS Code file system API (`vscode.workspace.fs`).
 *
 * This mirrors VS Code's chatEditingModifiedFileEntry pattern where
 * edits are applied to in-memory ITextModel instances with a docSnapshot
 * for the original content.
 *
 * The concrete implementation lives in `src/diff/pendingChangesService.ts`
 * (Layer 2, ported in a later Phase 3 round).
 */
export interface IPendingChangesService {
	/** Event fired when pending changes are added, accepted, or rejected. */
	readonly onDidChangePendingChanges: Event<void>;

	/** Current list of pending changes (not yet accepted or rejected). */
	readonly pendingEntries: ReadonlyArray<PendingChangeEntry>;

	/**
	 * Stage a new file creation or full file replacement.
	 * Captures the original file content BEFORE staging.
	 * Does NOT write to disk — the change is in memory only.
	 */
	stageFile(uri: Uri, proposedContent: string): Promise<void>;

	/**
	 * Stage an edit (diff) to an existing file.
	 * The diff is applied to the current file content in memory.
	 * Does NOT write to disk.
	 */
	stageEdit(uri: Uri, diff: string): Promise<void>;

	/**
	 * Accept a pending change — writes the proposed content to disk.
	 */
	accept(uri: Uri): Promise<void>;

	/**
	 * Reject a pending change — discards the in-memory proposal.
	 * If this was a new file that doesn't exist on disk, nothing happens.
	 * If the file existed before, the disk remains unchanged.
	 */
	reject(uri: Uri): Promise<void>;

	/**
	 * Accept ALL pending changes.
	 */
	acceptAll(): Promise<void>;

	/**
	 * Reject ALL pending changes.
	 */
	rejectAll(): Promise<void>;

	/**
	 * Get the original content for a URI (before the agent's change).
	 */
	getOriginalContent(uri: Uri): string | undefined;

	/**
	 * Get the proposed content for a URI (the agent's change).
	 */
	getProposedContent(uri: Uri): string | undefined;

	/**
	 * Check if there are any pending changes.
	 */
	hasPendingChanges(): boolean;
}
