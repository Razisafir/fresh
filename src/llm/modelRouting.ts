/**
 * modelRouting.ts — Model routing by purpose (HARVEST-3 from Kovix_2.0).
 *
 * Source: `Kovix_2.0` branch `recovery/audit-tier1-patches`, commit `97b5c07b`.
 * The original branch has been deleted from the remote; this file is
 * reconstructed from the specification in HARVEST_CANDIDATES.md §1.4:
 *
 *   "Solves a real design flaw: currently every AI operation uses the same
 *    active model. This adds ModelPurpose type
 *    (autocomplete/inline-edit/agent-plan/agent-execute/chat/embedding)
 *    and a routing decision function that maps purpose to appropriate model.
 *    Pure-logic file with no VS Code imports — fully unit-testable."
 *
 * Port strategy: RECONSTRUCT from spec (original file unrecoverable).
 * Layer: 1 (pure logic, no platform imports).
 *
 * Honest assessment (per task brief):
 *   This module solves a REAL design flaw (single-model-for-everything),
 *   but its IMMEDIATE value depends on how many providers are actively
 *   configured. When the user runs a single free model via NVIDIA NIM
 *   (e.g. nvidia/nemotron-3-nano-30b-a3b:free), all purposes will route
 *   to the same model — the routing table is correct but produces no
 *   behavioural difference. The module becomes genuinely useful when:
 *     (a) multiple providers are configured (e.g. cheap model for execution,
 *         strong model for planning), OR
 *     (b) per-purpose model overrides are set in config.
 *   Until then, it's infrastructure ready for when multi-provider becomes
 *   the norm. It costs nothing to have it wired in — the routing table
 *   degrades to "everything → active model" when no overrides exist — so
 *   we ship it now rather than discovering the gap later.
 *
 * Decisions referenced: D-001 (file-by-file audit), HARVEST-3.
 */

import type { AIProviderType, IModelInfo } from '../types/llm';

// ---------------------------------------------------------------------------
// ModelPurpose — what the model is being asked to do
// ---------------------------------------------------------------------------

/**
 * Categorises the purpose of a model request. Different purposes have
 * different optimal model characteristics:
 *
 *   - autocomplete:       low latency, cheap, small context
 *   - inline-edit:        moderate latency, moderate quality
 *   - agent-plan:         high quality, large context, tool support
 *   - agent-execute:      moderate quality, tool support, cost-sensitive
 *   - chat:               balanced quality and latency
 *   - embedding:          not an LLM call — routing is to embedding service
 */
export type ModelPurpose =
	| 'autocomplete'
	| 'inline-edit'
	| 'agent-plan'
	| 'agent-execute'
	| 'chat'
	| 'embedding';

/**
 * All valid ModelPurpose values, for iteration / validation.
 */
export const MODEL_PURPOSES: readonly ModelPurpose[] = [
	'autocomplete',
	'inline-edit',
	'agent-plan',
	'agent-execute',
	'chat',
	'embedding',
];

// ---------------------------------------------------------------------------
// Model capability tiers
// ---------------------------------------------------------------------------

/**
 * Broad capability tier. Used as a shorthand when mapping purpose → model.
 *
 *   - lightweight:  fast, cheap, small context (good for autocomplete, chat)
 *   - standard:     balanced (good for execution, inline-edit)
 *   - capable:      high quality, large context, tool support (planning)
 *   - embedding:    not an LLM — embedding model
 */
export type ModelTier = 'lightweight' | 'standard' | 'capable' | 'embedding';

/**
 * Default mapping: purpose → capability tier.
 * This is the base recommendation; specific model overrides in config
 * take priority.
 */
export const PURPOSE_TIER_DEFAULTS: Readonly<Record<ModelPurpose, ModelTier>> = {
	autocomplete: 'lightweight',
	'inline-edit': 'standard',
	'agent-plan': 'capable',
	'agent-execute': 'standard',
	chat: 'lightweight',
	embedding: 'embedding',
};

// ---------------------------------------------------------------------------
// Routing table entry
// ---------------------------------------------------------------------------

/**
 * A routing table entry specifies which provider + model to use for a
 * given purpose. Both fields are optional — if omitted, the active
 * provider/model is used (fallback to current behaviour).
 */
export interface IModelRoute {
	/** Provider to use for this purpose. If undefined, use active provider. */
	provider?: AIProviderType;
	/** Model ID to use for this purpose. If undefined, use provider's active model. */
	modelId?: string;
}

/**
 * The full routing table. Purposes not listed fall through to the
 * active provider/model.
 */
export type IModelRoutingTable = Partial<Record<ModelPurpose, IModelRoute>>;

// ---------------------------------------------------------------------------
// Routing result
// ---------------------------------------------------------------------------

/**
 * Result of a routing decision. Includes the resolved route AND the
 * reasoning so the caller can log / display why a particular model
 * was chosen.
 */
export interface IModelRoutingResult {
	/** The purpose being routed. */
	purpose: ModelPurpose;
	/** The resolved provider type (from route or active). */
	provider: AIProviderType;
	/** The resolved model ID (from route or active). */
	modelId: string;
	/** Why this route was chosen. Human-readable for logging. */
	reason: string;
	/** Whether a specific override was found in the routing table. */
	overrideApplied: boolean;
}

// ---------------------------------------------------------------------------
// Model characteristics (for heuristic matching)
// ---------------------------------------------------------------------------

/**
 * Heuristic model characteristics used to auto-classify models into tiers
 * when no explicit override exists. These are best-effort — the routing
 * table override is always preferred.
 */
export interface IModelCharacteristics {
	/** Approximate context window in tokens. */
	contextWindow: number;
	/** Whether the model supports tool/function calling. */
	supportsTools: boolean;
	/** Estimated cost tier (free < low < medium < high). */
	costTier: 'free' | 'low' | 'medium' | 'high';
}

/**
 * Heuristic rules for classifying a model into a tier based on its
 * characteristics. The rules are intentionally simple and conservative:
 *
 *   - embedding tier:  never (handled by separate service)
 *   - lightweight:     free or low cost, OR context < 16K
 *   - capable:         supports tools AND (context >= 64K OR cost >= medium)
 *   - standard:        everything else
 */
export function classifyModelTier(chars: IModelCharacteristics): ModelTier {
	// Embedding models are handled by a separate service, not by LLM routing.
	// This function should never be called for embedding purposes.
	if (chars.costTier === 'free' || chars.costTier === 'low') {
		return 'lightweight';
	}
	if (chars.contextWindow < 16_000) {
		return 'lightweight';
	}
	if (chars.supportsTools && (chars.contextWindow >= 64_000 || chars.costTier === 'medium' || chars.costTier === 'high')) {
		return 'capable';
	}
	return 'standard';
}

// ---------------------------------------------------------------------------
// Active model snapshot (what the routing function needs from the caller)
// ---------------------------------------------------------------------------

/**
 * Snapshot of the currently active provider/model state. The routing
 * function is pure — it doesn't reach into any service. The caller
 * provides this snapshot.
 */
export interface IActiveModelSnapshot {
	/** Currently active provider type. */
	activeProvider: AIProviderType;
	/** Currently active model info (if any). */
	activeModel: IModelInfo | undefined;
}

// ---------------------------------------------------------------------------
// Core routing function
// ---------------------------------------------------------------------------

/**
 * Route a model purpose to a specific provider + model.
 *
 * Resolution order:
 *   1. Explicit override in routingTable[purpose]
 *   2. If no override, fall through to active provider/model
 *   3. If no active model, return a result with empty modelId
 *      (the caller should handle this as "no model available")
 *
 * This function is pure — no side effects, no service access.
 * All state comes in via parameters.
 *
 * @param purpose     What the model will be used for
 * @param routingTable  Per-purpose overrides (from config)
 * @param snapshot    Current active provider/model state
 * @returns Routing decision with reasoning
 */
export function routeModel(
	purpose: ModelPurpose,
	routingTable: IModelRoutingTable,
	snapshot: IActiveModelSnapshot,
): IModelRoutingResult {
	// 1. Check for explicit override
	const override = routingTable[purpose];
	if (override) {
		const provider = override.provider ?? snapshot.activeProvider;
		const modelId = override.modelId ?? snapshot.activeModel?.id ?? '';
		return {
			purpose,
			provider,
			modelId,
			reason: override.provider && override.modelId
				? `Routing table override: ${provider}/${modelId}`
				: override.provider
					? `Routing table provider override: ${provider}, using active model ${modelId}`
					: `Routing table model override: ${modelId} on ${provider}`,
			overrideApplied: true,
		};
	}

	// 2. Fall through to active provider/model
	const provider = snapshot.activeProvider;
	const modelId = snapshot.activeModel?.id ?? '';
	const tier = PURPOSE_TIER_DEFAULTS[purpose];

	return {
		purpose,
		provider,
		modelId,
		reason: modelId
			? `No override for '${purpose}' (tier: ${tier}), using active: ${provider}/${modelId}`
			: `No override for '${purpose}' (tier: ${tier}), no active model on ${provider}`,
		overrideApplied: false,
	};
}

// ---------------------------------------------------------------------------
// Batch routing (route all purposes at once, for diagnostics / UI)
// ---------------------------------------------------------------------------

/**
 * Route all known purposes and return the full map. Useful for:
 *   - Display in settings UI ("model per purpose" table)
 *   - Diagnostic logging on startup
 *   - Validating that the routing table is consistent
 */
export function routeAllPurposes(
	routingTable: IModelRoutingTable,
	snapshot: IActiveModelSnapshot,
): Readonly<Record<ModelPurpose, IModelRoutingResult>> {
	const results: Partial<Record<ModelPurpose, IModelRoutingResult>> = {};
	for (const purpose of MODEL_PURPOSES) {
		results[purpose] = routeModel(purpose, routingTable, snapshot);
	}
	return results as Record<ModelPurpose, IModelRoutingResult>;
}

// ---------------------------------------------------------------------------
// Routing table validation
// ---------------------------------------------------------------------------

/**
 * Validate a routing table entry. Returns an array of issues (empty = valid).
 *
 * Checks:
 *   - modelId is non-empty if provider is specified
 *   - embedding purpose does not point to an LLM provider
 *   - (future: check that the model actually exists on the provider)
 */
export function validateRoutingTable(
	table: IModelRoutingTable,
): string[] {
	const issues: string[] = [];

	for (const purpose of MODEL_PURPOSES) {
		const entry = table[purpose];
		if (!entry) continue;

		if (entry.provider && !entry.modelId) {
			issues.push(`Purpose '${purpose}': provider '${entry.provider}' specified but no modelId`);
		}

		if (purpose === 'embedding' && entry.provider) {
			issues.push(
				`Purpose 'embedding': routing to LLM provider '${entry.provider}' is incorrect — ` +
				`embeddings use a separate service (Ollama), not an LLM provider. ` +
				`Remove the provider override or set it to 'ollama'.`,
			);
		}
	}

	return issues;
}

// ---------------------------------------------------------------------------
// Default routing table (empty — all purposes use active model)
// ---------------------------------------------------------------------------

/**
 * The default routing table has NO overrides. Every purpose routes to
 * the active provider/model. This preserves current behaviour while
 * allowing users to add per-purpose overrides in config.
 */
export const DEFAULT_ROUTING_TABLE: IModelRoutingTable = {};

// ---------------------------------------------------------------------------
// Config key (for future wiring into settings)
// ---------------------------------------------------------------------------

/**
 * The config key under which the routing table will be stored.
 * Example: `kovix.modelRouting` in the app's config store.
 *
 * This is exported for reference but NOT wired yet — wiring happens
 * when the settings UI gets a "model per purpose" panel (Layout B+).
 */
export const MODEL_ROUTING_CONFIG_KEY = 'kovix.modelRouting';
