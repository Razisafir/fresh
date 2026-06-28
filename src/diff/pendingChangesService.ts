/**
 * pendingChangesService.ts — Layer 2 concrete implementation of
 * IPendingChangesService.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.Disposable → custom Disposable interface
 *   - vscode.EventEmitter → local EventEmitter
 *   - vscode.Uri → SimpleUri from platform/uris.ts
 *   - vscode.workspace.fs → platform/fs.ts
 *
 * P0-5 fix preserved: NEVER writes to disk during staging.
 */

import * as path from 'path';
import * as platformFs from '../platform/fs';
import type { SimpleUri } from '../platform/uris';
import { logger } from '../util/logger';
import {
        IPendingChangesService,
        PendingChangeEntry,
} from './pendingChanges';

// ---------------------------------------------------------------------------
// Minimal Disposable + EventEmitter (replaces vscode.*)
// ---------------------------------------------------------------------------

interface Disposable {
        dispose(): void;
}

class EventEmitter<T> {
        private listeners: Array<(data: T) => void> = [];

        get event(): (listener: (data: T) => void) => { dispose(): void } {
                return (listener: (data: T) => void) => {
                        this.listeners.push(listener);
                        return {
                                dispose: () => {
                                        const idx = this.listeners.indexOf(listener);
                                        if (idx >= 0) { this.listeners.splice(idx, 1); }
                                },
                        };
                };
        }

        fire(data: T): void {
                for (const listener of [...this.listeners]) {
                        try { listener(data); } catch {
                                // Swallow errors in listeners.
                        }
                }
        }

        dispose(): void {
                this.listeners = [];
        }
}

// ---------------------------------------------------------------------------
// PendingChangesService
// ---------------------------------------------------------------------------

export class PendingChangesService implements IPendingChangesService, Disposable {

        private readonly _entries = new Map<string, PendingChangeEntry>();
        private readonly _onDidChangePendingChanges = new EventEmitter<void>();
        readonly onDidChangePendingChanges = this._onDidChangePendingChanges.event;

        constructor() {
                logger.info('[PendingChanges] Service created');
        }

        get pendingEntries(): ReadonlyArray<PendingChangeEntry> {
                // After accept(), entries are deleted from the map entirely.
                // After reject(), entries are also deleted.
                // So all remaining entries are truly pending. We keep the
                // accepted filter as a safety net in case legacy entries
                // with accepted=true exist from a prior version.
                return Array.from(this._entries.values()).filter(e => e.accepted === undefined);
        }

        hasPendingChanges(): boolean {
                return this.pendingEntries.length > 0;
        }

        async stageFile(uri: SimpleUri, proposedContent: string): Promise<void> {
                const key = uri.toString();

                // 1. Read current file content BEFORE any modification.
                let originalContent = '';
                let isNewFile = false;
                try {
                        originalContent = await platformFs.readFileText(uri.fsPath);
                } catch {
                        // File doesn't exist yet — this is a new file creation.
                        isNewFile = true;
                }

                // 2. If there's already a pending entry for this URI, update it
                //    while preserving the REAL original (not the intermediate proposal).
                const existing = this._entries.get(key);
                if (existing) {
                        this._entries.set(key, {
                                uri,
                                originalContent: existing.originalContent,
                                proposedContent,
                                isNewFile: existing.isNewFile,
                                accepted: undefined,
                        });
                } else {
                        this._entries.set(key, {
                                uri,
                                originalContent,
                                proposedContent,
                                isNewFile,
                                accepted: undefined,
                        });
                }

                logger.info(`[PendingChanges] Staged file: ${uri.fsPath} (new: ${isNewFile}, ${proposedContent.length} chars)`);
                this._onDidChangePendingChanges.fire();
        }

        async stageEdit(uri: SimpleUri, diff: string): Promise<void> {
                const key = uri.toString();

                let originalContent = '';
                let isNewFile = false;
                try {
                        const existing = this._entries.get(key);
                        if (existing) {
                                originalContent = existing.originalContent;
                                isNewFile = existing.isNewFile;
                        } else {
                                originalContent = await platformFs.readFileText(uri.fsPath);
                        }
                } catch {
                        isNewFile = true;
                }

                this._entries.set(key, {
                        uri,
                        originalContent,
                        proposedContent: diff,
                        isNewFile,
                        accepted: undefined,
                });

                logger.info(`[PendingChanges] Staged edit: ${uri.fsPath} (${diff.length} chars diff)`);
                this._onDidChangePendingChanges.fire();
        }

        async accept(uri: SimpleUri): Promise<void> {
                const key = uri.toString();
                const entry = this._entries.get(key);
                if (!entry) {
                        logger.warn(`[PendingChanges] No pending change for: ${uri.fsPath}`);
                        return;
                }

                if (entry.accepted !== undefined) {
                        logger.warn(`[PendingChanges] Entry already resolved (accepted=${entry.accepted}): ${uri.fsPath}`);
                        return;
                }

                try {
                        // Ensure parent directory exists.
                        const parent = path.dirname(uri.fsPath);
                        await platformFs.createDirectory(parent);

                        await platformFs.writeFile(uri.fsPath, entry.proposedContent);

                        // Remove from the map entirely — the change is no longer
                        // pending, it's on disk. This ensures pendingEntries always
                        // reflects only truly unresolved entries, and the UI counter
                        // correctly drops to 0 after acceptance.
                        this._entries.delete(key);
                        logger.info(`[PendingChanges] Accepted and written to disk: ${uri.fsPath}`);
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        logger.error(`[PendingChanges] Failed to write accepted change: ${msg}`);
                        throw error;
                }

                this._onDidChangePendingChanges.fire();
        }

        async reject(uri: SimpleUri): Promise<void> {
                const key = uri.toString();
                const entry = this._entries.get(key);
                if (!entry) {
                        logger.warn(`[PendingChanges] No pending change for: ${uri.fsPath}`);
                        return;
                }

                if (entry.isNewFile) {
                        try {
                                const exists = await platformFs.exists(uri.fsPath);
                                if (exists) {
                                        await platformFs.deletePath(uri.fsPath);
                                        logger.info(`[PendingChanges] Rejected new file, deleted from disk: ${uri.fsPath}`);
                                }
                        } catch {
                                // File doesn't exist on disk — nothing to clean up.
                        }
                }

                this._entries.delete(key);
                logger.info(`[PendingChanges] Rejected: ${uri.fsPath}`);
                this._onDidChangePendingChanges.fire();
        }

        async acceptAll(): Promise<void> {
                const pending = this.pendingEntries;
                logger.info(`[PendingChanges] Accepting all ${pending.length} changes`);
                for (const entry of pending) {
                        await this.accept(entry.uri);
                }
        }

        async rejectAll(): Promise<void> {
                const pending = [...this.pendingEntries];
                logger.info(`[PendingChanges] Rejecting all ${pending.length} changes`);
                for (const entry of pending) {
                        await this.reject(entry.uri);
                }
        }

        getOriginalContent(uri: SimpleUri): string | undefined {
                return this._entries.get(uri.toString())?.originalContent;
        }

        getProposedContent(uri: SimpleUri): string | undefined {
                return this._entries.get(uri.toString())?.proposedContent;
        }

        dispose(): void {
                this._entries.clear();
                this._onDidChangePendingChanges.dispose();
        }
}

/**
 * Singleton instance.
 */
export const pendingChangesService = new PendingChangesService();
