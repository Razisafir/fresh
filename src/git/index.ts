/**
 * git/index.ts — Barrel export for the Git integration module.
 *
 * Re-exports the service singleton getter and all public types.
 */

export {
	// Singleton
	getGitService,
	_resetGitService,

	// Interfaces
	type IGitService,
	type IGitStatus,
	type IGitFileStatus,
	type IGitCommit,
	type IGitBranchInfo,
	type IGitMergeResult,
	type IGitPullResult,
	type IGitDiffSummary,
	type IGitStashEntry,
	type IGitBlameLine,
	type IGitRemote,
	type IGitRepositoryChangeEvent,
} from './gitService';
