/**
 * gitService.ts — Git integration service for the Kovix desktop app.
 *
 * Exposes git operations via IPC to the renderer process. All git commands
 * are executed via `child_process.execFile('git', ...)` (NOT shell) for
 * security — this avoids shell injection vectors entirely.
 *
 * Parsing strategy:
 *   - `git status --porcelain=v2` for status
 *   - `git log --format` with custom format string for log / commit parsing
 *   - `git diff --stat` for diff summaries
 *   - Line-by-line parsing of porcelain output throughout
 *
 * Security:
 *   - Paths are validated against workspace roots via `assertWithinWorkspace()`
 *   - Child-process env is sanitised via `buildChildEnv()`
 *   - No shell execution — `execFile` only
 *
 * Events:
 *   - `onDidChangeRepository` fires when status, branch, or commits change
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { assertWithinWorkspace } from '../security/workspaceGuard';
import { buildChildEnv } from '../security/childEnv';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface IGitStatus {
        branch: string;
        ahead: number;
        behind: number;
        staged: IGitFileStatus[];
        unstaged: IGitFileStatus[];
        untracked: string[];
        conflicted: string[];
        clean: boolean;
}

export interface IGitFileStatus {
        path: string;
        status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';
        oldPath?: string; // for renames
}

export interface IGitCommit {
        hash: string;
        shortHash: string;
        author: string;
        email: string;
        date: Date;
        message: string;
        parents: string[];
}

export interface IGitBranchInfo {
        name: string;
        current: boolean;
        upstream?: string;
        ahead: number;
        behind: number;
        lastCommitDate?: Date;
}

export interface IGitMergeResult {
        success: boolean;
        conflicts?: string[];
        message: string;
}

export interface IGitPullResult {
        fastForward: boolean;
        filesChanged: number;
        insertions: number;
        deletions: number;
}

export interface IGitDiffSummary {
        filesChanged: number;
        insertions: number;
        deletions: number;
        files: Array<{ path: string; insertions: number; deletions: number }>;
}

export interface IGitStashEntry {
        index: number;
        message: string;
        branch: string;
        date: Date;
}

export interface IGitBlameLine {
        line: number;
        hash: string;
        author: string;
        date: Date;
        content: string;
}

export interface IGitRemote {
        name: string;
        url: string;
        type: 'fetch' | 'push';
}

export interface IGitRepositoryChangeEvent {
        repoPath: string;
        type: 'status-changed' | 'branch-changed' | 'commits-changed';
}

export interface IGitService {
        // Status
        getStatus(repoPath: string): Promise<IGitStatus>;
        getBranches(repoPath: string): Promise<IGitBranchInfo[]>;
        getCurrentBranch(repoPath: string): Promise<string>;
        getLog(repoPath: string, count?: number): Promise<IGitCommit[]>;

        // Diffs
        getDiff(repoPath: string, options?: { staged?: boolean; filePath?: string }): Promise<string>;
        getDiffSummary(repoPath: string): Promise<IGitDiffSummary>;

        // Operations
        stage(repoPath: string, filePaths: string[]): Promise<void>;
        unstage(repoPath: string, filePaths: string[]): Promise<void>;
        commit(repoPath: string, message: string): Promise<string>; // returns commit hash
        checkout(repoPath: string, branch: string): Promise<void>;
        createBranch(repoPath: string, name: string, checkout?: boolean): Promise<void>;
        deleteBranch(repoPath: string, name: string, force?: boolean): Promise<void>;
        merge(repoPath: string, branch: string): Promise<IGitMergeResult>;
        pull(repoPath: string, remote?: string, branch?: string): Promise<IGitPullResult>;
        push(repoPath: string, remote?: string, branch?: string): Promise<void>;

        // Stash
        stash(repoPath: string, message?: string): Promise<void>;
        stashPop(repoPath: string): Promise<void>;
        stashList(repoPath: string): Promise<IGitStashEntry[]>;

        // Blame
        blame(repoPath: string, filePath: string): Promise<IGitBlameLine[]>;

        // File history
        getFileHistory(repoPath: string, filePath: string, count?: number): Promise<IGitCommit[]>;

        // Remotes
        getRemotes(repoPath: string): Promise<IGitRemote[]>;

        // Init
        init(repoPath: string): Promise<void>;

        // Events
        onDidChangeRepository: Event<IGitRepositoryChangeEvent>;
}

// ---------------------------------------------------------------------------
// Minimal Event / EventEmitter (same pattern as aiService.ts)
// ---------------------------------------------------------------------------

type Event<T> = (listener: (data: T) => void) => { dispose(): void };

class EventEmitter<T> {
        private listeners: Array<(data: T) => void> = [];

        get event(): Event<T> {
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
// Helpers
// ---------------------------------------------------------------------------

/** Delimiter used in `git log --format` to separate fields. */
const LOG_FIELD_DELIM = '\x00';

/**
 * Format string for `git log --format`.
 * Fields: hash, shortHash, authorName, authorEmail, date (unix), subject, parent hashes
 */
const LOG_FORMAT = `${LOG_FIELD_DELIM}%H${LOG_FIELD_DELIM}%h${LOG_FIELD_DELIM}%an${LOG_FIELD_DELIM}%ae${LOG_FIELD_DELIM}%at${LOG_FIELD_DELIM}%s${LOG_FIELD_DELIM}%P${LOG_FIELD_DELIM}`;

/**
 * Execute a git command via `execFile` (never shell).
 *
 * Validates `repoPath` against workspace roots and sanitises the child env.
 */
function execGit(
        args: string[],
        repoPath: string,
        options?: { maxBuffer?: number },
): Promise<string> {
        // Validate the repo path is within the workspace.
        assertWithinWorkspace(repoPath);

        const { env } = buildChildEnv();
        const maxBuffer = options?.maxBuffer ?? 50 * 1024 * 1024; // 50 MB

        return new Promise<string>((resolve, reject) => {
                execFile(
                        'git',
                        args,
                        {
                                cwd: repoPath,
                                env,
                                maxBuffer,
                                // No shell — execFile does not use a shell by default.
                        },
                        (error, stdout, stderr) => {
                                if (error) {
                                        // Provide a structured error with useful context.
                                        const cmd = `git ${args.join(' ')}`;
                                        const detail = stderr?.trim() || error.message;
                                        const err = new Error(`Git command failed: ${cmd}\n${detail}`);
                                        // Attach original error as a non-enumerable property for debugging
                                        Object.defineProperty(err, 'cause', { value: error, enumerable: false });
                                        reject(err);
                                        return;
                                }
                                resolve(stdout);
                        },
                );
        });
}

/**
 * Parse `git status --porcelain=v2` output into an IGitStatus object.
 *
 * Porcelain v2 format reference:
 *   # branch.oid <hash>
 *   # branch.head <name>
 *   # branch.upstream <name>
 *   # branch.ab +<n> -<m>
 *   1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path><sep><origPath>
 *   u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 *   ? <path>
 *   ! <path>
 */
function parsePorcelainV2(raw: string): IGitStatus {
        const lines = raw.split('\n');

        let branch = '';
        let ahead = 0;
        let behind = 0;
        const staged: IGitFileStatus[] = [];
        const unstaged: IGitFileStatus[] = [];
        const untracked: string[] = [];
        const conflicted: string[] = [];

        for (const line of lines) {
                if (!line) continue;

                // Branch headers
                if (line.startsWith('# branch.head ')) {
                        branch = line.slice('# branch.head '.length);
                        continue;
                }
                if (line.startsWith('# branch.ab ')) {
                        const abPart = line.slice('# branch.ab '.length);
                        // Format: +N -M  (e.g. "+3 -1")
                        const match = abPart.match(/^\+(\d+)\s+-(\d+)$/);
                        if (match) {
                                ahead = parseInt(match[1], 10);
                                behind = parseInt(match[2], 10);
                        }
                        continue;
                }

                // Skip other header lines
                if (line.startsWith('# ')) continue;

                // Untracked files
                if (line.startsWith('? ')) {
                        untracked.push(line.slice(2));
                        continue;
                }

                // Ignored files — skip
                if (line.startsWith('! ')) continue;

                // Ordinary changed entry (type 1)
                if (line.startsWith('1 ')) {
                        const parts = line.split(' ');
                        // parts[0] = '1', parts[1] = xy (2-char index+worktree status)
                        const xy = parts[1];
                        // parts[8] = path (everything after the 8th space)
                        const filePath = parts.slice(8).join(' ');

                        const indexStatus = xy[0]; // staged
                        const worktreeStatus = xy[1]; // unstaged

                        if (indexStatus === 'U' || worktreeStatus === 'U') {
                                conflicted.push(filePath);
                        } else {
                                if (indexStatus !== '.' && indexStatus !== ' ') {
                                        staged.push(mapStatus(indexStatus, filePath));
                                }
                                if (worktreeStatus !== '.' && worktreeStatus !== ' ') {
                                        unstaged.push(mapStatus(worktreeStatus, filePath));
                                }
                        }
                        continue;
                }

                // Renamed/copied entry (type 2)
                if (line.startsWith('2 ')) {
                        const parts = line.split(' ');
                        const xy = parts[1];
                        // parts[8..N] = "newPath<sep>oldPath" where <sep> is a tab in some
                        // implementations. The porcelain=v2 spec uses a literal tab between
                        // the new and original path, but the fields are space-delimited
                        // before the path. We reconstruct the tail and split on tab.
                        const tail = parts.slice(8).join(' ');
                        const sepIdx = tail.indexOf('\t');
                        let newPath: string;
                        let oldPath: string;
                        if (sepIdx >= 0) {
                                newPath = tail.slice(0, sepIdx);
                                oldPath = tail.slice(sepIdx + 1);
                        } else {
                                // Fallback: should not happen with porcelain=v2, but be safe.
                                newPath = tail;
                                oldPath = tail;
                        }

                        const indexStatus = xy[0];
                        const worktreeStatus = xy[1];

                        const status: 'renamed' | 'copied' = indexStatus === 'C' ? 'copied' : 'renamed';

                        if (indexStatus !== '.' && indexStatus !== ' ') {
                                staged.push({ path: newPath, status, oldPath });
                        }
                        if (worktreeStatus !== '.' && worktreeStatus !== ' ') {
                                unstaged.push({ path: newPath, status: mapStatusCode(worktreeStatus), oldPath });
                        }
                        continue;
                }

                // Unmerged entry (type u)
                if (line.startsWith('u ')) {
                        const parts = line.split(' ');
                        // parts[9] = path (everything after the 9th space)
                        const filePath = parts.slice(9).join(' ');
                        conflicted.push(filePath);
                        continue;
                }
        }

        const clean =
                staged.length === 0 &&
                unstaged.length === 0 &&
                untracked.length === 0 &&
                conflicted.length === 0;

        return {
                branch: branch === '(detached)' ? '(detached)' : branch,
                ahead,
                behind,
                staged,
                unstaged,
                untracked,
                conflicted,
                clean,
        };
}

/** Map a single-character git status code to our status enum. */
function mapStatusCode(code: string): 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' {
        switch (code) {
                case 'M': case 'm': return 'modified';
                case 'A': case 'a': return 'added';
                case 'D': case 'd': return 'deleted';
                case 'R': case 'r': return 'renamed';
                case 'C': case 'c': return 'copied';
                default: return 'modified';
        }
}

/** Map a single-character git status code to an IGitFileStatus. */
function mapStatus(code: string, filePath: string): IGitFileStatus {
        return { path: filePath, status: mapStatusCode(code) };
}

/**
 * Parse `git log --format` output produced with LOG_FORMAT.
 *
 * The output is structured as: DELIM hash DELIM shortHash DELIM author DELIM
 * email DELIM unixDate DELIM subject DELIM parents DELIM per commit, followed
 * by a newline. We split on the trailing DELIM+newline boundary.
 */
function parseLogOutput(raw: string): IGitCommit[] {
        if (!raw.trim()) return [];

        const commits: IGitCommit[] = [];
        // Each commit record is: \0hash\0shortHash\0author\0email\0date\0subject\0parents\0\n
        // Split on the record boundary — trailing \0\n or \0 at end.
        const records = raw.split(/\0\n/).filter(r => r.trim());

        for (const record of records) {
                // Strip leading/trailing delimiters and split
                const fields = record.replace(/^\x00/, '').replace(/\x00$/, '').split(LOG_FIELD_DELIM); // eslint-disable-line no-control-regex
                if (fields.length < 7) continue;

                const [hash, shortHash, author, email, dateStr, message, parentsStr] = fields;
                const parents = parentsStr ? parentsStr.split(' ').filter(Boolean) : [];

                commits.push({
                        hash,
                        shortHash,
                        author,
                        email,
                        date: new Date(parseInt(dateStr, 10) * 1000),
                        message,
                        parents,
                });
        }

        return commits;
}

/**
 * Parse `git diff --numstat` output into a diff summary.
 * Format: additions<tab>deletions<tab>filepath
 */
function parseNumstat(raw: string): Array<{ path: string; insertions: number; deletions: number }> {
        const files: Array<{ path: string; insertions: number; deletions: number }> = [];

        for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                const parts = line.split('\t');
                if (parts.length < 3) continue;

                const insertions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
                const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
                const filePath = parts.slice(2).join('\t'); // path may contain tabs in theory

                files.push({ path: filePath, insertions, deletions });
        }

        return files;
}

/**
 * Parse `git diff --stat` tail line for totals.
 * Example: " 5 files changed, 30 insertions(+), 10 deletions(-)"
 */
function parseStatTotals(line: string): { filesChanged: number; insertions: number; deletions: number } {
        const result = { filesChanged: 0, insertions: 0, deletions: 0 };

        const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
        if (filesMatch) result.filesChanged = parseInt(filesMatch[1], 10);

        const insMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
        if (insMatch) result.insertions = parseInt(insMatch[1], 10);

        const delMatch = line.match(/(\d+)\s+deletions?\(-\)/);
        if (delMatch) result.deletions = parseInt(delMatch[1], 10);

        return result;
}

// ---------------------------------------------------------------------------
// GitService implementation
// ---------------------------------------------------------------------------

class GitService implements IGitService {
        private readonly _onDidChangeRepository = new EventEmitter<IGitRepositoryChangeEvent>();
        readonly onDidChangeRepository = this._onDidChangeRepository.event;

        /** Fire a change event for the given repo path and change type. */
        private notifyChange(repoPath: string, type: IGitRepositoryChangeEvent['type']): void {
                this._onDidChangeRepository.fire({ repoPath, type });
        }

        // -----------------------------------------------------------------------
        // Status
        // -----------------------------------------------------------------------

        async getStatus(repoPath: string): Promise<IGitStatus> {
                const output = await execGit(['status', '--porcelain=v2', '--branch'], repoPath);
                return parsePorcelainV2(output);
        }

        async getBranches(repoPath: string): Promise<IGitBranchInfo[]> {
                // --verbose gives [ahead N, behind M], --all includes remote tracking refs
                const output = await execGit(
                        ['for-each-ref', '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:unix)', 'refs/heads/'],
                        repoPath,
                );

                const branches: IGitBranchInfo[] = [];
                for (const line of output.split('\n')) {
                        if (!line.trim()) continue;
                        const [name, headMarker, upstream, track, dateStr] = line.split('\x00');

                        let ahead = 0;
                        let behind = 0;

                        // Parse track info like " [ahead 3, behind 1]" or " [ahead 2]"
                        if (track) {
                                const aheadMatch = track.match(/ahead\s+(\d+)/);
                                if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);

                                const behindMatch = track.match(/behind\s+(\d+)/);
                                if (behindMatch) behind = parseInt(behindMatch[1], 10);
                        }

                        branches.push({
                                name,
                                current: headMarker === '*',
                                upstream: upstream || undefined,
                                ahead,
                                behind,
                                lastCommitDate: dateStr ? new Date(parseInt(dateStr, 10) * 1000) : undefined,
                        });
                }

                return branches;
        }

        async getCurrentBranch(repoPath: string): Promise<string> {
                const output = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
                return output.trim();
        }

        async getLog(repoPath: string, count: number = 50): Promise<IGitCommit[]> {
                const output = await execGit(
                        ['log', `--max-count=${count}`, `--format=${LOG_FORMAT}`],
                        repoPath,
                );
                return parseLogOutput(output);
        }

        // -----------------------------------------------------------------------
        // Diffs
        // -----------------------------------------------------------------------

        async getDiff(repoPath: string, options?: { staged?: boolean; filePath?: string }): Promise<string> {
                const args = ['diff'];
                if (options?.staged) args.push('--cached');
                if (options?.filePath) {
                        args.push('--', options.filePath);
                }
                return execGit(args, repoPath, { maxBuffer: 100 * 1024 * 1024 });
        }

        async getDiffSummary(repoPath: string): Promise<IGitDiffSummary> {
                // Use --numstat for per-file numbers (more reliable to parse than --stat)
                const [numstatRaw, statRaw] = await Promise.all([
                        execGit(['diff', '--numstat', 'HEAD'], repoPath).catch(() => ''),
                        execGit(['diff', '--stat', 'HEAD'], repoPath).catch(() => ''),
                ]);

                const files = parseNumstat(numstatRaw);

                // Try to extract totals from the stat summary line (last line)
                const statLines = statRaw.trim().split('\n');
                const summaryLine = statLines.length > 0 ? statLines[statLines.length - 1] : '';
                const totals = parseStatTotals(summaryLine);

                // If we didn't get totals from --stat, compute from numstat
                if (totals.filesChanged === 0 && files.length > 0) {
                        totals.filesChanged = files.length;
                        totals.insertions = files.reduce((sum, f) => sum + f.insertions, 0);
                        totals.deletions = files.reduce((sum, f) => sum + f.deletions, 0);
                }

                return {
                        filesChanged: totals.filesChanged || files.length,
                        insertions: totals.insertions,
                        deletions: totals.deletions,
                        files,
                };
        }

        // -----------------------------------------------------------------------
        // Operations
        // -----------------------------------------------------------------------

        async stage(repoPath: string, filePaths: string[]): Promise<void> {
                if (filePaths.length === 0) return;
                await execGit(['add', '--', ...filePaths], repoPath);
                this.notifyChange(repoPath, 'status-changed');
        }

        async unstage(repoPath: string, filePaths: string[]): Promise<void> {
                if (filePaths.length === 0) return;
                await execGit(['reset', 'HEAD', '--', ...filePaths], repoPath);
                this.notifyChange(repoPath, 'status-changed');
        }

        async commit(repoPath: string, message: string): Promise<string> {
                // Use --cleanup=strip to sanitize the message (removes trailing whitespace,
                // comments, etc.) and -m to pass the message on the command line.
                // We sanitize the message ourselves to avoid injection.
                const sanitizedMessage = message.replace(/\0/g, '').replace(/\n{3,}/g, '\n\n').trim();
                const output = await execGit(['commit', '-m', sanitizedMessage, '--cleanup=strip'], repoPath);
                this.notifyChange(repoPath, 'commits-changed');
                this.notifyChange(repoPath, 'status-changed');

                // Extract the commit hash from the output
                const hashMatch = output.match(/\[[\w\-./]+\s+([0-9a-f]{7,40})\]/);
                if (hashMatch) return hashMatch[1];

                // Fallback: get the hash of the new commit
                const revOutput = await execGit(['rev-parse', 'HEAD'], repoPath);
                return revOutput.trim();
        }

        async checkout(repoPath: string, branch: string): Promise<void> {
                await execGit(['checkout', branch], repoPath);
                this.notifyChange(repoPath, 'branch-changed');
                this.notifyChange(repoPath, 'status-changed');
        }

        async createBranch(repoPath: string, name: string, checkout: boolean = false): Promise<void> {
                if (checkout) {
                        await execGit(['checkout', '-b', name], repoPath);
                } else {
                        await execGit(['branch', name], repoPath);
                }
                this.notifyChange(repoPath, 'branch-changed');
        }

        async deleteBranch(repoPath: string, name: string, force: boolean = false): Promise<void> {
                const flag = force ? '-D' : '-d';
                await execGit(['branch', flag, name], repoPath);
                this.notifyChange(repoPath, 'branch-changed');
        }

        async merge(repoPath: string, branch: string): Promise<IGitMergeResult> {
                try {
                        const output = await execGit(['merge', branch], repoPath);
                        this.notifyChange(repoPath, 'commits-changed');
                        this.notifyChange(repoPath, 'status-changed');

                        const fastForward = output.includes('Fast-forward');

                        return {
                                success: true,
                                message: output.trim(),
                                conflicts: fastForward ? undefined : [],
                        };
                } catch (error) {
                        const err = error as Error;
                        const msg = err.message;

                        // Check for merge conflicts
                        if (msg.includes('CONFLICT') || msg.includes('Merge conflict')) {
                                // Get list of conflicted files
                                const statusOutput = await execGit(['diff', '--name-only', '--diff-filter=U'], repoPath).catch(() => '');
                                const conflicts = statusOutput.trim().split('\n').filter(Boolean);

                                this.notifyChange(repoPath, 'status-changed');

                                return {
                                        success: false,
                                        conflicts,
                                        message: 'Merge completed with conflicts',
                                };
                        }

                        // Re-throw non-conflict errors
                        throw error;
                }
        }

        async pull(repoPath: string, remote?: string, branch?: string): Promise<IGitPullResult> {
                const args = ['pull'];
                if (remote) args.push(remote);
                if (branch && remote) args.push(branch);

                const output = await execGit(args, repoPath);
                this.notifyChange(repoPath, 'commits-changed');
                this.notifyChange(repoPath, 'status-changed');

                const fastForward = output.includes('Fast-forward');

                // Parse pull stats from output
                let filesChanged = 0;
                let insertions = 0;
                let deletions = 0;

                const filesMatch = output.match(/(\d+)\s+files?\s+changed/);
                if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);

                const insMatch = output.match(/(\d+)\s+insertions?\(\+\)/);
                if (insMatch) insertions = parseInt(insMatch[1], 10);

                const delMatch = output.match(/(\d+)\s+deletions?\(-\)/);
                if (delMatch) deletions = parseInt(delMatch[1], 10);

                return { fastForward, filesChanged, insertions, deletions };
        }

        async push(repoPath: string, remote?: string, branch?: string): Promise<void> {
                const args = ['push'];
                if (remote) args.push(remote);
                if (branch && remote) args.push(branch);

                await execGit(args, repoPath);
                this.notifyChange(repoPath, 'status-changed');
        }

        // -----------------------------------------------------------------------
        // Stash
        // -----------------------------------------------------------------------

        async stash(repoPath: string, message?: string): Promise<void> {
                const args = ['stash', 'push'];
                if (message) args.push('-m', message);
                await execGit(args, repoPath);
                this.notifyChange(repoPath, 'status-changed');
        }

        async stashPop(repoPath: string): Promise<void> {
                await execGit(['stash', 'pop'], repoPath);
                this.notifyChange(repoPath, 'status-changed');
        }

        async stashList(repoPath: string): Promise<IGitStashEntry[]> {
                const output = await execGit(
                        ['stash', 'list', '--format=%gd%x00%s%x00%gD%x00%ct'],
                        repoPath,
                ).catch(() => '');

                if (!output.trim()) return [];

                const entries: IGitStashEntry[] = [];
                for (const line of output.split('\n')) {
                        if (!line.trim()) continue;

                        const parts = line.split('\x00');
                        if (parts.length < 4) continue;

                        const [refStr, message, _branchRef, dateStr] = parts;

                        // Parse index from "stash@{0}"
                        const indexMatch = refStr.match(/stash@{(\d+)}/);
                        const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;

                        // Extract branch name from branchRef like "refs/stash" or the message
                        // The message typically starts with "On <branch>: <msg>" or "WIP on <branch>: <msg>"
                        const branchMatch = message.match(/^(?:On|WIP on)\s+(\S+):/);
                        const branchName = branchMatch ? branchMatch[1] : '';

                        entries.push({
                                index,
                                message,
                                branch: branchName,
                                date: new Date(parseInt(dateStr, 10) * 1000),
                        });
                }

                return entries;
        }

        // -----------------------------------------------------------------------
        // Blame
        // -----------------------------------------------------------------------

        async blame(repoPath: string, filePath: string): Promise<IGitBlameLine[]> {
                // Validate the file path is within the workspace
                assertWithinWorkspace(path.resolve(repoPath, filePath));

                // Use --porcelain for machine-readable output
                const output = await execGit(
                        ['blame', '--porcelain', '--', filePath],
                        repoPath,
                        { maxBuffer: 100 * 1024 * 1024 },
                );

                return parseBlamePorcelain(output);
        }

        // -----------------------------------------------------------------------
        // File history
        // -----------------------------------------------------------------------

        async getFileHistory(repoPath: string, filePath: string, count: number = 50): Promise<IGitCommit[]> {
                // Validate the file path is within the workspace
                assertWithinWorkspace(path.resolve(repoPath, filePath));

                const output = await execGit(
                        ['log', `--max-count=${count}`, `--format=${LOG_FORMAT}`, '--', filePath],
                        repoPath,
                );
                return parseLogOutput(output);
        }

        // -----------------------------------------------------------------------
        // Remotes
        // -----------------------------------------------------------------------

        async getRemotes(repoPath: string): Promise<IGitRemote[]> {
                const output = await execGit(['remote', '-v'], repoPath);
                const remotes: IGitRemote[] = [];

                for (const line of output.split('\n')) {
                        if (!line.trim()) continue;

                        // Format: "<name>\t<url> (fetch)" or "<name>\t<url> (push)"
                        const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
                        if (match) {
                                remotes.push({
                                        name: match[1],
                                        url: match[2],
                                        type: match[3] as 'fetch' | 'push',
                                });
                        }
                }

                return remotes;
        }

        // -----------------------------------------------------------------------
        // Init
        // -----------------------------------------------------------------------

        async init(repoPath: string): Promise<void> {
                await execGit(['init'], repoPath);
                this.notifyChange(repoPath, 'status-changed');
        }

        // -----------------------------------------------------------------------
        // Lifecycle
        // -----------------------------------------------------------------------

        dispose(): void {
                this._onDidChangeRepository.dispose();
        }
}

// ---------------------------------------------------------------------------
// Blame porcelain parser
// ---------------------------------------------------------------------------

/**
 * Parse `git blame --porcelain` output.
 *
 * Each commit header starts with "<hash> <lineNr> <origLineNr> <groupCount>"
 * followed by header lines like "author <name>", "author-mail <email>",
 * "author-time <unix>", "summary <msg>", etc.
 * The actual line content is prefixed with a tab after the header block.
 */
function parseBlamePorcelain(raw: string): IGitBlameLine[] {
        const lines: IGitBlameLine[] = [];
        const commitBlocks = new Map<string, { author: string; date: Date }>();

        const allLines = raw.split('\n');
        let currentLine = 0;
        let currentHash = '';
        let currentContent = '';

        while (currentLine < allLines.length) {
                const line = allLines[currentLine];

                // Match a blame header line: <hash> <origLine> <resultLine> <groupSize>
                const headerMatch = line.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)\s+(\d+)/);
                if (headerMatch) {
                        currentHash = headerMatch[1];
                        const resultLineNum = parseInt(headerMatch[3], 10);

                        // Parse header lines until we hit a tab-prefixed content line
                        let author = '';
                        let date = new Date();

                        currentLine++;
                        while (currentLine < allLines.length) {
                                const hLine = allLines[currentLine];

                                // Content line: starts with \t
                                if (hLine.startsWith('\t')) {
                                        currentContent = hLine.slice(1);

                                        // Check cache for commit data
                                        if (!commitBlocks.has(currentHash)) {
                                                commitBlocks.set(currentHash, { author, date });
                                        }
                                        const cached = commitBlocks.get(currentHash)!;

                                        lines.push({
                                                line: resultLineNum,
                                                hash: currentHash,
                                                author: cached.author,
                                                date: cached.date,
                                                content: currentContent,
                                        });
                                        currentLine++;
                                        break;
                                }

                                // Parse header fields
                                if (hLine.startsWith('author ')) {
                                        author = hLine.slice('author '.length);
                                } else if (hLine.startsWith('author-time ')) {
                                        date = new Date(parseInt(hLine.slice('author-time '.length), 10) * 1000);
                                }

                                currentLine++;
                        }
                        continue;
                }

                currentLine++;
        }

        return lines;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: GitService | undefined;

/**
 * Returns the singleton GitService instance. Lazily created on first call.
 */
export function getGitService(): IGitService {
        if (!_instance) {
                _instance = new GitService();
                logger.info('[GitService] Instance created');
        }
        return _instance;
}

/**
 * Reset the singleton (for testing only).
 */
export function _resetGitService(): void {
        if (_instance) {
                _instance.dispose();
                _instance = undefined;
        }
}
