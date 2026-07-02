/**
 * pipelineOrchestrator.ts — Layer 2: Orchestrates the full Idea-to-Execution pipeline.
 *
 * Pipeline phases:
 *   1. Refine — Turn a rough idea into a structured IStructuredSpec
 *   2. Plan — Generate a plan from the spec with cost per milestone
 *   3. Pre-flight — User configures execution options (mode, credit limit, etc.)
 *   4. Execute — Run the approved plan with spec-driven verification
 *   5. Swarm — Optionally parallelize across workers
 *   6. Completion — Verify spec satisfaction, offer "Run it again" v2 flow
 *
 * This orchestrator coordinates between RefinementService, AgentLoopService,
 * SwarmOrchestrator, and the UI (via PipelineEvents).
 */

import type { IStructuredSpec, IPreFlightConfig, PipelineEvent } from '../types/spec';
import type { IApprovedPlan, IMilestone } from '../types/agent';
import type { IConstructAIService } from '../types/llm';
import { RefinementService } from './refinementService';
import { AgentLoopService, type IAgentLoopDeps } from './agentLoop';
import { getSwarmOrchestrator } from '../swarm/orchestrator';
import { getCreditSystem } from '../swarm/costGovernor';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Pipeline State
// ---------------------------------------------------------------------------

export type PipelinePhase =
        | 'idle'
        | 'refining'
        | 'planning'
        | 'preflight'
        | 'executing'
        | 'swarming'
        | 'completing'
        | 'complete'
        | 'error';

export interface IPipelineState {
        readonly phase: PipelinePhase;
        readonly spec: IStructuredSpec | null;
        readonly plan: IApprovedPlan | null;
        readonly preflightConfig: IPreFlightConfig | null;
        readonly completedMilestones: number;
        readonly totalMilestones: number;
        readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Pipeline Orchestrator
// ---------------------------------------------------------------------------

export interface IPipelineOrchestratorDeps {
        aiService: IConstructAIService;
        agentDeps: IAgentLoopDeps;
        workspacePath: string;
}

export class PipelineOrchestrator {
        private readonly _deps: IPipelineOrchestratorDeps;
        private _state: IPipelineState;
        private readonly _listeners: Array<(event: PipelineEvent) => void> = [];
        private _refinementService: RefinementService | null = null;
        private _abortController: AbortController | null = null;

        constructor(deps: IPipelineOrchestratorDeps) {
                this._deps = deps;
                this._state = {
                        phase: 'idle',
                        spec: null,
                        plan: null,
                        preflightConfig: null,
                        completedMilestones: 0,
                        totalMilestones: 0,
                        error: null,
                };
        }

        get state(): IPipelineState {
                return this._state;
        }

        /**
         * Register a listener for pipeline events.
         */
        onEvent(listener: (event: PipelineEvent) => void): void {
                this._listeners.push(listener);
        }

        private _emit(event: PipelineEvent): void {
                for (const listener of this._listeners) {
                        try {
                                listener(event);
                        } catch (err) {
                                logger.warn(`[PipelineOrchestrator] Event listener error: ${err}`);
                        }
                }
        }

        private _transition(phase: PipelinePhase, updates?: Partial<IPipelineState>): void {
                this._state = { ...this._state, phase, ...updates };
                logger.info(`[PipelineOrchestrator] Phase: ${phase}`);
        }

        // -----------------------------------------------------------------------
        // Phase 1: Refine
        // -----------------------------------------------------------------------

        /**
         * Start the refinement phase. Returns the first response from the LLM.
         */
        async startRefinement(rawIdea: string): Promise<string> {
                this._transition('refining');
                this._refinementService = new RefinementService({
                        aiService: this._deps.aiService,
                        workspacePath: this._deps.workspacePath,
                });

                // Forward refinement events
                this._refinementService.onEvent(event => this._emit(event));

                this._abortController = new AbortController();
                const response = await this._refinementService.startRefinement(rawIdea, this._abortController.signal);

                // Update spec from refinement service
                const spec = this._refinementService.getSpec();
                if (spec) {
                        this._state = { ...this._state, spec };
                }

                return response;
        }

        /**
         * Continue refinement with user input.
         */
        async continueRefinement(userInput: string): Promise<string> {
                if (!this._refinementService) {
                        throw new Error('No active refinement. Call startRefinement() first.');
                }

                const response = await this._refinementService.continueRefinement(
                        userInput,
                        this._abortController?.signal,
                );

                const spec = this._refinementService.getSpec();
                if (spec) {
                        this._state = { ...this._state, spec };
                }

                return response;
        }

        /**
         * Approve the spec and move to planning.
         */
        approveSpec(): IStructuredSpec {
                if (!this._refinementService) {
                        throw new Error('No active refinement.');
                }

                const spec = this._refinementService.approveSpec();
                this._state = { ...this._state, spec };
                this._emit({ type: 'spec_approved', spec });
                return spec;
        }

        /**
         * Reject the spec with feedback.
         */
        rejectSpec(feedback: string): void {
                if (!this._refinementService) {
                        throw new Error('No active refinement.');
                }
                this._refinementService.rejectSpec(feedback);
        }

        // -----------------------------------------------------------------------
        // Phase 2: Plan
        // -----------------------------------------------------------------------

        /**
         * Generate a plan from the approved spec.
         * The spec summary + requirements become the task description for planning.
         */
        async generatePlan(): Promise<IApprovedPlan> {
                if (!this._state.spec) {
                        throw new Error('No spec available. Run refinement first.');
                }

                this._transition('planning');

                const spec = this._state.spec;

                // Build the task description from the spec
                const taskDescription = this._buildTaskFromSpec(spec);

                // Run planning phase
                const agentLoop = new AgentLoopService(this._deps.agentDeps);

                try {
                        const planResult = await agentLoop.runPlanningPhase(
                                taskDescription,
                                this._abortController?.signal,
                        );

                        // Extract milestones from the plan
                        const milestones = agentLoop.extractMilestonesFromPlan(planResult.steps);

                        // Build approved plan with spec context
                        const approvedPlan: IApprovedPlan = {
                                task: taskDescription,
                                steps: planResult.steps.map((s, i) => ({
                                        ...s,
                                        index: i,
                                        selected: true,
                                })),
                                executionMode: 'major_milestone',
                                milestones,
                                selectedMilestoneIds: milestones.filter(m => m.isMajor).map(m => m.id),
                                approved: false,
                                approvedAt: 0,
                        };

                        this._state = { ...this._state, plan: approvedPlan };

                        // Calculate estimated credits
                        const estimatedCredits = this._estimateCredits(spec, milestones);

                        this._emit({
                                type: 'plan_ready',
                                spec,
                                milestoneCount: milestones.length,
                                totalSteps: planResult.steps.length,
                                estimatedCredits,
                        });

                        return approvedPlan;
                } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this._transition('error', { error: msg });
                        this._emit({ type: 'pipeline_error', error: msg, recoverable: true });
                        throw err;
                }
        }

        // -----------------------------------------------------------------------
        // Phase 3: Pre-flight
        // -----------------------------------------------------------------------

        /**
         * Configure and validate pre-flight settings.
         */
        configurePreFlight(config: IPreFlightConfig): void {
                if (!this._state.plan) {
                        throw new Error('No plan available. Generate a plan first.');
                }

                this._transition('preflight', { preflightConfig: config });

                // Validate credit limit
                const creditSystem = getCreditSystem();
                if (config.creditLimit > creditSystem.getTotalCredits()) {
                        logger.warn(`[PipelineOrchestrator] Credit limit ${config.creditLimit} exceeds total credits ${creditSystem.getTotalCredits()}`);
                }

                this._emit({ type: 'preflight_configured', config });
        }

        // -----------------------------------------------------------------------
        // Phase 4: Execute
        // -----------------------------------------------------------------------

        /**
         * Execute the plan with the given pre-flight configuration.
         */
        async *executePlan(): AsyncGenerator<PipelineEvent> {
                if (!this._state.plan) {
                        throw new Error('No plan available.');
                }
                if (!this._state.preflightConfig) {
                        throw new Error('No pre-flight configuration. Call configurePreFlight() first.');
                }

                const plan = this._state.plan;
                const config = this._state.preflightConfig;

                // Mark plan as approved
                const approvedPlan: IApprovedPlan = {
                        ...plan,
                        executionMode: config.executionMode,
                        selectedMilestoneIds: config.selectedMilestoneIds,
                        approved: true,
                        approvedAt: Date.now(),
                };

                this._transition('executing', {
                        totalMilestones: approvedPlan.milestones.length,
                });

                this._emit({
                        type: 'execution_started',
                        totalMilestones: approvedPlan.milestones.length,
                });

                // Phase 5: Check if swarm should be used
                if (config.allowSwarm && approvedPlan.milestones.length > 1) {
                        yield* this._executeWithSwarm(approvedPlan, config);
                } else {
                        yield* this._executeSingleAgent(approvedPlan, config);
                }
        }

        /**
         * Execute with a single agent (no swarm).
         */
        private async *_executeSingleAgent(
                plan: IApprovedPlan,
                config: IPreFlightConfig,
        ): AsyncGenerator<PipelineEvent> {
                const agentLoop = new AgentLoopService(this._deps.agentDeps);
                const signal = config.signal ?? this._abortController?.signal ?? new AbortController().signal;
                let completedMilestones = 0;

                try {
                        const stream = agentLoop.runWithApprovedPlan(plan, signal);
                        for await (const event of stream) {
                                // Track milestone progress
                                if (event.type === 'milestone_completed') {
                                        completedMilestones++;
                                        this._state = { ...this._state, completedMilestones };
                                        yield {
                                                type: 'milestone_progress',
                                                completedMilestones,
                                                totalMilestones: plan.milestones.length,
                                                currentMilestone: event.milestone.name,
                                        };
                                }

                                // Check credit limit
                                if (config.creditLimit > 0) {
                                        const creditSystem = getCreditSystem();
                                        if (creditSystem.getCreditsRemaining() <= 0) {
                                                this._emit({
                                                        type: 'pipeline_error',
                                                        error: 'Credit limit reached. Execution paused.',
                                                        recoverable: true,
                                                });
                                                break;
                                        }
                                }
                        }
                } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this._transition('error', { error: msg });
                        yield { type: 'pipeline_error', error: msg, recoverable: true };
                        return;
                }

                // Phase 6: Completion
                yield* this._completeExecution();
        }

        /**
         * Execute with swarm (parallel workers).
         */
        private async *_executeWithSwarm(
                plan: IApprovedPlan,
                config: IPreFlightConfig,
        ): AsyncGenerator<PipelineEvent> {
                this._transition('swarming');

                const swarm = getSwarmOrchestrator(this._deps.aiService);

                try {
                        const stream = swarm.execute(plan, this._deps.agentDeps, {
                                maxWorkers: config.maxWorkers,
                                requirePartitionApproval: false, // Already approved in pre-flight
                                signal: config.signal ?? this._abortController?.signal,
                        });

                        for await (const event of stream) {
                                if (event.type === 'swarm_partition_ready') {
                                        yield { type: 'swarm_started', workerCount: event.partition.subPlans.length };
                                } else if (event.type === 'swarm_worker_started') {
                                        yield {
                                                type: 'swarm_worker_update',
                                                agentId: event.agentId,
                                                agentName: event.agentName,
                                                status: 'running',
                                        };
                                } else if (event.type === 'swarm_worker_completed') {
                                        yield {
                                                type: 'swarm_worker_update',
                                                agentId: event.agentId,
                                                agentName: event.agentId, // Use agentId as name (worker_completed doesn't carry agentName)
                                                status: event.success ? 'completed' : 'failed',
                                        };
                                        // Update milestone progress
                                        const completed = this._state.completedMilestones + 1;
                                        this._state = { ...this._state, completedMilestones: completed };
                                        yield {
                                                type: 'milestone_progress',
                                                completedMilestones: completed,
                                                totalMilestones: this._state.totalMilestones,
                                                currentMilestone: event.agentId,
                                        };
                                } else if (event.type === 'swarm_completed') {
                                        logger.info(`[PipelineOrchestrator] Swarm completed: ${event.summary}`);
                                } else if (event.type === 'swarm_error') {
                                        yield { type: 'pipeline_error', error: event.error, recoverable: true };
                                }
                        }
                } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this._transition('error', { error: msg });
                        yield { type: 'pipeline_error', error: msg, recoverable: true };
                        return;
                }

                // Phase 6: Completion
                yield* this._completeExecution();
        }

        // -----------------------------------------------------------------------
        // Phase 6: Completion
        // -----------------------------------------------------------------------

        /**
         * Finalize execution: check spec satisfaction, emit completion event.
         */
        private async *_completeExecution(): AsyncGenerator<PipelineEvent> {
                this._transition('completing');

                const spec = this._state.spec;
                if (!spec) {
                        this._transition('complete');
                        yield {
                                type: 'execution_complete',
                                spec: null as unknown as IStructuredSpec,
                                allRequirementsMet: false,
                        };
                        return;
                }

                // Check which requirements are satisfied
                const unsatisfied = spec.requirements.filter(r => !r.satisfied);
                const allMet = unsatisfied.length === 0;

                this._transition('complete');

                yield {
                        type: 'execution_complete',
                        spec,
                        allRequirementsMet: allMet,
                };

                // If not all requirements met, emit v2 prompt
                if (!allMet) {
                        yield {
                                type: 'v2_prompt',
                                spec,
                                unsatisfiedRequirements: unsatisfied,
                        };
                }
        }

        /**
         * Start a v2 refinement based on execution results.
         * The user can refine the spec based on what worked and what didn't.
         */
        async startV2Refinement(v2Feedback: string): Promise<string> {
                if (!this._state.spec) {
                        throw new Error('No previous spec for v2 refinement.');
                }

                // Reset state but keep the spec for context
                const previousSpec = this._state.spec;
                this._transition('refining');

                this._refinementService = new RefinementService({
                        aiService: this._deps.aiService,
                        workspacePath: this._deps.workspacePath,
                });
                this._refinementService.onEvent(event => this._emit(event));

                // Set the previous spec as context
                this._refinementService.setSpec(previousSpec);

                this._abortController = new AbortController();

                const v2Input = `V2 Refinement Request:\n\nPrevious spec: ${previousSpec.name} (v${previousSpec.version})\n\nFeedback from execution:\n${v2Feedback}\n\nUnsatisfied requirements:\n${previousSpec.requirements.filter(r => !r.satisfied).map(r => `- [${r.priority}] ${r.label}: ${r.description}`).join('\n')}\n\nPlease update the spec based on this feedback.`;

                const response = await this._refinementService.startRefinement(
                        v2Input,
                        this._abortController.signal,
                );

                const spec = this._refinementService.getSpec();
                if (spec) {
                        this._state = { ...this._state, spec };
                }

                return response;
        }

        // -----------------------------------------------------------------------
        // Utility
        // -----------------------------------------------------------------------

        /**
         * Build a task description from the spec for the planning phase.
         */
        private _buildTaskFromSpec(spec: IStructuredSpec): string {
                const lines: string[] = [];

                lines.push(`Feature: ${spec.name}`);
                lines.push(`\nSummary: ${spec.summary}`);
                lines.push(`\nRequirements:`);

                for (const req of spec.requirements) {
                        const prefix = req.priority === 'must' ? 'MUST' : req.priority === 'should' ? 'SHOULD' : 'COULD';
                        lines.push(`  [${prefix}] [${req.category}] ${req.label}: ${req.description}`);
                }

                if (spec.assumptions.length > 0) {
                        lines.push(`\nAssumptions: ${spec.assumptions.join('; ')}`);
                }

                if (spec.outOfScope.length > 0) {
                        lines.push(`\nOut of scope: ${spec.outOfScope.join('; ')}`);
                }

                lines.push(`\nSuggested approach: ${spec.suggestedApproach}`);
                lines.push(`\nComplexity: ${spec.complexity}`);

                return lines.join('\n');
        }

        /**
         * Estimate credits based on spec complexity and milestone count.
         */
        private _estimateCredits(spec: IStructuredSpec, milestones: IMilestone[]): number {
                const baseCredits = spec.complexity === 'small' ? 30 : spec.complexity === 'medium' ? 80 : 200;
                const milestoneMultiplier = 1 + (milestones.length * 0.15);
                const reqMultiplier = 1 + (spec.requirements.filter(r => r.priority === 'must').length * 0.1);
                return Math.ceil(baseCredits * milestoneMultiplier * reqMultiplier);
        }

        /**
         * Abort the current pipeline execution.
         */
        abort(): void {
                if (this._abortController) {
                        this._abortController.abort();
                }
                this._transition('idle');
        }

        /**
         * Reset the pipeline to idle state.
         */
        reset(): void {
                this._abortController?.abort();
                this._state = {
                        phase: 'idle',
                        spec: null,
                        plan: null,
                        preflightConfig: null,
                        completedMilestones: 0,
                        totalMilestones: 0,
                        error: null,
                };
                this._refinementService = null;
                this._abortController = null;
        }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _pipeline: PipelineOrchestrator | undefined;

export function getPipelineOrchestrator(deps: IPipelineOrchestratorDeps): PipelineOrchestrator {
        if (!_pipeline) {
                _pipeline = new PipelineOrchestrator(deps);
        }
        return _pipeline;
}

export function resetPipelineOrchestrator(): void {
        _pipeline = undefined;
}
