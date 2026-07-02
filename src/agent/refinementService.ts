/**
 * refinementService.ts — Layer 2: Idea Refinement conversational service.
 *
 * Implements the Refine phase of the Idea-to-Execution pipeline.
 * The service conducts a structured conversation with the user to turn
 * a rough idea into a formal IStructuredSpec.
 *
 * Design:
 *   - Phase 1 (gathering): Ask high-level questions about the idea.
 *   - Phase 2 (clarifying): Drill into ambiguous areas.
 *   - Phase 3 (structuring): Build the spec from gathered info.
 *   - Phase 4 (finalizing): Present spec for user approval.
 *   - Phase 5 (complete): Spec approved, ready for planning.
 *
 * The refinement uses the LLM in a conversational loop but with a
 * specialized system prompt that guides the model to ask structured
 * questions rather than jumping to implementation.
 */

import type { IStructuredSpec, ISpecRequirement, IRefinementState, PipelineEvent } from '../types/spec';
import type { IConstructAIService } from '../types/llm';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum refinement rounds before forcing finalization. */
const MAX_REFINEMENT_ROUNDS = 8;

// ---------------------------------------------------------------------------
// Refinement system prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for Refine mode.
 * This prompt guides the LLM to act as a specification writer,
 * NOT an implementer. The key discipline is: ask questions, don't code.
 */
export function buildRefinementPrompt(options: {
	workspacePath: string;
	existingSpec?: IStructuredSpec | null;
	round: number;
}): string {
	const { workspacePath, existingSpec, round } = options;
	const date = new Date().toISOString().split('T')[0];

	let specContext = '';
	if (existingSpec) {
		specContext = `\n\n[Current Spec — Version ${existingSpec.version}]\n` +
			`Name: ${existingSpec.name}\n` +
			`Summary: ${existingSpec.summary}\n` +
			`Requirements:\n${existingSpec.requirements.map(r =>
				`  [${r.priority.toUpperCase()}] ${r.id}: ${r.label} — ${r.description}`
			).join('\n')}\n` +
			`Assumptions: ${existingSpec.assumptions.join('; ') || '(none)'}\n` +
			`Out of scope: ${existingSpec.outOfScope.join('; ') || '(none)'}\n` +
			`Suggested approach: ${existingSpec.suggestedApproach}\n` +
			`Complexity: ${existingSpec.complexity}`;
	}

	return `You are a Specification Writer for Kovix. Your job is to help the user refine a rough idea into a structured, actionable specification.

Working directory: ${workspacePath}
Current date: ${date}
Refinement round: ${round}/${MAX_REFINEMENT_ROUNDS}

CRITICAL RULES:
1. You are in REFINE mode. Do NOT write code, do NOT implement anything.
2. Your goal is to ASK QUESTIONS and BUILD A SPEC, not to solve the problem.
3. After each round, output a SPEC UPDATE block with the current state of the spec.
4. Structure your questions to fill gaps in the spec: requirements, constraints, priorities.
5. When the spec is sufficiently detailed, say "SPEC READY FOR APPROVAL" and present the final spec.

SPEC FORMAT (output at the end of each response):
\`\`\`
---SPEC---
Name: [short name]
Summary: [one paragraph]
Requirements:
  [MUST|SHOULD|COULD] [category] [label]: [description]
Assumptions: [list]
Out of scope: [list]
Suggested approach: [paragraph]
Complexity: [small|medium|large]
---END SPEC---
\`\`\`

REFINEMENT STRATEGY:
- Round 1-2: Gather the big picture — what is this? who is it for? what does success look like?
- Round 3-4: Clarify specifics — what are the must-haves? what are the edge cases?
- Round 5-6: Structure — organize into requirements, identify assumptions, mark out-of-scope
- Round 7-8: Finalize — confirm all areas are covered, present for approval

If the user's idea is already clear and detailed, you can fast-track to SPEC READY.
If the user provides a v2 refinement request, update the spec and present for re-approval.
${specContext}`;
}

// ---------------------------------------------------------------------------
// Spec parser
// ---------------------------------------------------------------------------

/**
 * Parse the spec block from the LLM's response.
 * Extracts the structured spec from between ---SPEC--- and ---END SPEC--- markers.
 */
export function parseSpecFromResponse(response: string, rawIdea: string, previousSpec?: IStructuredSpec | null): IStructuredSpec | null {
	const specMatch = response.match(/---SPEC---\n([\s\S]*?)---END SPEC---/);
	if (!specMatch) return null;

	const specText = specMatch[1];
	const version = previousSpec ? previousSpec.version + 1 : 1;

	// Parse name
	const nameMatch = specText.match(/Name:\s*(.+)/);
	const name = nameMatch ? nameMatch[1].trim() : 'Untitled Idea';

	// Parse summary
	const summaryMatch = specText.match(/Summary:\s*(.+)/);
	const summary = summaryMatch ? summaryMatch[1].trim() : rawIdea.slice(0, 200);

	// Parse requirements
	const requirements: ISpecRequirement[] = [];
	const reqRegex = /\[(MUST|SHOULD|COULD)\]\s*\[?(\w+)\]?\s*(\S+):\s*(.+)/g;
	let reqMatch: RegExpExecArray | null;
	let reqIndex = 0;
	while ((reqMatch = reqRegex.exec(specText)) !== null) {
		reqIndex++;
		requirements.push({
			id: `req-${reqIndex}`,
			label: reqMatch[3].trim(),
			description: reqMatch[4].trim(),
			priority: reqMatch[1].toLowerCase() as ISpecRequirement['priority'],
			category: reqMatch[2].trim().toLowerCase(),
			satisfied: false,
		});
	}

	// Parse assumptions
	const assumptionsMatch = specText.match(/Assumptions:\s*(.+)/);
	const assumptions = assumptionsMatch
		? assumptionsMatch[1].split(';').map(a => a.trim()).filter(Boolean)
		: [];

	// Parse out of scope
	const outOfScopeMatch = specText.match(/Out of scope:\s*(.+)/);
	const outOfScope = outOfScopeMatch
		? outOfScopeMatch[1].split(';').map(a => a.trim()).filter(Boolean)
		: [];

	// Parse suggested approach
	const approachMatch = specText.match(/Suggested approach:\s*([\s\S]*?)(?:\nComplexity:|$)/);
	const suggestedApproach = approachMatch ? approachMatch[1].trim() : '';

	// Parse complexity
	const complexityMatch = specText.match(/Complexity:\s*(small|medium|large)/);
	const complexity = complexityMatch ? complexityMatch[1] as IStructuredSpec['complexity'] : 'medium';

	// Estimate credits based on complexity
	const creditEstimate = complexity === 'small' ? 50 : complexity === 'medium' ? 150 : 300;

	return {
		id: previousSpec?.id ?? `spec-${Date.now()}`,
		name,
		summary,
		rawIdea,
		requirements,
		assumptions,
		outOfScope,
		suggestedApproach,
		complexity,
		estimatedCredits: creditEstimate,
		createdAt: Date.now(),
		version,
	};
}

// ---------------------------------------------------------------------------
// Check if spec is ready for approval
// ---------------------------------------------------------------------------

/**
 * Check if the LLM response indicates the spec is ready for approval.
 */
export function isSpecReadyForApproval(response: string): boolean {
	return /SPEC READY FOR APPROVAL/i.test(response);
}

// ---------------------------------------------------------------------------
// Refinement Service
// ---------------------------------------------------------------------------

export interface IRefinementServiceDeps {
	aiService: IConstructAIService;
	workspacePath: string;
}

export class RefinementService {
	private readonly _deps: IRefinementServiceDeps;
	private _state: IRefinementState;
	private readonly _eventListeners: Array<(event: PipelineEvent) => void> = [];
	private _conversationHistory: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

	constructor(deps: IRefinementServiceDeps) {
		this._deps = deps;
		this._state = {
			phase: 'gathering',
			exploredAreas: [],
			openQuestions: [],
			rounds: 0,
			spec: null,
			approved: false,
		};
	}

	get state(): IRefinementState {
		return this._state;
	}

	get isComplete(): boolean {
		return this._state.phase === 'complete' && this._state.approved;
	}

	/**
	 * Register a listener for pipeline events.
	 */
	onEvent(listener: (event: PipelineEvent) => void): void {
		this._eventListeners.push(listener);
	}

	private _emit(event: PipelineEvent): void {
		for (const listener of this._eventListeners) {
			try {
				listener(event);
			} catch (err) {
				logger.warn(`[RefinementService] Event listener error: ${err}`);
			}
		}
	}

	/**
	 * Start the refinement process with a raw idea.
	 */
	async startRefinement(rawIdea: string, signal?: AbortSignal): Promise<string> {
		this._state = {
			phase: 'gathering',
			exploredAreas: [],
			openQuestions: [],
			rounds: 0,
			spec: null,
			approved: false,
		};

		this._emit({ type: 'refinement_started', rawIdea });

		// First round: ask the LLM to start refining
		const response = await this._runRound(rawIdea, signal);

		// Check if spec was produced
		const spec = parseSpecFromResponse(response, rawIdea, null);
		if (spec) {
			this._state.spec = spec;
			this._emit({ type: 'spec_updated', spec });
		}

		// Check if already ready (fast-track)
		if (isSpecReadyForApproval(response)) {
			this._state.phase = 'finalizing';
			this._emit({ type: 'spec_updated', spec: this._state.spec! });
		} else {
			this._state.phase = 'clarifying';
			this._emit({ type: 'refinement_round', round: 1, question: response });
		}

		return response;
	}

	/**
	 * Continue refinement with user input.
	 */
	async continueRefinement(userInput: string, signal?: AbortSignal): Promise<string> {
		if (this._state.approved) {
			throw new Error('Spec already approved. Start a new refinement or use v2 prompt.');
		}

		this._state.rounds++;

		// Check if we've exceeded max rounds
		if (this._state.rounds >= MAX_REFINEMENT_ROUNDS) {
			this._state.phase = 'finalizing';
			if (this._state.spec) {
				this._emit({ type: 'spec_updated', spec: this._state.spec });
			}
			return 'Maximum refinement rounds reached. Please approve the current spec or provide final adjustments.';
		}

		const response = await this._runRound(userInput, signal);

		// Parse spec from response
		const spec = parseSpecFromResponse(response, this._state.spec?.rawIdea ?? userInput, this._state.spec);
		if (spec) {
			this._state.spec = spec;
			this._emit({ type: 'spec_updated', spec });
		}

		// Check if ready for approval
		if (isSpecReadyForApproval(response)) {
			this._state.phase = 'finalizing';
		} else if (this._state.rounds >= 4) {
			// After 4 rounds, move to structuring phase
			this._state.phase = 'structuring';
		}

		this._emit({ type: 'refinement_round', round: this._state.rounds + 1, question: response });
		return response;
	}

	/**
	 * Approve the current spec and move to the planning phase.
	 */
	approveSpec(): IStructuredSpec {
		if (!this._state.spec) {
			throw new Error('No spec to approve. Run refinement first.');
		}

		this._state.approved = true;
		this._state.phase = 'complete';

		this._emit({ type: 'spec_approved', spec: this._state.spec });
		return this._state.spec;
	}

	/**
	 * Reject the spec and provide feedback for re-refinement.
	 */
	rejectSpec(feedback: string): void {
		this._state.approved = false;
		this._state.phase = 'clarifying';
		logger.info(`[RefinementService] Spec rejected with feedback: ${feedback}`);
	}

	/**
	 * Get the current spec (if any).
	 */
	getSpec(): IStructuredSpec | null {
		return this._state.spec;
	}

	/**
	 * Set the spec directly (used for v2 refinement with existing spec).
	 */
	setSpec(spec: IStructuredSpec): void {
		this._state.spec = spec;
		this._state.phase = 'clarifying';
	}

	/**
	 * Reset the refinement state for a new idea.
	 */
	reset(): void {
		this._state = {
			phase: 'gathering',
			exploredAreas: [],
			openQuestions: [],
			rounds: 0,
			spec: null,
			approved: false,
		};
		this._conversationHistory = [];
	}

	/**
	 * Run a single refinement round against the LLM.
	 * Uses the streaming chat API and accumulates the response.
	 */
	private async _runRound(userInput: string, signal?: AbortSignal): Promise<string> {
		const systemPrompt = buildRefinementPrompt({
			workspacePath: this._deps.workspacePath,
			existingSpec: this._state.spec,
			round: this._state.rounds + 1,
		});

		try {
			// Update conversation history
			if (this._conversationHistory.length === 0) {
				this._conversationHistory.push({ role: 'system', content: systemPrompt });
			} else {
				// Update system prompt for this round
				this._conversationHistory[0] = { role: 'system', content: systemPrompt };
			}
			this._conversationHistory.push({ role: 'user', content: userInput });

			// Stream the response using the AI service
			const stream = this._deps.aiService.chat(
				this._conversationHistory.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
				[], // No tools in refine mode — pure conversation
				{ signal },
			);

			// Accumulate the response
			let fullResponse = '';
			for await (const event of stream) {
				if (event.type === 'token') {
					fullResponse += event.text;
				} else if (event.type === 'error') {
					throw new Error(event.text);
				}
			}

			// Add assistant response to history
			this._conversationHistory.push({ role: 'assistant', content: fullResponse });

			return fullResponse;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._emit({ type: 'pipeline_error', error: msg, recoverable: true });
			throw err;
		}
	}
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _refinementService: RefinementService | undefined;

export function getRefinementService(deps: IRefinementServiceDeps): RefinementService {
	if (!_refinementService) {
		_refinementService = new RefinementService(deps);
	}
	return _refinementService;
}

export function resetRefinementService(): void {
	_refinementService = undefined;
}
