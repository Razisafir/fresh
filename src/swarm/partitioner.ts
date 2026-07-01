/**
 * partitioner.ts — LLM-based plan partitioning for the swarm orchestrator.
 *
 * Implements Option C from 08_SWARM_DESIGN.md §3.1: the lead agent runs the
 * existing Plan → Approve loop. After approval, the partitioner takes the
 * approved plan and asks the LLM to partition it into independent sub-plans.
 * The partition is shown to the user as a "swarm plan" card — the user
 * approves the partition before any workers spawn.
 */

import type { IChatMessage, IToolDefinition } from '../types/llm';
import type { IApprovedPlan, ISelectablePlanStep } from '../types/agent';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ISubPlan {
	/** Unique worker identifier (e.g. "worker-1", "auth-google"). */
	agentId: string;
	/** Human-readable name for the UI. */
	agentName: string;
	/** Steps from the original plan assigned to this worker. */
	steps: ISelectablePlanStep[];
	/** File paths this worker will touch (for lock pre-acquisition). */
	filesTouched: string[];
	/** One-line description of what this worker does. */
	description: string;
}

export interface IPartitionResult {
	/** The sub-plans (one per worker). */
	subPlans: ISubPlan[];
	/** Whether the partitioner recommends swarm (true) or single-agent (false). */
	shouldSwarm: boolean;
	/** Reasoning for the recommendation. */
	reasoning: string;
}

export interface IPartitionerDeps {
	aiService: {
		chat(
			messages: IChatMessage[],
			tools: IToolDefinition[],
			options?: { signal?: AbortSignal; systemPrompt?: string; maxTokens?: number; temperature?: number },
		): AsyncIterable<{ type: 'token'; text: string } | { type: 'tool_start'; toolId: string; toolName: string; toolInput?: unknown } | { type: 'tool_input'; toolId: string; text: string } | { type: 'tool_end'; toolId: string; toolName: string; toolInput: unknown } | { type: 'done'; stopReason: string } | { type: 'error'; text: string }>;
	};
}

// ---------------------------------------------------------------------------
// Partition prompt
// ---------------------------------------------------------------------------

const PARTITION_SYSTEM_PROMPT = `You are a task partitioning agent for Kovix. Your job is to analyze a software development plan and determine whether it can be broken into independent sub-tasks that can run in parallel.

## Rules

1. **Independence**: Two sub-tasks are independent if they do NOT share writable files. Read-only overlap is fine.
2. **Minimum size**: Each sub-plan must have at least 1 step. Don't create empty workers.
3. **Maximum workers**: At most 4 workers. If there are more than 4 natural partitions, group related ones together.
4. **File extraction**: For each step, identify any file paths that will be written or edited. Use the step description and target field.
5. **Conservative**: If tasks are tightly coupled (shared mutable state, sequential dependencies), recommend single-agent mode.

## Output format

Respond with ONLY a JSON object (no markdown, no code fences):

{
  "shouldSwarm": true/false,
  "reasoning": "Brief explanation of why swarm is or isn't recommended",
  "subPlans": [
    {
      "agentId": "worker-1",
      "agentName": "descriptive-name",
      "stepIndices": [0, 1, 2],
      "filesTouched": ["path/to/file1.ts", "path/to/file2.ts"],
      "description": "What this worker will do"
    }
  ]
}

The stepIndices refer to the original plan steps by their 0-based index.
If shouldSwarm is false, return an empty subPlans array.`;

// ---------------------------------------------------------------------------
// Partitioner
// ---------------------------------------------------------------------------

export class Partitioner {
	constructor(private readonly _deps: IPartitionerDeps) {}

	async partition(
		plan: IApprovedPlan,
		options?: { signal?: AbortSignal },
	): Promise<IPartitionResult> {
		if (plan.steps.length < 3) {
			return {
				shouldSwarm: false,
				reasoning: `Plan has only ${plan.steps.length} steps — not enough to benefit from parallelisation.`,
				subPlans: [],
			};
		}

		const planDescription = plan.steps
			.map((step, i) => `[${i}] ${step.action}: ${step.target} — ${step.description}`)
			.join('\n');

		const userMessage: IChatMessage = {
			role: 'user',
			content: `Analyze this development plan and partition it into independent sub-tasks for parallel execution:\n\n${planDescription}`,
		};

		let responseText = '';
		try {
			const stream = this._deps.aiService.chat(
				[{ role: 'system', content: PARTITION_SYSTEM_PROMPT }, userMessage],
				[],
				{
					signal: options?.signal,
					systemPrompt: PARTITION_SYSTEM_PROMPT,
					maxTokens: 2048,
					temperature: 0.3,
				},
			);

			for await (const chunk of stream) {
				if (chunk.type === 'token') {
					responseText += chunk.text;
				} else if (chunk.type === 'error') {
					throw new Error(`Partition LLM error: ${chunk.text}`);
				}
			}
		} catch (err) {
			logger.warn(`[Partitioner] LLM call failed, falling back to single-agent: ${err instanceof Error ? err.message : String(err)}`);
			return {
				shouldSwarm: false,
				reasoning: `Partitioning LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
				subPlans: [],
			};
		}

		return this._parsePartitionResponse(responseText, plan);
	}

	private _parsePartitionResponse(text: string, plan: IApprovedPlan): IPartitionResult {
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			logger.warn('[Partitioner] No JSON object found in LLM response, falling back to single-agent');
			return { shouldSwarm: false, reasoning: 'Could not parse partition response as JSON.', subPlans: [] };
		}

		try {
			const parsed = JSON.parse(jsonMatch[0]);

			if (!parsed.shouldSwarm) {
				return { shouldSwarm: false, reasoning: parsed.reasoning ?? 'LLM recommended single-agent mode.', subPlans: [] };
			}

			if (!Array.isArray(parsed.subPlans) || parsed.subPlans.length === 0) {
				return { shouldSwarm: false, reasoning: 'LLM returned shouldSwarm=true but no sub-plans.', subPlans: [] };
			}

			const subPlans: ISubPlan[] = parsed.subPlans.map((sp: { agentId?: string; agentName?: string; stepIndices?: number[]; filesTouched?: string[]; description?: string }) => ({
				agentId: sp.agentId || `worker-${Math.random().toString(36).slice(2, 6)}`,
				agentName: sp.agentName || 'unnamed-worker',
				steps: (sp.stepIndices ?? [])
					.filter((idx: number) => idx >= 0 && idx < plan.steps.length)
					.map((idx: number) => plan.steps[idx]),
				filesTouched: (sp.filesTouched ?? []).map((f: string) => f),
				description: sp.description || '',
			}));

			// Check for unassigned steps and add to first worker
			const assignedIndices = new Set<number>();
			for (const sp of parsed.subPlans) {
				for (const idx of (sp.stepIndices ?? [])) {
					assignedIndices.add(idx);
				}
			}
			for (let i = 0; i < plan.steps.length; i++) {
				if (!assignedIndices.has(i) && subPlans.length > 0) {
					subPlans[0].steps.push(plan.steps[i]);
				}
			}

			const validSubPlans = subPlans.filter(sp => sp.steps.length > 0);
			if (validSubPlans.length <= 1) {
				return { shouldSwarm: false, reasoning: 'After parsing, only 1 worker has steps.', subPlans: [] };
			}

			return {
				shouldSwarm: true,
				reasoning: parsed.reasoning ?? `Partitioned into ${validSubPlans.length} workers.`,
				subPlans: validSubPlans,
			};
		} catch (err) {
			logger.warn(`[Partitioner] JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
			return { shouldSwarm: false, reasoning: `Failed to parse partition JSON.`, subPlans: [] };
		}
	}
}
