/**
 * Unit tests for src/agent/milestoneExecutor.ts (milestone iteration with pause/resume).
 *
 * The crown jewel test is the M3 bug fix verification: the old repo's
 * shouldPauseAt() helper was missing the MajorMilestone branch, so
 * MajorMilestone mode silently behaved like FullAuto. The fix is just
 * adding the branch — these tests pin it.
 *
 * Also tests:
 *   - Skip vs Resume semantics (skip = NOT completed, resume = completed).
 *   - Verification failure forces a pause regardless of mode.
 *   - Fatal error during sub-task aborts the plan.
 *   - Empty milestone (no selected steps) is skipped without pausing.
 *   - User abort (signal.aborted) between milestones yields fatal error.
 */

import { expect } from 'chai';
import {
        executeMilestonesWithPauses,
        IMilestoneExecutorOptions,
} from '../../../src/agent/milestoneExecutor';
import {
        IApprovedPlan,
        IMilestone,
        ISelectablePlanStep,
        AgentLoopEvent,
} from '../../../src/types/agent';
import { ExecutionMode } from '../../../src/agent/executionMode';

// --- Test helpers ------------------------------------------------------------

function makeStep(overrides: Partial<ISelectablePlanStep> = {}): ISelectablePlanStep {
        return {
                index: 0,
                action: 'Read',
                target: 'file.ts',
                description: 'a step',
                selected: true,
                ...overrides,
        };
}

function makeMilestone(overrides: Partial<IMilestone> = {}): IMilestone {
        return {
                id: 'milestone-0',
                name: 'Test milestone',
                description: 'steps 1-2',
                index: 0,
                isMajor: false,
                stepIndices: [0],
                completed: false,
                ...overrides,
        };
}

function makePlan(overrides: Partial<IApprovedPlan> = {}): IApprovedPlan {
        return {
                task: 'do something',
                steps: [makeStep()],
                milestones: [makeMilestone()],
                executionMode: ExecutionMode.FullAuto,
                selectedMilestoneIds: [],
                approved: true,
                approvedAt: Date.now(),
                ...overrides,
        };
}

async function collectEvents(gen: AsyncGenerator<AgentLoopEvent>): Promise<AgentLoopEvent[]> {
        const events: AgentLoopEvent[] = [];
        for await (const e of gen) {
                events.push(e);
        }
        return events;
}

// --- Tests -------------------------------------------------------------------

describe('milestoneExecutor', () => {
        describe('executeMilestonesWithPauses() — FullAuto mode', () => {
                it('runs all milestones without pausing', async () => {
                        const plan = makePlan({
                                steps: [
                                        makeStep({ index: 0, action: 'Read', target: 'a.ts' }),
                                        makeStep({ index: 1, action: 'Edit', target: 'b.ts' }),
                                ],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0] }),
                                        makeMilestone({ id: 'm-1', index: 1, stepIndices: [1] }),
                                ],
                                executionMode: ExecutionMode.FullAuto,
                        });

                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask(subTask) {
                                        yield { type: 'token', text: `working on: ${subTask.substring(0, 30)}` };
                                },
                                async *runVerification() {
                                        yield { type: 'verification_start', command: 'npm test' };
                                        yield { type: 'verification_result', passed: true, output: 'all good', command: 'npm test' };
                                },
                                awaitResume: async () => 'resume',
                        };

                        const events = await collectEvents(executeMilestonesWithPauses(options));

                        // 2 milestones × (reached + verification_start + verification_result + completed) + final complete
                        expect(events.some(e => e.type === 'milestone_reached' && (e as any).milestone.id === 'm-0')).to.be.true;
                        expect(events.some(e => e.type === 'milestone_reached' && (e as any).milestone.id === 'm-1')).to.be.true;
                        expect(events.some(e => e.type === 'milestone_completed' && (e as any).milestone.id === 'm-0')).to.be.true;
                        expect(events.some(e => e.type === 'milestone_completed' && (e as any).milestone.id === 'm-1')).to.be.true;
                        expect(events.some(e => e.type === 'milestone_paused')).to.be.false;
                        expect(events.some(e => e.type === 'complete')).to.be.true;
                });

                it('does NOT call awaitResume in FullAuto (no pauses)', async () => {
                        const plan = makePlan({
                                steps: [makeStep({ action: 'Read' })],
                                milestones: [makeMilestone()],
                                executionMode: ExecutionMode.FullAuto,
                        });

                        let resumeCalled = false;
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => { resumeCalled = true; return 'resume'; },
                        };

                        await collectEvents(executeMilestonesWithPauses(options));
                        expect(resumeCalled).to.be.false;
                });
        });

        describe('executeMilestonesWithPauses() — EveryMilestone mode', () => {
                it('pauses at every milestone and resumes on "resume"', async () => {
                        const plan = makePlan({
                                steps: [
                                        makeStep({ index: 0, action: 'Read', target: 'a.ts' }),
                                        makeStep({ index: 1, action: 'Edit', target: 'b.ts' }),
                                ],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0] }),
                                        makeMilestone({ id: 'm-1', index: 1, stepIndices: [1] }),
                                ],
                                executionMode: ExecutionMode.EveryMilestone,
                        });

                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => 'resume',
                        };

                        const events = await collectEvents(executeMilestonesWithPauses(options));

                        // 2 pauses (one per milestone)
                        const pausedEvents = events.filter(e => e.type === 'milestone_paused');
                        expect(pausedEvents).to.have.lengthOf(2);

                        // 2 resumes
                        const resumedEvents = events.filter(e => e.type === 'milestone_resumed');
                        expect(resumedEvents).to.have.lengthOf(2);

                        // 2 completions (resume path → completed)
                        const completedEvents = events.filter(e => e.type === 'milestone_completed');
                        expect(completedEvents).to.have.lengthOf(2);

                        // 0 skips
                        expect(events.filter(e => e.type === 'milestone_skipped')).to.have.lengthOf(0);
                });

                it('marks milestone as SKIPPED (not completed) when awaitResume returns "skip"', async () => {
                        const plan = makePlan({
                                steps: [makeStep({ index: 0, action: 'Read', target: 'a.ts' })],
                                milestones: [makeMilestone({ id: 'm-0', stepIndices: [0] })],
                                executionMode: ExecutionMode.EveryMilestone,
                        });

                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => 'skip',
                        };

                        const events = await collectEvents(executeMilestonesWithPauses(options));

                        expect(events.some(e => e.type === 'milestone_paused')).to.be.true;
                        expect(events.some(e => e.type === 'milestone_skipped')).to.be.true;
                        // Skip path does NOT emit milestone_completed for the skipped milestone.
                        expect(events.filter(e => e.type === 'milestone_completed')).to.have.lengthOf(0);
                });
        });

        describe('executeMilestonesWithPauses() — MajorMilestone mode (M3 BUG FIX)', () => {
                it('pauses at a milestone flagged isMajor=true', async () => {
                        const plan = makePlan({
                                steps: [
                                        makeStep({ index: 0, action: 'Read', target: 'a.ts' }),
                                        makeStep({ index: 1, action: 'Create', target: 'b.ts' }),
                                ],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0], isMajor: false }),
                                        makeMilestone({ id: 'm-1', index: 1, stepIndices: [1], isMajor: true }),
                                ],
                                executionMode: ExecutionMode.MajorMilestone,
                        });

                        const pauseIds: string[] = [];
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async (m) => { pauseIds.push(m.id); return 'resume'; },
                        };

                        await collectEvents(executeMilestonesWithPauses(options));

                        // M3 FIX: previously MajorMilestone silently fell through to FullAuto,
                        // so NO pauses would fire. With the fix, the m-1 milestone (isMajor=true)
                        // triggers a pause.
                        expect(pauseIds).to.include('m-1');
                        expect(pauseIds).to.not.include('m-0');
                });

                it('pauses at a milestone whose steps contain a Create action (even if isMajor=false)', async () => {
                        const plan = makePlan({
                                steps: [
                                        makeStep({ index: 0, action: 'Read', target: 'a.ts' }),
                                        makeStep({ index: 1, action: 'Create', target: 'new-file.ts' }),
                                ],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0, 1], isMajor: false }),
                                ],
                                executionMode: ExecutionMode.MajorMilestone,
                        });

                        let pauseCount = 0;
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => { pauseCount++; return 'resume'; },
                        };

                        await collectEvents(executeMilestonesWithPauses(options));
                        expect(pauseCount).to.equal(1, 'Create action should trigger major-milestone pause');
                });

                it('pauses at a milestone whose steps contain a Run action (even if isMajor=false)', async () => {
                        const plan = makePlan({
                                steps: [
                                        makeStep({ index: 0, action: 'Read', target: 'a.ts' }),
                                        makeStep({ index: 1, action: 'Run', target: 'npm install' }),
                                ],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0, 1], isMajor: false }),
                                ],
                                executionMode: ExecutionMode.MajorMilestone,
                        });

                        let pauseCount = 0;
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => { pauseCount++; return 'resume'; },
                        };

                        await collectEvents(executeMilestonesWithPauses(options));
                        expect(pauseCount).to.equal(1, 'Run action should trigger major-milestone pause');
                });

                it('pauses at a milestone whose steps contain an Edit to a config file (package.json)', async () => {
                        const plan = makePlan({
                                steps: [
                                        makeStep({ index: 0, action: 'Read', target: 'a.ts' }),
                                        makeStep({ index: 1, action: 'Edit', target: 'package.json' }),
                                ],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0, 1], isMajor: false }),
                                ],
                                executionMode: ExecutionMode.MajorMilestone,
                        });

                        let pauseCount = 0;
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => { pauseCount++; return 'resume'; },
                        };

                        await collectEvents(executeMilestonesWithPauses(options));
                        expect(pauseCount).to.equal(1, 'Edit to package.json should trigger major-milestone pause');
                });

                it('does NOT pause at a milestone with only Read + plain Edit (non-config)', async () => {
                        const plan = makePlan({
                                steps: [
                                        makeStep({ index: 0, action: 'Read', target: 'a.ts' }),
                                        makeStep({ index: 1, action: 'Edit', target: 'src/file.ts' }),
                                ],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0, 1], isMajor: false }),
                                ],
                                executionMode: ExecutionMode.MajorMilestone,
                        });

                        let pauseCount = 0;
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => { pauseCount++; return 'resume'; },
                        };

                        await collectEvents(executeMilestonesWithPauses(options));
                        expect(pauseCount).to.equal(0, 'Read + plain Edit should NOT trigger major-milestone pause');
                });
        });

        describe('executeMilestonesWithPauses() — Selective mode', () => {
                it('pauses only at user-selected milestone IDs', async () => {
                        const plan = makePlan({
                                steps: [
                                        makeStep({ index: 0, action: 'Read', target: 'a.ts' }),
                                        makeStep({ index: 1, action: 'Read', target: 'b.ts' }),
                                        makeStep({ index: 2, action: 'Read', target: 'c.ts' }),
                                ],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0] }),
                                        makeMilestone({ id: 'm-1', index: 1, stepIndices: [1] }),
                                        makeMilestone({ id: 'm-2', index: 2, stepIndices: [2] }),
                                ],
                                executionMode: ExecutionMode.Selective,
                                selectedMilestoneIds: ['m-1'], // user wants to pause only at m-1
                        });

                        const pauseIds: string[] = [];
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async (m) => { pauseIds.push(m.id); return 'resume'; },
                        };

                        await collectEvents(executeMilestonesWithPauses(options));
                        expect(pauseIds).to.deep.equal(['m-1']);
                });
        });

        describe('executeMilestonesWithPauses() — verification failure forces pause', () => {
                it('pauses when verification fails, regardless of execution mode', async () => {
                        const plan = makePlan({
                                steps: [makeStep({ index: 0, action: 'Read', target: 'a.ts' })],
                                milestones: [makeMilestone({ id: 'm-0', stepIndices: [0] })],
                                executionMode: ExecutionMode.FullAuto, // even full-auto pauses on verification failure
                        });

                        let pauseCount = 0;
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: false, output: 'FAIL src/test.ts', command: 'npm test' };
                                },
                                awaitResume: async () => { pauseCount++; return 'resume'; },
                        };

                        const events = await collectEvents(executeMilestonesWithPauses(options));
                        expect(pauseCount).to.equal(1);
                        // Also yields a recoverable error event about the verification failure
                        expect(events.some(e => e.type === 'error' && (e as any).text.includes('Verification Failed'))).to.be.true;
                        expect(events.some(e => e.type === 'error' && (e as any).recoverable === true)).to.be.true;
                });
        });

        describe('executeMilestonesWithPauses() — error handling', () => {
                it('aborts plan when executeSubTask yields a fatal (recoverable=false) error', async () => {
                        const plan = makePlan({
                                steps: [makeStep({ index: 0, action: 'Read', target: 'a.ts' })],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0] }),
                                        makeMilestone({ id: 'm-1', index: 1, stepIndices: [0] }),
                                ],
                                executionMode: ExecutionMode.FullAuto,
                        });

                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() {
                                        yield { type: 'error', text: 'LLM is down', recoverable: false };
                                },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => 'resume',
                        };

                        const events = await collectEvents(executeMilestonesWithPauses(options));
                        // First milestone reaches, sub-task yields fatal error → generator returns.
                        // Second milestone should NOT be reached.
                        expect(events.some(e => e.type === 'milestone_reached' && (e as any).milestone.id === 'm-0')).to.be.true;
                        expect(events.some(e => e.type === 'milestone_reached' && (e as any).milestone.id === 'm-1')).to.be.false;
                });

                it('aborts plan when signal.aborted becomes true between milestones', async () => {
                        const ac = new AbortController();
                        const plan = makePlan({
                                steps: [makeStep({ index: 0, action: 'Read' })],
                                milestones: [
                                        makeMilestone({ id: 'm-0', stepIndices: [0] }),
                                        makeMilestone({ id: 'm-1', index: 1, stepIndices: [0] }),
                                ],
                                executionMode: ExecutionMode.FullAuto,
                        });

                        let callCount = 0;
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() {
                                        callCount++;
                                        if (callCount === 1) {
                                                ac.abort(); // abort after the first milestone starts
                                        }
                                        yield { type: 'token', text: 'ok' };
                                },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => 'resume',
                                signal: ac.signal,
                        };

                        const events = await collectEvents(executeMilestonesWithPauses(options));
                        expect(events.some(e => e.type === 'error' && (e as any).text.includes('Stopped by user'))).to.be.true;
                });
        });

        describe('executeMilestonesWithPauses() — empty milestone', () => {
                it('skips milestone with no selected steps without pausing or running sub-task', async () => {
                        const plan = makePlan({
                                steps: [makeStep({ index: 0, action: 'Read', selected: false })], // unselected
                                milestones: [makeMilestone({ id: 'm-0', stepIndices: [0] })],
                                executionMode: ExecutionMode.EveryMilestone,
                        });

                        let subTaskCalled = false;
                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { subTaskCalled = true; yield { type: 'token', text: 'ok' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => 'resume',
                        };

                        const events = await collectEvents(executeMilestonesWithPauses(options));
                        expect(subTaskCalled).to.be.false;
                        expect(events.some(e => e.type === 'milestone_paused')).to.be.false;
                        expect(events.some(e => e.type === 'milestone_completed')).to.be.true;
                });
        });

        describe('executeMilestonesWithPauses() — final complete event', () => {
                it('yields a "complete" event with aggregated summary at the end', async () => {
                        const plan = makePlan({
                                steps: [makeStep({ index: 0, action: 'Read' })],
                                milestones: [makeMilestone({ id: 'm-0', stepIndices: [0] })],
                                executionMode: ExecutionMode.FullAuto,
                        });

                        const options: IMilestoneExecutorOptions = {
                                approvedPlan: plan,
                                async *executeSubTask() { yield { type: 'token', text: 'sub-task output' }; },
                                async *runVerification() {
                                        yield { type: 'verification_result', passed: true, output: '', command: 'npm test' };
                                },
                                awaitResume: async () => 'resume',
                        };

                        const events = await collectEvents(executeMilestonesWithPauses(options));
                        const complete = events.find(e => e.type === 'complete') as { type: 'complete'; summary: string } | undefined;
                        expect(complete).to.exist;
                        expect(complete!.summary).to.contain('sub-task output');
                        expect(complete!.summary).to.contain('Test milestone');
                });
        });
});
