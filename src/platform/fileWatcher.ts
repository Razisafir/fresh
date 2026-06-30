/**
 * fileWatcher.ts — File watching service that monitors workspace directories
 * for changes and notifies the renderer.
 *
 * Uses Node.js built-in fs.watch with debouncing to batch rapid changes.
 * On macOS/Windows, uses recursive watching; on Linux, manually watches
 * subdirectories (since recursive is not supported).
 *
 * Phase 0 pivot (D-015): uses local EventEmitter instead of vscode.EventEmitter.
 * Uses the Event<T> type from types/llm.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Event } from '../types/llm';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IFileChangeEvent {
	path: string;
	type: 'changed' | 'created' | 'deleted';
	timestamp: number;
}

export interface IFileWatcherService {
	startWatching(rootPaths: string[]): void;
	stopWatching(): void;
	onDidChange: Event<IFileChangeEvent>;
	onDidCreate: Event<IFileChangeEvent>;
	onDidDelete: Event<IFileChangeEvent>;
	dispose(): void;
}

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
// Constants
// ---------------------------------------------------------------------------

/** Directories to ignore when watching. */
const IGNORED_DIRS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'.next',
	'.cache',
	'.DS_Store',
	'__pycache__',
	'.svn',
	'.hg',
	'target',
	'.gradle',
	'.idea',
	'.vscode',
]);

/** Debounce interval in milliseconds. */
const DEBOUNCE_MS = 100;

/** Whether the current platform supports recursive fs.watch. */
const SUPPORTS_RECURSIVE = process.platform === 'darwin' || process.platform === 'win32';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class FileWatcherService implements IFileWatcherService, Disposable {
	private readonly _onDidChange = new EventEmitter<IFileChangeEvent>();
	private readonly _onDidCreate = new EventEmitter<IFileChangeEvent>();
	private readonly _onDidDelete = new EventEmitter<IFileChangeEvent>();

	readonly onDidChange = this._onDidChange.event;
	readonly onDidCreate = this._onDidCreate.event;
	readonly onDidDelete = this._onDidDelete.event;

	/** Active fs.FSWatcher instances, keyed by the watched directory path. */
	private readonly _watchers = new Map<string, fs.FSWatcher>();

	/** Debounce timers per path, keyed by normalised file path. */
	private readonly _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/** Pending events waiting to be flushed after debounce. */
	private readonly _pendingEvents = new Map<string, IFileChangeEvent>();

	/** Whether we are currently watching. */
	private _watching = false;

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	startWatching(rootPaths: string[]): void {
		if (this._watching) {
			this.stopWatching();
		}

		this._watching = true;
		logger.info(`[FileWatcher] Starting watch on ${rootPaths.length} root(s)`);

		for (const rootPath of rootPaths) {
			const normalised = path.normalize(rootPath);
			this._watchRoot(normalised);
		}
	}

	stopWatching(): void {
		if (!this._watching) return;
		this._watching = false;

		// Clear all debounce timers.
		for (const timer of this._debounceTimers.values()) {
			clearTimeout(timer);
		}
		this._debounceTimers.clear();
		this._pendingEvents.clear();

		// Close all watchers.
		for (const [watchedPath, watcher] of this._watchers) {
			try {
				watcher.close();
			} catch {
				// Ignore close errors.
			}
			logger.verbose(`[FileWatcher] Closed watcher for: ${watchedPath}`);
		}
		this._watchers.clear();

		logger.info('[FileWatcher] Stopped watching all paths');
	}

	dispose(): void {
		this.stopWatching();
		this._onDidChange.dispose();
		this._onDidCreate.dispose();
		this._onDidDelete.dispose();
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/**
	 * Start watching a single root directory. On macOS/Windows, this uses
	 * recursive watching. On Linux, it walks subdirectories and watches each.
	 */
	private _watchRoot(rootPath: string): void {
		if (!this._watching) return;

		// Check that the directory exists.
		try {
			const stat = fs.statSync(rootPath);
			if (!stat.isDirectory()) {
				logger.warn(`[FileWatcher] Not a directory, skipping: ${rootPath}`);
				return;
			}
		} catch {
			logger.warn(`[FileWatcher] Cannot stat path, skipping: ${rootPath}`);
			return;
		}

		if (SUPPORTS_RECURSIVE) {
			this._createWatcher(rootPath, true);
		} else {
			// Linux: watch root + recurse into subdirectories manually.
			this._watchRecursiveLinux(rootPath);
		}
	}

	/**
	 * On Linux, manually walk the directory tree and create a watcher for
	 * each directory (since recursive: true is not supported).
	 */
	private _watchRecursiveLinux(dirPath: string): void {
		if (!this._watching) return;

		this._createWatcher(dirPath, false);

		try {
			const entries = fs.readdirSync(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (IGNORED_DIRS.has(entry.name)) continue;

				const childPath = path.join(dirPath, entry.name);
				this._watchRecursiveLinux(childPath);
			}
		} catch {
			// Permission denied or similar — skip.
		}
	}

	/**
	 * Create an fs.FSWatcher for a single directory.
	 */
	private _createWatcher(dirPath: string, recursive: boolean): void {
		if (this._watchers.has(dirPath)) return;

		let watcher: fs.FSWatcher;
		try {
			watcher = fs.watch(dirPath, { recursive }, (eventType, filename) => {
				if (!filename) return;
				this._handleEvent(dirPath, eventType, filename);
			});
		} catch (err) {
			this._handleWatcherError(err, dirPath);
			return;
		}

		watcher.on('error', (err) => {
			this._handleWatcherError(err, dirPath);
			// Remove the broken watcher so we don't try to close it later.
			this._watchers.delete(dirPath);
		});

		this._watchers.set(dirPath, watcher);
		logger.verbose(`[FileWatcher] Watching: ${dirPath} (recursive: ${recursive})`);
	}

	/**
	 * Handle an fs.watch event. Determines change type, filters ignored
	 * paths, normalises, and debounces the event.
	 */
	private _handleEvent(watchedDir: string, eventType: string, filename: string): void {
		if (!this._watching) return;

		// Normalise the full path.
		const fullPath = path.normalize(path.join(watchedDir, filename));

		// Check if any segment of the path is in the ignored list.
		if (this._isIgnoredPath(fullPath)) return;

		// Determine the change type. fs.watch provides 'rename' or 'change'.
		// 'rename' can mean created or deleted — we stat to distinguish.
		let changeType: 'changed' | 'created' | 'deleted';

		if (eventType === 'change') {
			changeType = 'changed';
		} else {
			// 'rename' event — check if the file exists.
			try {
				fs.statSync(fullPath);
				changeType = 'created';
			} catch {
				changeType = 'deleted';
			}
		}

		const event: IFileChangeEvent = {
			path: fullPath,
			type: changeType,
			timestamp: Date.now(),
		};

		this._debounceEvent(fullPath, event);

		// On Linux, when a new directory is created, we need to add a watcher
		// for it (since we don't have recursive watching).
		if (!SUPPORTS_RECURSIVE && changeType === 'created') {
			try {
				const stat = fs.statSync(fullPath);
				if (stat.isDirectory() && !this._watchers.has(fullPath)) {
					this._watchRecursiveLinux(fullPath);
				}
			} catch {
				// File was deleted between the stat check — ignore.
			}
		}
	}

	/**
	 * Debounce a file change event. If multiple events arrive for the same
	 * path within DEBOUNCE_MS, only the last one is emitted.
	 */
	private _debounceEvent(normalisedPath: string, event: IFileChangeEvent): void {
		// If there's an existing pending event for this path, we update it.
		// The last event type wins (e.g. rapid create → change → just emit change).
		this._pendingEvents.set(normalisedPath, event);

		// Reset the debounce timer.
		const existing = this._debounceTimers.get(normalisedPath);
		if (existing) {
			clearTimeout(existing);
		}

		const timer = setTimeout(() => {
			this._debounceTimers.delete(normalisedPath);
			const pending = this._pendingEvents.get(normalisedPath);
			if (pending) {
				this._pendingEvents.delete(normalisedPath);
				this._emitEvent(pending);
			}
		}, DEBOUNCE_MS);

		this._debounceTimers.set(normalisedPath, timer);
	}

	/**
	 * Emit a debounced file change event to the appropriate event emitter.
	 */
	private _emitEvent(event: IFileChangeEvent): void {
		if (!this._watching) return;

		switch (event.type) {
			case 'changed':
				this._onDidChange.fire(event);
				break;
			case 'created':
				this._onDidCreate.fire(event);
				break;
			case 'deleted':
				this._onDidDelete.fire(event);
				break;
		}

		logger.verbose(`[FileWatcher] Emitted ${event.type}: ${event.path}`);
	}

	/**
	 * Check whether a path should be ignored based on its directory segments.
	 */
	private _isIgnoredPath(fullPath: string): boolean {
		const segments = fullPath.split(path.sep);
		return segments.some(seg => IGNORED_DIRS.has(seg));
	}

	/**
	 * Handle watcher errors (EMFILE, ENOSPC, etc.).
	 */
	private _handleWatcherError(err: unknown, dirPath: string): void {
		if (err instanceof Error) {
			const code = (err as NodeJS.ErrnoException).code;
			switch (code) {
				case 'EMFILE':
					logger.error(`[FileWatcher] EMFILE: Too many open file descriptors. Cannot watch: ${dirPath}. Consider increasing system limits (ulimit -n).`);
					break;
				case 'ENOSPC':
					logger.error(`[FileWatcher] ENOSPC: No space left on device or inotify watch limit reached. Cannot watch: ${dirPath}. Consider increasing fs.inotify.max_user_watches.`);
					break;
				case 'ENOENT':
					// Directory was deleted — this is normal during deletion cascades.
					logger.verbose(`[FileWatcher] ENOENT: Directory removed: ${dirPath}`);
					break;
				case 'EACCES':
					logger.warn(`[FileWatcher] EACCES: Permission denied for: ${dirPath}`);
					break;
				default:
					logger.error(`[FileWatcher] Error watching ${dirPath}: ${err.message}`);
			}
		} else {
			logger.error(`[FileWatcher] Unknown error watching ${dirPath}: ${String(err)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: IFileWatcherService | undefined;

/**
 * Returns the singleton file watcher service. Creates it lazily on first call.
 */
export function getFileWatcherService(): IFileWatcherService {
	if (!_instance) {
		_instance = new FileWatcherService();
	}
	return _instance;
}

/**
 * Reset the file watcher service (for testing only).
 */
export function _resetFileWatcherService(): void {
	_instance?.dispose();
	_instance = undefined;
}
