/**
 * agent.ts — Layer 1 type definitions for the Kovix agent loop.
 *
 * Phase 0 pivot (D-015): removed `import type { Event } from 'vscode'`.
 * The `Event` type is now imported from the local llm.ts (which defines
 * it locally instead of importing from vscode).
 */

import type { Event } from './llm';

// ---------------------------------------------------------------------------
// Forward declaration — IRestoreResult
// ---------------------------------------------------------------------------
export interface IRestoreResult {
	readonly snapshotId: string;
	readonly filesRestored: readonly string[];
	readonly filesFailed: readonly string[];
	readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// ExecutionState
// ---------------------------------------------------------------------------

export enum ExecutionState {
	Idle = 'idle',
	Planning = 'planning',
	AwaitingApproval = 'awaiting_approval',
	Executing = 'executing',
	Verifying = 'verifying',
	PausedAtMilestone = 'paused_at_milestone',
	Complete = 'complete',
	VerificationFailed = 'verification_failed',
	Error = 'error',
}

// ---------------------------------------------------------------------------
// Milestone / Plan types
// ---------------------------------------------------------------------------

export interface IMilestone {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly index: number;
	readonly isMajor: boolean;
	readonly stepIndices: number[];
	readonly completed: boolean;
}

export interface ISelectablePlanStep {
	readonly index: number;
	readonly action: 'Read' | 'Create' | 'Edit' | 'Run';
	readonly target: string;
	readonly description: string;
	selected: boolean;
}

export interface IApprovedPlan {
	readonly task: string;
	readonly steps: ISelectablePlanStep[];
	readonly executionMode: string;
	readonly milestones: IMilestone[];
	readonly selectedMilestoneIds?: string[];
	readonly approved: boolean;
	readonly approvedAt: number;
}

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

export type LoadingPhase =
	| 'idle'
	| 'planning'
	| 'planning-reading'
	| 'planning-listing'
	| 'planning-complete'
	| 'executing-step'
	| 'reading-file'
	| 'writing-file'
	| 'creating-directory'
	| 'running-command'
	| 'applying-diff'
	| 'verifying'
	| 'waiting-llm'
	| 'complete'
	| 'error';

export interface LoadingState {
	readonly phase: LoadingPhase;
	readonly message: string;
	readonly detail?: string;
	readonly progress?: number;
	readonly stepNumber?: number;
	readonly totalSteps?: number;
	readonly startTime: number;
	readonly toolName?: string;
	readonly filePath?: string;
}

export interface FileChangeEntry {
	readonly path: string;
	readonly status: 'created' | 'modified' | 'deleted' | 'reading' | 'writing';
	readonly timestamp: number;
}

export interface StepMetric {
	readonly stepNumber: number;
	readonly label: string;
	startTime: number;
	endTime?: number;
	readonly subSteps: Array<{
		readonly label: string;
		readonly startTime: number;
		endTime?: number;
	}>;
}

export interface TaskMetrics {
	readonly totalStartTime: number;
	totalEndTime?: number;
	planningStartTime?: number;
	planningEndTime?: number;
	readonly steps: StepMetric[];
	llmCallCount: number;
}

export const LOADING_PHASE_LABELS: Record<LoadingPhase, string> = {
	'idle': 'Ready',
	'planning': 'Analyzing your request...',
	'planning-reading': 'Reading files for context',
	'planning-listing': 'Listing directory contents',
	'planning-complete': 'Plan ready',
	'executing-step': 'Executing step',
	'reading-file': 'Reading file',
	'writing-file': 'Writing file',
	'creating-directory': 'Creating directory',
	'running-command': 'Running command',
	'applying-diff': 'Applying diff',
	'verifying': 'Verifying result',
	'waiting-llm': 'Thinking...',
	'complete': 'Task complete',
	'error': 'Error',
};

// ---------------------------------------------------------------------------
// AgentLoopEvent + plan types
// ---------------------------------------------------------------------------

export type AgentLoopEvent =
	| { type: 'thinking'; text: string }
	| { type: 'token'; text: string }
	| { type: 'tool_start'; toolId: string; toolName: string; toolInput?: unknown }
	| { type: 'tool_executing'; toolId: string; toolName: string; detail?: string }
	| { type: 'tool_result'; toolId: string; toolName: string; result: string; success: boolean }
	| { type: 'file_written'; filePath: string }
	| { type: 'complete'; summary: string }
	| { type: 'error'; text: string; recoverable: boolean }
	| { type: 'milestone_reached'; milestone: IMilestone }
	| { type: 'milestone_paused'; milestone: IMilestone }
	| { type: 'milestone_resumed'; milestone: IMilestone }
	| { type: 'milestone_skipped'; milestone: IMilestone }
	| { type: 'milestone_completed'; milestone: IMilestone }
	| { type: 'verification_start'; command: string }
	| { type: 'verification_result'; passed: boolean; output: string; unverified?: boolean };

export interface IPlanStep {
	index: number;
	action: 'Read' | 'Create' | 'Edit' | 'Run';
	target: string;
	description: string;
}

export interface IPlanResult {
	steps: IPlanStep[];
	summary: string;
	rawResponse: string;
}

// ---------------------------------------------------------------------------
// IAgentLoop interface
// ---------------------------------------------------------------------------

export interface IAgentLoop {
	runPlanningPhase(task: string, signal?: AbortSignal): Promise<IPlanResult>;
	run(task: string, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent>;
	readonly isRunning: boolean;
	readonly onDidStart: Event<string>;
	readonly onDidComplete: Event<{ summary: string }>;
	readonly onError: Event<{ text: string; recoverable: boolean }>;
	readonly onLoadingStateChange: Event<LoadingState>;
	readonly onFileChange: Event<FileChangeEntry>;
	undoLastTask(): Promise<IRestoreResult | null>;
	runWithApprovedPlan(approvedPlan: IApprovedPlan, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent>;
	resumeFromMilestone(): void;
	skipCurrentMilestone(): void;
	readonly executionState: ExecutionState;
	readonly currentMilestone: IMilestone | null;
	extractMilestonesFromPlan(steps: IPlanStep[]): IMilestone[];
	clearConversationHistory(): void;
}
