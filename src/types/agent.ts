/**
 * agent.ts — Layer 1 type definitions for the Kovix agent loop.
 *
 * Ported from Kovix_2.0 (per 02_ARCHITECTURE.md §6 mapping table):
 *   - `src/vs/platform/construct/common/agent/agentLoop.ts` (interface, 206L)
 *   - `src/vs/platform/construct/common/agent/milestoneStateMachine.ts` (97L)
 *   - `src/vs/platform/construct/common/agent/loadingState.ts` (103L)
 *
 * Port strategy: VERBATIM. Pure types — no VS Code internals, no logic.
 * Three old files merged into one because they all describe the same
 * state machine and are imported together everywhere.
 *
 * Translation notes:
 *   - `createDecorator<IAgentLoop>(...)` removed (no DI container in fresh,
 *     per 02_ARCHITECTURE.md §3 design choice #2). The interface is exported
 *     directly; consumers obtain the impl via `getService('agentLoop')`.
 *   - `Event<T>` imported from `vscode` instead of VS Code's internal
 *     `base/common/event.js`. Same shape.
 *   - `IRestoreResult` import from snapshotManager replaced with a local
 *     type alias to break the Layer 2 → Layer 1 dependency. The real
 *     `IRestoreResult` will be defined in `src/snapshot/snapshotManager.ts`
 *     (Layer 2) when that file is ported; this forward declaration lets
 *     Layer 1 compile standalone.
 *   - `_serviceBrand: undefined` field removed from interface — it was an
 *     internal VS Code DI marker, has no runtime meaning, and is not used
 *     by any code in fresh.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route).
 */

import type { Event } from 'vscode';

// ---------------------------------------------------------------------------
// Forward declaration — IRestoreResult (defined in src/snapshot/snapshotManager.ts)
// ---------------------------------------------------------------------------
// The agent loop's `undoLastTask()` returns this, but the snapshot manager is
// a Layer 2 service and we cannot import Layer 2 from Layer 1. The real type
// lives in src/snapshot/snapshotManager.ts and is structurally identical.
//
// The shape is preserved verbatim from the old repo so consumers don't have
// to change.
export interface IRestoreResult {
	readonly snapshotId: string;
	readonly filesRestored: readonly string[];
	readonly filesFailed: readonly string[];
	readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// ExecutionState (from milestoneStateMachine.ts)
// ---------------------------------------------------------------------------

/**
 * Execution state for the milestone-based agent loop.
 *
 * Verbatim from old repo. The state transitions drive the UI ("Planning…",
 * "Verifying…", "Paused at milestone") and gate which user actions are
 * available at any moment (e.g. `resumeFromMilestone` only valid in
 * PausedAtMilestone).
 */
export enum ExecutionState {
	Idle = 'idle',
	Planning = 'planning',
	AwaitingApproval = 'awaiting_approval',
	Executing = 'executing',
	/**
	 * Verifying — the agent has declared the milestone complete, but the
	 * harness is now running a real check (test script / build / typecheck)
	 * to confirm. The loop MUST pass through this state before reaching
	 * PausedAtMilestone or Complete. See agentLoop.ts runVerification().
	 *
	 * Unlike Executing, this state is harness-controlled, not LLM-controlled:
	 * the agent cannot self-report its way out of it.
	 */
	Verifying = 'verifying',
	PausedAtMilestone = 'paused_at_milestone',
	Complete = 'complete',
	/**
	 * VerificationFailed — the harness's real check returned a non-zero
	 * exit code. Routes into AgentErrorRecoveryService as a first-class
	 * error type ('verification_failed'), not silently swallowed.
	 */
	VerificationFailed = 'verification_failed',
	Error = 'error',
}

// ---------------------------------------------------------------------------
// Milestone / Plan types (from milestoneStateMachine.ts)
// ---------------------------------------------------------------------------

/**
 * A milestone in the execution plan.
 * Milestones are natural stopping points where the agent can pause
 * for user review before continuing.
 */
export interface IMilestone {
	/** Unique identifier. */
	readonly id: string;
	/** Display name. */
	readonly name: string;
	/** Description of what this milestone accomplishes. */
	readonly description: string;
	/** Index in the plan (0-based). */
	readonly index: number;
	/** Whether this milestone is a major one (e.g., core feature complete). */
	readonly isMajor: boolean;
	/** Plan step indices included in this milestone. */
	readonly stepIndices: number[];
	/** Whether this milestone has been completed. */
	readonly completed: boolean;
}

/**
 * A selectable plan step (for task deselection).
 */
export interface ISelectablePlanStep {
	/** Step index. */
	readonly index: number;
	/** Step action. */
	readonly action: 'Read' | 'Create' | 'Edit' | 'Run';
	/** Step target. */
	readonly target: string;
	/** Step description. */
	readonly description: string;
	/** Whether this step is selected for execution. */
	selected: boolean;
}

/**
 * An approved plan with optional step deselection and execution mode.
 */
export interface IApprovedPlan {
	/** The task description. */
	readonly task: string;
	/** Steps with selection state. */
	readonly steps: ISelectablePlanStep[];
	/** Selected execution mode. */
	readonly executionMode: string;
	/** Milestones extracted from the plan. */
	readonly milestones: IMilestone[];
	/**
	 * IDs of milestones the user selected to pause at (Selective mode only).
	 * Fix for F-007 (#77): previously the picker discarded this selection.
	 * Undefined means "use default pause behavior for the chosen mode".
	 */
	readonly selectedMilestoneIds?: string[];
	/** Whether the plan was approved by the user. */
	readonly approved: boolean;
	/** Timestamp of approval. */
	readonly approvedAt: number;
}

// ---------------------------------------------------------------------------
// Loading state (from loadingState.ts)
// ---------------------------------------------------------------------------

/**
 * Granular loading phases for the Kovix agent loop.
 * Each phase represents a distinct operation with its own visual indicator.
 */
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

/**
 * Represents the current loading state of the agent loop.
 * Emitted via IAgentLoop.onLoadingStateChange for real-time UI updates.
 */
export interface LoadingState {
	readonly phase: LoadingPhase;
	readonly message: string;
	readonly detail?: string;
	readonly progress?: number; // 0-100 for operations with known progress
	readonly stepNumber?: number;
	readonly totalSteps?: number;
	readonly startTime: number;
	readonly toolName?: string;
	readonly filePath?: string;
}

/**
 * A single file change tracked during agent execution.
 * Used for the real-time file tree diff in the progress panel.
 */
export interface FileChangeEntry {
	readonly path: string;
	readonly status: 'created' | 'modified' | 'deleted' | 'reading' | 'writing';
	readonly timestamp: number;
}

/**
 * Metrics for a single execution step.
 * Tracks sub-operations (file reads, writes, commands) within a step.
 */
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

/**
 * Aggregate performance metrics for a complete agent task.
 * Displayed in the metrics panel upon task completion.
 */
export interface TaskMetrics {
	readonly totalStartTime: number;
	totalEndTime?: number;
	planningStartTime?: number;
	planningEndTime?: number;
	readonly steps: StepMetric[];
	llmCallCount: number;
}

/**
 * Human-readable labels for each loading phase.
 */
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
// AgentLoopEvent + plan types (from agentLoop.ts)
// ---------------------------------------------------------------------------

/**
 * Events emitted by the agent loop during execution.
 *
 * Verbatim from old repo. The discriminated union includes the four
 * milestone events (milestone_reached/paused/resumed/skipped/completed)
 * and the two verification events that were added in Phase 5.5 of the
 * old repo to support the harness-controlled Verifying state.
 */
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
	/**
	 * Emitted when the user clicks 'Skip' on a paused milestone.
	 *
	 * Distinct from milestone_resumed: the skipped milestone is NOT
	 * counted as completed. milestone_completed does NOT fire for this
	 * milestone. The helper proceeds to the next milestone.
	 *
	 * Downstream consumers (memory, verification, UI) should treat
	 * this milestone as not-done — its work may have been executed
	 * by the LLM, but the user chose not to count it as completed.
	 */
	| { type: 'milestone_skipped'; milestone: IMilestone }
	| { type: 'milestone_completed'; milestone: IMilestone }
	/**
	 * Emitted when the harness enters the Verifying state — i.e. the agent
	 * has declared the milestone complete and the harness is now running a
	 * real check (test / build / typecheck). The UI shows a "Verifying…"
	 * chip while this is in flight.
	 */
	| { type: 'verification_start'; command: string }
	/**
	 * Emitted when the harness's verification check finishes.
	 *
	 * - passed=true  → milestone advances normally (PausedAtMilestone or Complete)
	 * - passed=false → ExecutionState transitions to VerificationFailed and
	 *   the failure routes through AgentErrorRecoveryService as a
	 *   'verification_failed' error type (budget 3, then escalate).
	 *
	 * If no test/build/typecheck command exists for the workspace, the
	 * milestone is marked "unverified" (passed=true but output contains
	 * the literal marker "unverified:no-command") and the UI surfaces a
	 * distinct warning-toned badge rather than reporting it as done.
	 */
	| { type: 'verification_result'; passed: boolean; output: string; unverified?: boolean };

/**
 * Plan step returned from the planning phase.
 */
export interface IPlanStep {
	index: number;
	action: 'Read' | 'Create' | 'Edit' | 'Run';
	target: string;
	description: string;
}

/**
 * Result of the planning phase.
 */
export interface IPlanResult {
	steps: IPlanStep[];
	summary: string;
	rawResponse: string;
}

// ---------------------------------------------------------------------------
// IAgentLoop interface (from agentLoop.ts)
// ---------------------------------------------------------------------------

/**
 * Agent loop service — orchestrates LLM calls with tool execution.
 *
 * Flow:
 * 1. Accept a task from the user
 * 2. Run planning phase (read-only tools only)
 * 3. Return plan for user approval
 * 4. If approved, run execution phase (full tool access)
 * 5. Loop: LLM call → detect tool_use → execute tool → feed result back → repeat
 * 6. Stop when LLM returns end_turn or max rounds (15) reached
 *
 * The concrete implementation lives in src/agent/agentLoop.ts (Layer 2).
 */
export interface IAgentLoop {
	/**
	 * Run the planning phase — uses read-only tools to understand the codebase
	 * and generate a plan. Does NOT make any changes.
	 *
	 * @param task The user's task description.
	 * @param signal Optional AbortSignal for cancellation.
	 * @returns Plan with steps for user approval.
	 */
	runPlanningPhase(task: string, signal?: AbortSignal): Promise<IPlanResult>;

	/**
	 * Run the full execution phase with all tools available.
	 * Yields AgentLoopEvents in real time for UI updates.
	 *
	 * @param task The user's task description.
	 * @param signal Optional AbortSignal for cancellation.
	 * @returns AsyncGenerator of events for real-time streaming.
	 */
	run(task: string, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent>;

	/**
	 * Whether an agent loop is currently running.
	 */
	readonly isRunning: boolean;

	/**
	 * Event fired when the loop starts.
	 */
	readonly onDidStart: Event<string>;

	/**
	 * Event fired when the loop completes.
	 */
	readonly onDidComplete: Event<{ summary: string }>;

	/**
	 * Event fired when the loop encounters an error.
	 */
	readonly onError: Event<{ text: string; recoverable: boolean }>;

	/**
	 * Event fired when the loading state changes during planning or execution.
	 * Provides granular, function-level progress information for the UI.
	 */
	readonly onLoadingStateChange: Event<LoadingState>;

	/**
	 * Event fired when a file is created, modified, or deleted during execution.
	 * Used for the real-time file tree diff in the progress panel.
	 */
	readonly onFileChange: Event<FileChangeEntry>;

	/**
	 * Undo the last agent task by restoring the most recent snapshot.
	 * Reverts all file changes made during the last task.
	 *
	 * @returns The restore result, or null if no active snapshot exists.
	 */
	undoLastTask(): Promise<IRestoreResult | null>;

	/**
	 * Run execution with an approved plan and milestone-based pausing.
	 * Yields AgentLoopEvents including milestone pause/resume events.
	 *
	 * @param approvedPlan The user-approved plan with selected steps and execution mode.
	 * @param signal Optional AbortSignal for cancellation.
	 * @returns AsyncGenerator of events for real-time streaming.
	 */
	runWithApprovedPlan(approvedPlan: IApprovedPlan, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent>;

	/**
	 * Resume execution from the current milestone.
	 * Called after the user reviews and approves the milestone result.
	 */
	resumeFromMilestone(): void;

	/**
	 * Skip the current milestone and move to the next one.
	 */
	skipCurrentMilestone(): void;

	/**
	 * Current execution state for milestone-aware execution.
	 */
	readonly executionState: ExecutionState;

	/**
	 * The current milestone being executed, if paused.
	 */
	readonly currentMilestone: IMilestone | null;

	/**
	 * Extract milestones from a plan's steps.
	 * Groups plan steps into logical milestones based on action type
	 * and target patterns.
	 *
	 * @param steps The plan steps from a planning result.
	 * @returns Array of milestones with their associated steps.
	 */
	extractMilestonesFromPlan(steps: IPlanStep[]): IMilestone[];

	/**
	 * Clear the accumulated conversation history.
	 * Resets any in-memory conversation state so the next
	 * agent invocation starts with a fresh context.
	 */
	clearConversationHistory(): void;
}
