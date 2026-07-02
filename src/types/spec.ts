/**
 * spec.ts — Layer 1 type definitions for the Idea Refinement pipeline.
 *
 * Defines the structured spec that emerges from Refine mode, flows into
 * Planning, and serves as the verification checklist at Completion.
 *
 * Pipeline: Refine → Plan → Pre-flight → Execute → Swarm → Completion
 * Each phase consumes and extends the spec, adding richer structure.
 */

// ---------------------------------------------------------------------------
// Spec Requirement
// ---------------------------------------------------------------------------

/**
 * A single requirement extracted during refinement.
 * Each requirement has a unique ID for traceability through the pipeline.
 */
export interface ISpecRequirement {
        /** Unique identifier (e.g., "req-1", "req-2"). */
        readonly id: string;
        /** Short human-readable label. */
        readonly label: string;
        /** Detailed description of what this requirement means. */
        readonly description: string;
        /** Priority: must-have vs nice-to-have. */
        readonly priority: 'must' | 'should' | 'could';
        /** Category grouping (e.g., "core", "ui", "api", "performance"). */
        readonly category: string;
        /** Whether this requirement has been satisfied (set during/after execution). */
        satisfied: boolean;
        /** Evidence of satisfaction (e.g., "tests pass", "file created"). */
        satisfactionEvidence?: string;
}

// ---------------------------------------------------------------------------
// Structured Spec
// ---------------------------------------------------------------------------

/**
 * The full structured specification produced by Refine mode.
 * This is the central artifact of the idea-to-execution pipeline.
 */
export interface IStructuredSpec {
        /** Unique spec ID. */
        readonly id: string;
        /** Short project/feature name. */
        readonly name: string;
        /** One-paragraph summary of the idea. */
        readonly summary: string;
        /** The original raw idea text from the user. */
        readonly rawIdea: string;
        /** Extracted requirements. */
        readonly requirements: ISpecRequirement[];
        /** Key assumptions made during refinement. */
        readonly assumptions: string[];
        /** Out-of-scope items explicitly excluded. */
        readonly outOfScope: string[];
        /** Suggested tech stack or approach. */
        readonly suggestedApproach: string;
        /** Estimated complexity: small/medium/large. */
        readonly complexity: 'small' | 'medium' | 'large';
        /** Estimated credit cost for full execution. */
        readonly estimatedCredits: number;
        /** Timestamp when spec was finalized. */
        readonly createdAt: number;
        /** Version for iterative refinement (v1, v2, etc.). */
        readonly version: number;
}

// ---------------------------------------------------------------------------
// Refinement State
// ---------------------------------------------------------------------------

/**
 * The state of the refinement conversation.
 * Tracks which areas have been explored and what's still open.
 */
export interface IRefinementState {
        /** Current phase of refinement. */
        phase: 'gathering' | 'clarifying' | 'structuring' | 'finalizing' | 'complete';
        /** Areas that have been explored with the user. */
        exploredAreas: string[];
        /** Open questions still to resolve. */
        openQuestions: string[];
        /** Number of refinement rounds so far. */
        rounds: number;
        /** The evolving spec (updated each round). */
        spec: IStructuredSpec | null;
        /** Whether the user has approved the spec. */
        approved: boolean;
}

// ---------------------------------------------------------------------------
// Pre-flight Config
// ---------------------------------------------------------------------------

/**
 * Execution configuration set by the user after reviewing the plan.
 * This is the "pre-flight checklist" before execution starts.
 */
export interface IPreFlightConfig {
        /** Which execution mode to use. */
        readonly executionMode: 'every_milestone' | 'major_milestone' | 'selective' | 'full_auto';
        /** Credit spending limit for this run. */
        readonly creditLimit: number;
        /** Whether to run verification after each milestone. */
        readonly verifyAfterMilestone: boolean;
        /** Whether to allow swarm (parallel workers). */
        readonly allowSwarm: boolean;
        /** Max parallel workers if swarm is allowed. */
        readonly maxWorkers: number;
        /** Milestone IDs selected for selective mode. */
        readonly selectedMilestoneIds: string[];
        /** Abort signal from the UI. */
        signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Pipeline Event
// ---------------------------------------------------------------------------

/**
 * Events emitted by the idea-to-execution pipeline.
 * These flow to the UI for rendering spec cards, progress bars, etc.
 */
export type PipelineEvent =
        | { type: 'refinement_started'; rawIdea: string }
        | { type: 'refinement_round'; round: number; question: string }
        | { type: 'spec_updated'; spec: IStructuredSpec }
        | { type: 'spec_approved'; spec: IStructuredSpec }
        | { type: 'plan_ready'; spec: IStructuredSpec; milestoneCount: number; totalSteps: number; estimatedCredits: number }
        | { type: 'preflight_configured'; config: IPreFlightConfig }
        | { type: 'execution_started'; totalMilestones: number }
        | { type: 'milestone_progress'; completedMilestones: number; totalMilestones: number; currentMilestone: string }
        | { type: 'swarm_started'; workerCount: number }
        | { type: 'swarm_worker_update'; agentId: string; agentName: string; status: 'running' | 'completed' | 'failed' }
        | { type: 'execution_complete'; spec: IStructuredSpec; allRequirementsMet: boolean }
        | { type: 'v2_prompt'; spec: IStructuredSpec; unsatisfiedRequirements: ISpecRequirement[] }
        | { type: 'pipeline_error'; error: string; recoverable: boolean };

// ---------------------------------------------------------------------------
// Agent Mode
// ---------------------------------------------------------------------------

/**
 * The mode the agent is operating in.
 * 'refine' is the new mode for idea refinement.
 */
export type AgentMode = 'chat' | 'plan' | 'refine';
