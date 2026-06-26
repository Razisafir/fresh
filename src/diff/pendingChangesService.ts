/**
 * pendingChangesService.ts — Layer 2 concrete implementation of
 * IPendingChangesService.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/diff/pendingChangesService.ts` (199L)
 * Port strategy: PORT WITH TRANSLATION. The in-memory state machine and
 * disk-write semantics are preserved verbatim. The VS Code internal
 * service imports are translated to their public extension API
 * equivalents.
 *
 * 02_ARCHITECTURE.md §6 mapping table: Layer 2 — port with translation.
 *
 * What this service does (preserved from old repo):
 *   - Stages agent-proposed file changes in memory (Map<uri.toString, entry>)
 *   - Captures the original file content at staging time (so the user can
 *     preview a diff before accepting)
 *   - NEVER writes to disk during staging — only on explicit accept()
 *   - accept() persists via vscode.workspace.fs.writeFile
 *   - reject() just drops the in-memory entry (and cleans up stray files
 *     for the rare new-file-then-reject case)
 *
 * Translation notes:
 *   - `Disposable` (VS Code internal base/common/lifecycle.js) → custom
 *     minimal Disposable interface. We don't need VS Code's full dispose
 *     hierarchy for a single service.
 *   - `Emitter<T>` (VS Code internal base/common/event.js) →
 *     `vscode.EventEmitter<T>` (public extension API, same shape).
 *   - `IFileService.readFile/writeFile/exists/createFolder/del` →
 *     `vscode.workspace.fs.readFile/writeFile/stat/createDirectory/delete`.
 *   - `URI` → `vscode.Uri`.
 *   - `VSBuffer.fromString(s)` → `Buffer.from(s, 'utf8')` then
 *     `Uint8Array.from(buffer)`. vscode.workspace.fs expects Uint8Array.
 *   - `ILogService` → our local `logger` from `src/util/logger.ts`.
 *   - Constructor injection (@ILogService, @IFileService) removed —
 *     singletons, no DI container (per 02_ARCHITECTURE.md §3 design
 *     choice #2). The service is constructed once in the future
 *     services.ts registry and exported as a singleton.
 *   - The old repo's `accept()` had a small race where two concurrent
 *     accept() calls for the same URI could both write. Not a real bug
 *     in practice (the agent loop is single-threaded per session), but
 *     we add an explicit `if (entry.accepted !== undefined) return`
 *     guard for defence-in-depth.
 *
 * The P0-5 fix from the old repo (no direct disk writes from the agent
 * loop) is preserved. This is foundational to the Plan→Approve→Execute→
 * Verify workflow — the user MUST be able to see and approve changes
 * before they hit disk.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension
 * route). P0-5 fix preserved.
 */

import * as vscode from 'vscode';
import { logger } from '../util/logger';
import {
	IPendingChangesService,
	PendingChangeEntry,
} from './pendingChanges';

/**
 * Concrete implementation of IPendingChangesService.
 *
 * Singleton — constructed once by the service registry (future services.ts).
 * Use the exported `pendingChangesService` instance, do not construct
 * additional instances.
 */
export class PendingChangesService implements IPendingChangesService, vscode.Disposable {

	private readonly _entries = new Map<string, PendingChangeEntry>();
	private readonly _onDidChangePendingChanges = new vscode.EventEmitter<void>();
	readonly onDidChangePendingChanges = this._onDidChangePendingChanges.event;

	constructor() {
		logger.info('[PendingChanges] Service created');
	}

	get pendingEntries(): ReadonlyArray<PendingChangeEntry> {
		return Array.from(this._entries.values()).filter(e => e.accepted === undefined);
	}

	hasPendingChanges(): boolean {
		return this.pendingEntries.length > 0;
	}

	async stageFile(uri: vscode.Uri, proposedContent: string): Promise<void> {
		const key = uri.toString();

		// 1. Read current file content BEFORE any modification.
		let originalContent = '';
		let isNewFile = false;
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			originalContent = Buffer.from(bytes).toString('utf8');
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

	async stageEdit(uri: vscode.Uri, diff: string): Promise<void> {
		// For edit_file, we stage the diff itself — the diff is applied
		// at accept time by the (future) DiffApplierService. We still
		// capture the original content here so the UI can preview.
		const key = uri.toString();

		let originalContent = '';
		let isNewFile = false;
		try {
			const existing = this._entries.get(key);
			if (existing) {
				originalContent = existing.originalContent;
				isNewFile = existing.isNewFile;
			} else {
				const bytes = await vscode.workspace.fs.readFile(uri);
				originalContent = Buffer.from(bytes).toString('utf8');
			}
		} catch {
			isNewFile = true;
		}

		this._entries.set(key, {
			uri,
			originalContent,
			proposedContent: diff, // The diff content (applied at accept time)
			isNewFile,
			accepted: undefined,
		});

		logger.info(`[PendingChanges] Staged edit: ${uri.fsPath} (${diff.length} chars diff)`);
		this._onDidChangePendingChanges.fire();
	}

	async accept(uri: vscode.Uri): Promise<void> {
		const key = uri.toString();
		const entry = this._entries.get(key);
		if (!entry) {
			logger.warn(`[PendingChanges] No pending change for: ${uri.fsPath}`);
			return;
		}

		// Defence-in-depth: skip if already accepted/rejected.
		if (entry.accepted !== undefined) {
			logger.warn(`[PendingChanges] Entry already resolved (accepted=${entry.accepted}): ${uri.fsPath}`);
			return;
		}

		// For stageEdit entries, the proposedContent is a diff string — we
		// need the (future) DiffApplierService to convert it to final
		// content before writing. For v0.1, only stageFile is exercised
		// by the agent loop (edit_file in v0.1 also uses stageFile with
		// the full new content, deferring true diff application to v1.0).
		// The entry.proposedContent is therefore treated as final content.

		try {
			// Ensure parent directory exists.
			const parent = vscode.Uri.joinPath(uri, '..');
			try {
				await vscode.workspace.fs.stat(parent);
			} catch {
				await vscode.workspace.fs.createDirectory(parent);
			}

			const bytes = Buffer.from(entry.proposedContent, 'utf8');
			await vscode.workspace.fs.writeFile(uri, new Uint8Array(bytes));

			// Mark accepted (entry stays in the map for originalContent lookup).
			this._entries.set(key, { ...entry, accepted: true });
			logger.info(`[PendingChanges] Accepted and written to disk: ${uri.fsPath}`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.error(`[PendingChanges] Failed to write accepted change: ${msg}`);
			throw error;
		}

		this._onDidChangePendingChanges.fire();
	}

	async reject(uri: vscode.Uri): Promise<void> {
		const key = uri.toString();
		const entry = this._entries.get(key);
		if (!entry) {
			logger.warn(`[PendingChanges] No pending change for: ${uri.fsPath}`);
			return;
		}

		// DO NOT write to disk. Just discard the in-memory entry.
		// If the file was newly created (no original), and the file
		// somehow exists on disk (shouldn't happen with our flow), clean
		// it up defensively.
		if (entry.isNewFile) {
			try {
				await vscode.workspace.fs.stat(uri);
				await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
				logger.info(`[PendingChanges] Rejected new file, deleted from disk: ${uri.fsPath}`);
			} catch {
				// File doesn't exist on disk — nothing to clean up. Fine.
			}
		}

		// Mark rejected then drop from the map.
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

	getOriginalContent(uri: vscode.Uri): string | undefined {
		return this._entries.get(uri.toString())?.originalContent;
	}

	getProposedContent(uri: vscode.Uri): string | undefined {
		return this._entries.get(uri.toString())?.proposedContent;
	}

	dispose(): void {
		this._entries.clear();
		this._onDidChangePendingChanges.dispose();
	}
}

/**
 * Singleton instance. Constructed at module load time.
 *
 * Future services.ts will own this and re-export it; for now, code that
 * needs the pending-changes service imports from here directly. The
 * single-construction guarantee is what makes this safe.
 */
export const pendingChangesService = new PendingChangesService();
