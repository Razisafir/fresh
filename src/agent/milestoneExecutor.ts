/**
 * milestoneExecutor.ts — Layer 1 pure-logic: milestone iteration with pause/resume.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/agent/milestoneExecutor.ts` (334L)
 * Port strategy: VERBATIM. Pure async generator, no VS Code imports.
 *
 * 02_ARCHITECTURE.md §4.1 lists this as a Layer 1 port-verbatim file.
 *
 * Translation notes:
 *   - Imports of `IApprovedPlan`, `IMilestone`, `ISelectablePlanStep`, `AgentLoopEvent`
 *     are re-pointed at `../types/agent.ts` (the merged Layer 1 file) instead of
 *     the old repo's split `milestoneStateMachine.js` / `agentLoop.js`.
 *   - No other changes. The function body is identical to the old repo because
 *     the helper was already extracted to be a pure-ish function taking its
 *     collaborators as parameters — no DI, no VS Code services, no side
 *     effects beyond what the caller passes in.
 *
 * Known bug fix (per 02_ARCHITECTURE.md §4.1): the old repo's `shouldPauseAt()`
 * was MISSING the `major_milestone` branch — it silently fell through to the
 * `selective` / `full_auto` cases, making MajorMilestone behave like FullAuto.
 * The implementation below INCLUDES the missing branch. This is the M3 bug
 * fix referenced in 01_REQUIREMENTS.md §8 success criteria.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route).
 */

import type { IApprovedPlan, IMilestone, ISelectablePlanStep, AgentLoopEvent } from '../types/agent';

/**
 * File-path patterns that indicate a configuration file.
 * Editing or creating any file matching these patterns is considered a
 * "major" operation in MajorMilestone mode.
 */
const CONFIG_FILE_PATTERNS: readonly RegExp[] = [
	/(^|\/)package\.json$/,
	/(^|\/)tsconfig\.json$/,
	/(^|\/)tsconfig\..+\.json$/,
	/(^|\/)\.env/,
	/(^|\/)docker-compose/,
	/(^|\/)Dockerfile/,
	/(^|\/)\.gitignore$/,
	/(^|\/)Cargo\.toml$/,
	/(^|\/)go\.mod$/,
	/(^|\/)go\.sum$/,
	/(^|\/)pom\.xml$/,
	/(^|\/)build\.gradle/,
	/(^|\/)settings\.json$/,
	/(^|\/)launch\.json$/,
	/(^|\/)extensions\.json$/,
	/(^|\/)Makefile$/,
	/(^|\/)CMakeLists\.txt$/,
	/(^|\/)\.eslintrc/,
	/(^|\/)\.prettierrc/,
	/(^|\/)webpack\.config/,
	/(^|\/)vite\.config/,
	/(^|\/)next\.config/,
];

/**
 * Determine whether a single plan step is a "major" operation
 * that warrants a pause in MajorMilestone mode.
 *
 * Major operations are:
 *   - File creation (action === 'Create') — new files are structural changes
 *   - File deletion — represented as 'Run' (e.g., rm) since there is no
 *     'Delete' action type; all 'Run' steps are treated as major because
 *     shell commands can mutate state
 *   - Changes to configuration files (package.json, tsconfig.json, .env, etc.)
 *   - Any 'Run' step — shell commands that aren't guaranteed read-only
 *
 * Read-only operations (action === 'Read', plain 'Edit' on non-config files)
 * are NOT considered major.
 */
function isMajorStep(step: ISelectablePlanStep): boolean {
	// File creation is always major - it introduces new files into the project
	if (step.action === 'Create') {
		return true;
	}
	// Shell commands are treated as major - they may modify state
	// (file deletion, network calls, installs, etc.)
	if (step.action === 'Run') {
		return true;
	}
	// Edits to configuration files are major - they affect project structure
	// and behavior in ways that are hard to auto-revert
	if (step.action === 'Edit' && CONFIG_FILE_PATTERNS.some(p => p.test(step.target))) {
		return true;
	}
	// Read-only operations and plain source edits are not major
	return false;
}

/**
 * Caller-provided function that runs ONE milestone's worth of work.
 * Must yield AgentLoopEvents for real-time UI updates.
 * Should return (stop yielding) when the sub-task is done or aborted.
 */
export type ExecuteSubTaskFn = (
	subTask: string,
	signal?: AbortSignal,
) => AsyncGenerator<AgentLoopEvent>;

/**
 * Caller-provided function that runs the harness verification check
 * for a completed milestone. Must yield verification_start +
 * verification_result events.
 */
export type RunVerificationFn = (
	signal?: AbortSignal,
) => AsyncGenerator<AgentLoopEvent>;

/**
 * Caller-provided function that resolves when the user calls
 * resumeFromMilestone() or skipCurrentMilestone(). In production this
 * awaits the _milestoneResumeResolver promise; in tests it can be a
 * controllable promise that the test resolves at the right moment.
 *
 * The function receives the milestone being paused at, in case the caller
 * needs it for logging or state tracking.
 *
 * Return value: 'resume' or 'skip'. The helper branches on this:
 *   - 'resume' → emits milestone_resumed + milestone_completed (normal)
 *   - 'skip'   → emits milestone_skipped, does NOT emit milestone_completed,
 *                and continues to the next milestone. The skipped milestone
 *                is NOT counted as completed.
 */
export type AwaitResumeFn = (milestone: IMilestone) => Promise<'resume' | 'skip'>;

/**
 * Options for executeMilestonesWithPauses.
 */
export interface IMilestoneExecutorOptions {
	approvedPlan: IApprovedPlan;
	executeSubTask: ExecuteSubTaskFn;
	runVerification: RunVerificationFn;
	awaitResume: AwaitResumeFn;
	signal?: AbortSignal;
	/**
	 * Optional logger. If provided, the helper logs milestone transitions
	 * for debugging. If not provided, logging is silent.
	 */
	log?: (message: string) => void;
}

/**
 * Iterate milestones with real pause/resume.
 *
 * Yields AgentLoopEvent including milestone_reached, milestone_paused,
 * milestone_resumed, milestone_skipped, milestone_completed, plus any
 * events yielded by executeSubTask and runVerification.
 *
 * Skip semantics (Fix: skip vs resume are now distinct):
 *   - resumeFromMilestone() → awaitResume returns 'resume' →
 *     milestone_resumed + milestone_completed fire normally.
 *   - skipCurrentMilestone() → awaitResume returns 'skip' →
 *     milestone_skipped fires, milestone_completed does NOT fire, and
 *     the skipped milestone is not counted as completed. The helper
 *     proceeds to the next milestone.
 *
 * Returns (stops yielding) when:
 *   - All milestones are completed (caller should yield 'complete' after)
 *   - signal is aborted
 *   - executeSubTask yields a fatal (recoverable=false) error
 *
 * The caller is responsible for:
 *   - Setting _executionState = Executing before calling
 *   - Setting _executionState = PausedAtMilestone when milestone_paused is yielded
 *   - Setting _executionState = Executing when milestone_resumed is yielded
 *   - Setting _executionState = Complete after the generator returns
 *   - Yielding 'complete' with the aggregated summary
 *   - Managing _isRunning, _activeSnapshotId, _currentMilestone, etc.
 *
 * M3 BUG FIX (per 02_ARCHITECTURE.md §4.1): the `shouldPauseAt()` inner
 * function now has an explicit `major_milestone` branch. In the old repo
 * this branch was missing, so MajorMilestone silently fell through to
 * FullAuto behaviour. The fix is in this file because `shouldPauseAt`
 * closes over `approvedPlan` and is local to the generator — there's no
 * way to fix it from outside without restructuring the API.
 */
export async function* executeMilestonesWithPauses(
	options: IMilestoneExecutorOptions,
): AsyncGenerator<AgentLoopEvent> {
	const { approvedPlan, executeSubTask, runVerification, awaitResume, signal, log } = options;

	// Determine which milestones to pause at.
	const pauseMode = approvedPlan.executionMode ?? 'auto';
	const selectedPauseIds = new Set(approvedPlan.selectedMilestoneIds ?? []);

	const shouldPauseAt = (milestone: IMilestone): boolean => {
		// EveryMilestone: pause at every milestone (fine-grained control)
		if (pauseMode === 'every_milestone') {
			return true;
		}
		// MajorMilestone: pause only when the milestone involves "major" operations.
		//
		// M3 BUG FIX: This branch was MISSING in the old repo (Kovix_2.0),
		// causing MajorMilestone to silently behave like FullAuto. The fix
		// is just adding the branch — the body was already written and
		// waiting to be invoked.
		if (pauseMode === 'major_milestone') {
			// Fast path: if the planner already flagged this milestone as major, always pause
			if (milestone.isMajor) {
				return true;
			}
			// Otherwise, inspect the milestone's steps to see if any qualify as "major"
			const milestoneStepIndices = new Set(milestone.stepIndices);
			const steps = approvedPlan.steps.filter(
				(s, idx) => s.selected && milestoneStepIndices.has(idx),
			);
			return steps.some(step => isMajorStep(step));
		}
		// Selective: pause only at user-selected milestone IDs
		if (pauseMode === 'selective' && selectedPauseIds.has(milestone.id)) {
			return true;
		}
		// FullAuto / unknown: no user-selected pauses
		return false;
	};

	let aggregatedSummary = '';

	for (let mi = 0; mi < approvedPlan.milestones.length; mi++) {
		const milestone = approvedPlan.milestones[mi];

		// User-abort check between milestones
		if (signal?.aborted) {
			yield { type: 'error', text: '[STOP] Stopped by user', recoverable: false };
			return;
		}

		// 1. Fire milestone_reached
		log?.(`[MilestoneExecutor] Milestone ${mi + 1}/${approvedPlan.milestones.length} reached: ${milestone.name}`);
		yield { type: 'milestone_reached', milestone };

		// 2. Build sub-task string from this milestone's selected steps
		const milestoneStepIndices = new Set(milestone.stepIndices);
		const milestoneSteps = approvedPlan.steps
			.filter((s, idx) => s.selected && milestoneStepIndices.has(idx));

		if (milestoneSteps.length === 0) {
			// No selected steps in this milestone — skip it but still fire events
			log?.(`[MilestoneExecutor] Milestone ${milestone.name} has no selected steps, skipping`);
			aggregatedSummary += `\n[Milestone ${milestone.name}: no selected steps]\n`;
		} else {
			const stepList = milestoneSteps.map(s => `${s.action}: ${s.target}`).join('\n');
			const subTask = `${approvedPlan.task}\n\nMilestone ${mi + 1}: ${milestone.name}\nExecute these specific steps:\n${stepList}`;

			// 3. Run the LLM + tool loop for this milestone's sub-task
			let milestoneSummary = '';
			for await (const event of executeSubTask(subTask, signal)) {
				yield event;
				if (event.type === 'token') {
					milestoneSummary += event.text;
				} else if (event.type === 'error' && !event.recoverable) {
					// Fatal error during the round — abort the whole plan
					return;
				}
			}

			aggregatedSummary += `\n[Milestone ${milestone.name}]\n${milestoneSummary}`;

			// 4. Run verification for this milestone
			let verificationFailed = false;
			for await (const vEvent of runVerification(signal)) {
				yield vEvent;
				if (vEvent.type === 'verification_result' && !vEvent.passed) {
					verificationFailed = true;
					log?.(`[MilestoneExecutor] Milestone ${milestone.name} verification failed`);
					yield {
						type: 'error',
						text: `[Verification Failed] Milestone '${milestone.name}' declared complete, but the harness check returned non-zero.\n${vEvent.output.substring(0, 800)}`,
						recoverable: true,
					};
				}
			}

			// 5. Pause if verification failed OR user selected pause-here
			const mustPause = verificationFailed || shouldPauseAt(milestone);
			if (mustPause) {
				log?.(`[MilestoneExecutor] Paused at milestone: ${milestone.name} (verificationFailed=${verificationFailed})`);
				yield { type: 'milestone_paused', milestone };

				// Await the user's resume/skip action. The return value
				// distinguishes the two paths: 'resume' marks the milestone as
				// completed-and-verified; 'skip' marks it as skipped (NOT
				// completed) and proceeds to the next milestone.
				const resumeAction = await awaitResume(milestone);

				// Re-check abort after resume
				if (signal?.aborted) {
					yield { type: 'error', text: '[STOP] Stopped by user during milestone pause', recoverable: false };
					return;
				}

				if (resumeAction === 'skip') {
					// User chose to skip this milestone. Mark it as skipped
					// (NOT completed), log it clearly so downstream memory /
					// verification correctly reflects it wasn't actually done,
					// and proceed to the next milestone WITHOUT firing
					// milestone_completed.
					log?.(`[MilestoneExecutor] Milestone ${milestone.name} SKIPPED by user (not completed)`);
					aggregatedSummary += `\n[Milestone ${milestone.name}: SKIPPED by user -- not completed]\n`;
					yield { type: 'milestone_skipped', milestone };
					continue;
				}

				yield { type: 'milestone_resumed', milestone };
			}
		}

		// 6. Fire milestone_completed (only for the resume path; skip
		//    path continues past this via the `continue` above).
		yield { type: 'milestone_completed', milestone };
		log?.(`[MilestoneExecutor] Milestone ${milestone.name} completed`);
	}

	// Yield a final 'complete' event with the aggregated summary.
	// The caller may choose to suppress this and yield its own 'complete'
	// after doing memory storage / conversation history updates.
	yield { type: 'complete', summary: aggregatedSummary || 'Task completed.' };
}
