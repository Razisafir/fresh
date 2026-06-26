/**
 * executionMode.ts — Layer 1 pure-logic: execution mode enum + configs.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/agent/executionMode.ts` (77L)
 * Port strategy: VERBATIM. Pure constants + types, zero VS Code imports.
 *
 * 02_ARCHITECTURE.md §4.1 lists this as a Layer 1 port-verbatim file.
 *
 * Decisions referenced: D-001 (file-by-file audit).
 */

/**
 * Execution mode for the agent after plan approval.
 * Controls how often the agent pauses for user review during execution.
 *
 * The MajorMilestone branch had a known bug in the old repo (per
 * 02_ARCHITECTURE.md §4.1 "Known bugs to fix during port"): the
 * `shouldPauseAt()` helper was missing the MajorMilestone case, causing
 * MajorMilestone to silently behave like FullAuto. The bug fix lands in
 * `src/agent/milestoneExecutor.ts` (the consumer of this enum), not here —
 * this file is just the enum and its display configs.
 */
export enum ExecutionMode {
	/** Pause at every milestone (fine-grained control). */
	EveryMilestone = 'every_milestone',
	/** Pause only at major milestones (balanced). */
	MajorMilestone = 'major_milestone',
	/** Pause only at user-selected milestones. */
	Selective = 'selective',
	/** Run to completion without pausing (full auto). */
	FullAuto = 'full_auto',
}

/**
 * Configuration for an execution mode.
 */
export interface IExecutionModeConfig {
	/** The execution mode. */
	readonly mode: ExecutionMode;
	/** Display label. */
	readonly label: string;
	/** Short description. */
	readonly description: string;
	/** Icon (Unicode). */
	readonly icon: string;
	/** Whether the agent pauses between milestones. */
	readonly pausesAtMilestones: boolean;
	/** Whether milestone selection is shown. */
	readonly showsMilestonePicker: boolean;
}

/**
 * Default configurations for each execution mode.
 *
 * Icons are Unicode escape sequences preserved verbatim from the old repo.
 * They render in VS Code's webview UI (which uses the OS font fallback chain).
 * - EveryMilestone: ⏸ (U+23F8)
 * - MajorMilestone: ⏯ (U+23EF)
 * - Selective:      ✅ (U+2705)
 * - FullAuto:       ⚡ (U+26A1)
 */
export const DEFAULT_EXECUTION_MODE_CONFIGS: Record<ExecutionMode, IExecutionModeConfig> = {
	[ExecutionMode.EveryMilestone]: {
		mode: ExecutionMode.EveryMilestone,
		label: 'Every Milestone',
		description: 'Pause at every milestone for review. Maximum control.',
		icon: '\u23F8', // ⏸
		pausesAtMilestones: true,
		showsMilestonePicker: false,
	},
	[ExecutionMode.MajorMilestone]: {
		mode: ExecutionMode.MajorMilestone,
		label: 'Major Milestones',
		description: 'Pause only at major milestones. Balanced control.',
		icon: '\u23EF', // ⏯
		pausesAtMilestones: true,
		showsMilestonePicker: false,
	},
	[ExecutionMode.Selective]: {
		mode: ExecutionMode.Selective,
		label: 'Selective',
		description: 'Choose which milestones to pause at.',
		icon: '\u2705', // ✅
		pausesAtMilestones: true,
		showsMilestonePicker: true,
	},
	[ExecutionMode.FullAuto]: {
		mode: ExecutionMode.FullAuto,
		label: 'Full Auto',
		description: 'Execute all steps without pausing. Fastest mode.',
		icon: '\u26A1', // ⚡
		pausesAtMilestones: false,
		showsMilestonePicker: false,
	},
};
