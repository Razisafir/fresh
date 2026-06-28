/**
 * modelRouting.ts — Model routing by purpose (pure-logic, zero dependencies).
 *
 * Reimplemented from Kovix_2.0's modelRouting.ts (originally on
 * recovery/audit-tier1-patches branch, ~250 LOC). The original branch
 * no longer exists in the remote, so this is a fresh implementation
 * based on the HARVEST_CANDIDATES.md description:
 *
 *   "Solves a real design flaw: currently every AI operation uses the
 *    same active model (e.g. Claude Sonnet 4 for autocomplete, which
 *    is wasteful). This adds ModelPurpose type and a routing decision
 *    function that maps purpose to appropriate model. Pure-logic file
 *    with no VS Code imports — fully unit-testable."
 *
 * Design decisions:
 *   - ModelPurpose enum covers all identified AI operation types in Kovix
 *   - routeModel() returns a model string based on purpose + provider
 *   - Routing table is configurable (callers can override defaults)
 *   - Provider-specific routing: Anthropic, NVIDIA NIM, and OpenRouter
 *     have different model families and cost/quality tradeoffs
 *
 * Migration log entry: docs/03_MIGRATION_LOG.md — see "Harvest-1: modelRouting.ts"
 *
 * Decisions referenced: D-001 (file-by-file audit), harvest plan Step 2.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The purpose for which an LLM call is being made. Different purposes
 * have different quality/speed/cost requirements:
 *
 *   - `autocomplete`: needs speed (sub-200ms), can tolerate lower quality
 *   - `inline_edit`: needs speed + moderate quality (Cmd+K style edits)
 *   - `agent_plan`: needs high quality reasoning (plan generation)
 *   - `agent_execute`: needs quality + tool-use capability (plan execution)
 *   - `chat`: general conversation — moderate quality, moderate speed
 *   - `embedding`: not an LLM call, but included for routing completeness
 *   - `verification`: needs precision for checking work (post-milestone)
 *   - `refinement`: exploratory conversation (Idea Refinement Mode) —
 *     needs good reasoning but not tool-use capability
 */
export type ModelPurpose =
	| 'autocomplete'
	| 'inline_edit'
	| 'agent_plan'
	| 'agent_execute'
	| 'chat'
	| 'embedding'
	| 'verification'
	| 'refinement';

/**
 * Routing priority: what to optimise for when choosing a model.
 */
export type RoutingPriority = 'quality' | 'speed' | 'cost';

/**
 * A model routing entry: for a given purpose, which model to use
 * for a specific provider.
 */
export interface IModelRoute {
	readonly purpose: ModelPurpose;
	readonly provider: string;
	readonly model: string;
	readonly priority: RoutingPriority;
}

// ---------------------------------------------------------------------------
// Default routing tables
// ---------------------------------------------------------------------------

/**
 * Default model routes for each provider. The table is ordered by
 * specificity: more specific entries (purpose + provider) take
 * precedence over generic ones (purpose only).
 *
 * Design rationale for each provider:
 *
 * Anthropic:
 *   - Plan/Execute/Verification → Sonnet (best balance of quality + cost)
 *   - Chat/Refinement → Sonnet (same — no point downgrading for these)
 *   - Autocomplete/InlineEdit → Haiku (speed-optimised, cheaper)
 *   - Embedding → N/A (Anthropic doesn't provide embedding models)
 *
 * NVIDIA NIM:
 *   - Plan/Execute → llama-3.1-405b (largest available on free tier)
 *   - Chat/Refinement → llama-3.1-70b (good quality, faster)
 *   - Autocomplete/InlineEdit → llama-3.1-8b (fastest)
 *   - Verification → llama-3.1-70b (needs good reasoning, not the biggest)
 *   - Embedding → nomic-embed-text (NVIDIA's embedding model)
 *
 * OpenRouter:
 *   - Plan/Execute → anthropic/claude-sonnet-4 (best quality)
 *   - Chat/Refinement → anthropic/claude-sonnet-4 (consistent with above)
 *   - Autocomplete/InlineEdit → anthropic/claude-haiku-4 (fast + cheap)
 *   - Verification → anthropic/claude-sonnet-4 (needs precision)
 *   - Embedding → N/A (OpenRouter routes to embedding providers separately)
 */
const DEFAULT_ROUTES: readonly IModelRoute[] = [
	// --- Anthropic ---
	{ purpose: 'autocomplete',   provider: 'anthropic', model: 'claude-haiku-4-20250514',   priority: 'speed' },
	{ purpose: 'inline_edit',    provider: 'anthropic', model: 'claude-haiku-4-20250514',   priority: 'speed' },
	{ purpose: 'agent_plan',     provider: 'anthropic', model: 'claude-sonnet-4-20250514',   priority: 'quality' },
	{ purpose: 'agent_execute',  provider: 'anthropic', model: 'claude-sonnet-4-20250514',   priority: 'quality' },
	{ purpose: 'chat',           provider: 'anthropic', model: 'claude-sonnet-4-20250514',   priority: 'quality' },
	{ purpose: 'verification',   provider: 'anthropic', model: 'claude-sonnet-4-20250514',   priority: 'quality' },
	{ purpose: 'refinement',     provider: 'anthropic', model: 'claude-sonnet-4-20250514',   priority: 'quality' },

	// --- NVIDIA NIM ---
	{ purpose: 'autocomplete',   provider: 'nvidia-nim', model: 'meta/llama-3.1-8b-instruct',       priority: 'speed' },
	{ purpose: 'inline_edit',    provider: 'nvidia-nim', model: 'meta/llama-3.1-8b-instruct',       priority: 'speed' },
	{ purpose: 'agent_plan',     provider: 'nvidia-nim', model: 'meta/llama-3.1-405b-instruct',     priority: 'quality' },
	{ purpose: 'agent_execute',  provider: 'nvidia-nim', model: 'meta/llama-3.1-405b-instruct',     priority: 'quality' },
	{ purpose: 'chat',           provider: 'nvidia-nim', model: 'meta/llama-3.1-70b-instruct',      priority: 'cost' },
	{ purpose: 'verification',   provider: 'nvidia-nim', model: 'meta/llama-3.1-70b-instruct',      priority: 'quality' },
	{ purpose: 'refinement',     provider: 'nvidia-nim', model: 'meta/llama-3.1-70b-instruct',      priority: 'cost' },
	{ purpose: 'embedding',      provider: 'nvidia-nim', model: 'nomic-embed-text',                  priority: 'cost' },

	// --- OpenRouter ---
	{ purpose: 'autocomplete',   provider: 'openrouter', model: 'anthropic/claude-haiku-4',   priority: 'speed' },
	{ purpose: 'inline_edit',    provider: 'openrouter', model: 'anthropic/claude-haiku-4',   priority: 'speed' },
	{ purpose: 'agent_plan',     provider: 'openrouter', model: 'anthropic/claude-sonnet-4',  priority: 'quality' },
	{ purpose: 'agent_execute',  provider: 'openrouter', model: 'anthropic/claude-sonnet-4',  priority: 'quality' },
	{ purpose: 'chat',           provider: 'openrouter', model: 'anthropic/claude-sonnet-4',  priority: 'quality' },
	{ purpose: 'verification',   provider: 'openrouter', model: 'anthropic/claude-sonnet-4',  priority: 'quality' },
	{ purpose: 'refinement',     provider: 'openrouter', model: 'anthropic/claude-sonnet-4',  priority: 'quality' },
];

// ---------------------------------------------------------------------------
// Route lookup
// ---------------------------------------------------------------------------

/**
 * Look up the recommended model for a given purpose + provider.
 *
 * Resolution order:
 *   1. Check custom routes (if any were registered)
 *   2. Check DEFAULT_ROUTES for an exact (purpose, provider) match
 *   3. Return undefined (caller falls back to the provider's default model)
 *
 * Returns the model string to use, or undefined if no route is found
 * (embedding on Anthropic, for example — Anthropic doesn't offer
 * embedding models, so the caller should use a separate embedding service).
 */
export function routeModel(
	purpose: ModelPurpose,
	provider: string,
	customRoutes?: readonly IModelRoute[],
): string | undefined {
	// 1. Check custom routes first (user overrides)
	if (customRoutes) {
		const custom = customRoutes.find(
			r => r.purpose === purpose && r.provider === provider,
		);
		if (custom) {
			return custom.model;
		}
	}

	// 2. Check default routes
	const route = DEFAULT_ROUTES.find(
		r => r.purpose === purpose && r.provider === provider,
	);
	return route?.model;
}

/**
 * Get the routing priority for a given purpose. Useful for logging
 * and for the cost governor's model-switch recommendations.
 */
export function getRoutingPriority(purpose: ModelPurpose): RoutingPriority {
	switch (purpose) {
		case 'autocomplete':
		case 'inline_edit':
			return 'speed';
		case 'agent_plan':
		case 'agent_execute':
		case 'verification':
			return 'quality';
		case 'chat':
		case 'refinement':
		case 'embedding':
			return 'cost';
	}
}

/**
 * Get all default routes. Useful for displaying the routing table
 * in a settings UI or for debugging.
 */
export function getDefaultRoutes(): readonly IModelRoute[] {
	return DEFAULT_ROUTES;
}

/**
 * Check whether a given purpose is supported by a given provider.
 * Returns false if the provider doesn't have a route for the purpose
 * (e.g., Anthropic + embedding).
 */
export function isPurposeSupported(purpose: ModelPurpose, provider: string): boolean {
	return DEFAULT_ROUTES.some(r => r.purpose === purpose && r.provider === provider);
}
