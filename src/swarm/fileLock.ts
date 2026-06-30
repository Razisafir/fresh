/**
 * fileLock.ts — Async file-level lock manager for the swarm orchestrator.
 *
 * Implements Option A from 08_SWARM_DESIGN.md §3.2: when an agent starts
 * executing a plan that touches file X, it acquires a lock on X. Other
 * agents that want to touch X block until the lock is released.
 *
 * Features:
 *   - Async acquire/release with configurable timeout
 *   - Re-entrant: same agent can re-acquire a lock it already holds
 *   - Deadlock detection: timeout-based with clear error messages
 *   - Lock queue: FIFO ordering for fairness
 *
 * Security: SEC-4 compliant — all paths normalised before locking.
 */

import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ILockHandle {
	/** The normalised file path that is locked. */
	readonly filePath: string;
	/** The agent ID that holds the lock. */
	readonly agentId: string;
	/** Release the lock. Safe to call multiple times. */
	release(): void;
}

export interface ILockManager {
	/**
	 * Acquire a lock on a file for the given agent.
	 * Blocks until the lock is available or the timeout expires.
	 * @throws {LockTimeoutError} if the lock cannot be acquired within timeoutMs
	 */
	acquire(filePath: string, agentId: string, timeoutMs?: number): Promise<ILockHandle>;

	/**
	 * Check whether a file is currently locked.
	 */
	isLocked(filePath: string): boolean;

	/**
	 * Get the agent ID that currently holds the lock, or undefined.
	 */
	getLockOwner(filePath: string): string | undefined;

	/**
	 * Get all currently held locks.
	 */
	getActiveLocks(): ReadonlyArray<{ filePath: string; agentId: string }>;

	/**
	 * Force-release all locks held by a given agent (e.g. when a worker dies).
	 */
	releaseAllForAgent(agentId: string): void;
}

export class LockTimeoutError extends Error {
	public readonly filePath: string;
	public readonly agentId: string;
	public readonly timeoutMs: number;

	constructor(filePath: string, agentId: string, timeoutMs: number) {
		super(`Lock timeout: agent "${agentId}" could not acquire lock on "${filePath}" within ${timeoutMs}ms`);
		this.name = 'LockTimeoutError';
		this.filePath = filePath;
		this.agentId = agentId;
		this.timeoutMs = timeoutMs;
	}
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface PendingRequest {
	agentId: string;
	resolve: (handle: ILockHandle) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class FileLockManager implements ILockManager {
	private readonly _locks = new Map<string, { agentId: string; refCount: number }>();
	private readonly _queues = new Map<string, PendingRequest[]>();

	constructor(private readonly _defaultTimeoutMs: number = 30_000) {}

	async acquire(filePath: string, agentId: string, timeoutMs?: number): Promise<ILockHandle> {
		const normalised = path.normalize(filePath);
		const timeout = timeoutMs ?? this._defaultTimeoutMs;

		// Re-entrant: if this agent already holds the lock, increment ref count
		const existing = this._locks.get(normalised);
		if (existing && existing.agentId === agentId) {
			existing.refCount++;
			return this._createHandle(normalised, agentId);
		}

		// If lock is free, acquire immediately
		if (!existing) {
			this._locks.set(normalised, { agentId, refCount: 1 });
			return this._createHandle(normalised, agentId);
		}

		// Lock is held by another agent — queue up
		return new Promise<ILockHandle>((resolve, reject) => {
			const queue = this._queues.get(normalised) ?? [];
			const timer = setTimeout(() => {
				// Remove from queue
				const idx = queue.indexOf(req);
				if (idx >= 0) queue.splice(idx, 1);
				if (queue.length === 0) this._queues.delete(normalised);
				reject(new LockTimeoutError(normalised, agentId, timeout));
			}, timeout);

			const req: PendingRequest = { agentId, resolve, reject, timer };
			queue.push(req);
			this._queues.set(normalised, queue);
		});
	}

	isLocked(filePath: string): boolean {
		return this._locks.has(path.normalize(filePath));
	}

	getLockOwner(filePath: string): string | undefined {
		return this._locks.get(path.normalize(filePath))?.agentId;
	}

	getActiveLocks(): ReadonlyArray<{ filePath: string; agentId: string }> {
		return Array.from(this._locks.entries()).map(([filePath, { agentId }]) => ({ filePath, agentId }));
	}

	releaseAllForAgent(agentId: string): void {
		for (const [filePath, lock] of this._locks.entries()) {
			if (lock.agentId === agentId) {
				this._locks.delete(filePath);
				this._grantNext(filePath);
			}
		}
	}

	// ---- Private helpers ----

	private _createHandle(normalisedPath: string, agentId: string): ILockHandle {
		let released = false;
		return {
			filePath: normalisedPath,
			agentId,
			release: () => {
				if (released) return;
				released = true;
				const lock = this._locks.get(normalisedPath);
				if (!lock || lock.agentId !== agentId) return;
				lock.refCount--;
				if (lock.refCount <= 0) {
					this._locks.delete(normalisedPath);
					this._grantNext(normalisedPath);
				}
			},
		};
	}

	private _grantNext(filePath: string): void {
		const queue = this._queues.get(filePath);
		if (!queue || queue.length === 0) {
			this._queues.delete(filePath);
			return;
		}
		const next = queue.shift()!;
		if (queue.length === 0) this._queues.delete(filePath);
		clearTimeout(next.timer);
		this._locks.set(filePath, { agentId: next.agentId, refCount: 1 });
		next.resolve(this._createHandle(filePath, next.agentId));
	}
}
