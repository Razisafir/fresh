/**
 * pendingChanges.ts — Layer 1 type definitions for the pending-changes service.
 *
 * Phase 0 pivot (D-015): removed `import type { Event, Uri } from 'vscode'`.
 * The `Event` type is now imported from llm.ts (defined locally).
 * The `Uri` type is replaced by a simple Uri interface from platform/uris.ts.
 */

import type { Event } from '../types/llm';
import type { SimpleUri } from '../platform/uris';

// Re-export SimpleUri as Uri for backwards compatibility in this file.
export type Uri = SimpleUri;

// ---------------------------------------------------------------------------
// Pending change entry
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// IPendingChangesService
// ---------------------------------------------------------------------------

/**
 * Service for staging agent-proposed file changes in memory.
 *
 * P0-5 FIX: The agent loop never writes directly to disk.
 * All changes are staged here, and the user must explicitly accept
 * before the change is persisted.
 */
export interface IPendingChangesService {
        /** Event fired when pending changes are added, accepted, or rejected. */
        readonly onDidChangePendingChanges: Event<void>;

        /** Current list of pending changes (not yet accepted or rejected). */
        readonly pendingEntries: ReadonlyArray<PendingChangeEntry>;

        /**
         * Stage a new file creation or full file replacement.
         * Does NOT write to disk — the change is in memory only.
         */
        stageFile(uri: Uri, proposedContent: string): Promise<void>;

        /**
         * Stage an edit (diff) to an existing file.
         * Does NOT write to disk.
         */
        stageEdit(uri: Uri, diff: string): Promise<void>;

        /**
         * Accept a pending change — writes the proposed content to disk.
         */
        accept(uri: Uri): Promise<void>;

        /**
         * Reject a pending change — discards the in-memory proposal.
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
