/**
 * llm.ts — Layer 1 type definitions for the LLM provider layer.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/llm/constructAIProvider.ts` (263L)
 *              `Kovix_2.0/src/vs/platform/construct/common/llm/constructAIService.ts` (126L)
 * Port strategy: VERBATIM. Pure types — no VS Code internals, no logic.
 *
 * 02_ARCHITECTURE.md §4.2 lists this as a Layer 1 port-verbatim file. Two
 * old files are merged here because the AI service interface is just a thin
 * wrapper that delegates to a provider — they share all the same types
 * (`IChatMessage`, `IToolDefinition`, `AIStreamEvent`, etc.) and are always
 * imported together.
 *
 * Translation notes:
 *   - `createDecorator<IConstructAIProvider>(...)` and
 *     `createDecorator<IConstructAIService>(...)` removed (no DI container
 *     in fresh, per 02_ARCHITECTURE.md §3 design choice #2).
 *   - `Event<T>` imported from `vscode` instead of VS Code's internal
 *     `base/common/event.js`. Same shape.
 *   - `_serviceBrand: undefined` field removed from both interfaces — VS
 *     Code DI marker, no runtime meaning, not used in fresh.
 *   - The `AIProviderType` enum value `'xenova'` is DROPPED per
 *     02_ARCHITECTURE.md §6 mapping table (Xenova unreachable on Electron
 *     desktop, STUB_AUDIT H-3). The old repo's three-value enum
 *     (`'ollama' | 'xenova' | 'cloud'`) becomes a richer enum of concrete
 *     provider names matching the 13 providers in 01_REQUIREMENTS.md §2 M2.
 *   - `ICompleteOptions` and `ICompleteResult` are PRESERVED even though
 *     inline completions are deferred to v1.1, because the Layer 1 types
 *     are cheap to keep and they let us defer the implementation without
 *     breaking the type contract later. (Per the architecture doc's
 *     deferred-not-dropped principle for inline completions.)
 *
 * Decisions referenced: D-001 (file-by-file audit), D-008 (security tools
 * dropped), D-009 (M7 deferred — swarm not in v1), D-011 (extension route).
 */

import type { Event } from 'vscode';

// ---------------------------------------------------------------------------
// Error classes (from constructAIProvider.ts)
// ---------------------------------------------------------------------------

export class ConstructAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConstructAuthError';
	}
}

export class ConstructRateLimitError extends Error {
	constructor(message: string, public readonly retryAfter?: number) {
		super(message);
		this.name = 'ConstructRateLimitError';
	}
}

export class ConstructOverloadedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConstructOverloadedError';
	}
}

// ---------------------------------------------------------------------------
// Provider type discriminator (rewritten for fresh)
// ---------------------------------------------------------------------------

/**
 * Concrete LLM provider names. Matches the 13 providers declared in
 * 01_REQUIREMENTS.md §2 M2 and `package.json`'s `kovix.llm.activeProvider`
 * enum.
 *
 * Difference from old repo: the old repo used a 3-value enum
 * (`'ollama' | 'xenova' | 'cloud'`) because it grouped all cloud providers
 * under one CloudProvider impl. In fresh we split per provider for clarity
 * (per 02_ARCHITECTURE.md §6 mapping table). Xenova is dropped (STUB_AUDIT
 * H-3, unreachable on Electron desktop).
 */
export type AIProviderType =
	| 'anthropic'
	| 'openai'
	| 'nvidia-nim'
	| 'openrouter'
	| 'lm-studio'
	| 'together'
	| 'groq'
	| 'mistral'
	| 'gemini'
	| 'deepseek'
	| 'ollama'
	| 'litellm'
	| 'custom';

/**
 * Status of a provider, used for health checks and auto-selection.
 *
 * Verbatim from old repo. The auto-selection logic that consumed this enum
 * in the old repo is NOT ported to v0.1 — v0.1 uses the user's configured
 * activeProvider directly. Auto-selection may return in v1.0-beta if we
 * add the onboarding wizard.
 */
export enum ProviderStatus {
	/** Provider is available and ready to serve requests. */
	Available = 'available',
	/** Provider is reachable but no models are loaded/available. */
	NoModels = 'noModels',
	/** Provider endpoint is not reachable. */
	Unreachable = 'unreachable',
	/** Provider has not been checked yet. */
	Unknown = 'unknown',
}

// ---------------------------------------------------------------------------
// Chat message / tool types (from constructAIProvider.ts)
// ---------------------------------------------------------------------------

/**
 * Represents a model available from a provider.
 * Contains identifying information and capabilities needed
 * for model selection in the UI and agent system.
 */
export interface IModelInfo {
	/** Unique identifier for the model (e.g. 'llama3.1:8b', 'claude-sonnet-4-20250514') */
	id: string;
	/** Human-readable name for display in the model picker */
	displayName: string;
	/** The provider that hosts this model */
	provider: AIProviderType;
	/** Approximate context window size in tokens */
	contextWindowTokens: number;
	/** Whether this model supports tool/function calling */
	supportsTools: boolean;
	/** Whether this model supports streaming responses */
	supportsStreaming: boolean;
}

/**
 * A chat message in the unified format used across all providers.
 * Each provider adapter translates between this format and its native API format.
 */
export interface IChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	/** For tool_result messages: the ID of the tool call this is responding to */
	toolCallId?: string;
	/** For assistant messages: tool calls requested by the model */
	toolCalls?: IToolCall[];
}

/**
 * A tool call requested by the model during a response.
 */
export interface IToolCall {
	/** Unique ID for this tool call */
	id: string;
	/** Name of the tool to invoke */
	name: string;
	/** JSON-encoded arguments for the tool */
	arguments: string;
}

/**
 * A tool definition that can be provided to any provider.
 * Follows the OpenAI function-calling schema convention.
 *
 * NOTE: This is the LLM-facing tool definition (minimal schema). The
 * tool-registry-facing definition (`src/types/tools.ts` IToolDefinition)
 * is richer (includes `modifiesFiles`, `requiresNetwork`, `category`).
 * The agent loop translates ITool (registry) → IToolDefinition (LLM) when
 * building the LLM request.
 */
export interface IToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: 'object';
		properties: Record<string, unknown>;
		required?: string[];
	};
}

/**
 * Stream events emitted by any AI provider during a streaming response.
 * All providers must yield events in this unified format so the agent
 * loop and UI can consume them without provider-specific logic.
 */
export type AIStreamEvent =
	| { type: 'token'; text: string }
	| { type: 'tool_start'; toolId: string; toolName: string }
	| { type: 'tool_input'; toolId: string; text: string }
	| { type: 'tool_end'; toolId: string; toolName: string; toolInput: unknown }
	| { type: 'done'; stopReason: string }
	| { type: 'error'; text: string };

// ---------------------------------------------------------------------------
// Options / result types (from constructAIProvider.ts)
// ---------------------------------------------------------------------------

/**
 * Options for the chat method.
 * Controls behavior of the AI response generation.
 */
export interface IChatOptions {
	/** AbortSignal for cancelling the request */
	signal?: AbortSignal;
	/** System prompt to prepend to the conversation */
	systemPrompt?: string;
	/** Maximum tokens to generate in the response */
	maxTokens?: number;
	/** Temperature for sampling (0.0 = deterministic, 1.0 = creative) */
	temperature?: number;
}

/**
 * Options for the complete method.
 * Used for inline code completion (e.g. Copilot-style suggestions).
 *
 * DEFERRED to v1.1 per 02_ARCHITECTURE.md §9 non-goals. Type preserved
 * here so the v1.1 port can wire it up without touching Layer 1 types.
 */
export interface ICompleteOptions {
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Maximum tokens to generate */
	maxTokens?: number;
	/** Temperature for sampling */
	temperature?: number;
	/** Stop sequences that end generation */
	stop?: string[];
}

/**
 * Result of an inline completion request.
 *
 * DEFERRED to v1.1 (see ICompleteOptions).
 */
export interface ICompleteResult {
	/** The generated completion text */
	text: string;
	/** Whether the completion was truncated due to maxTokens */
	finished: boolean;
}

// ---------------------------------------------------------------------------
// IConstructAIProvider interface (from constructAIProvider.ts)
// ---------------------------------------------------------------------------

/**
 * IConstructAIProvider — the unified AI provider interface for Kovix.
 *
 * This is the single abstraction that all AI consumers (agent loop, chat
 * panel, inline completions) use. Concrete implementations
 * (`src/llm/providers/<name>.ts`) adapt their respective backends to this
 * interface.
 *
 * The concrete `IConstructAIService` (below) selects the active provider
 * based on `kovix.llm.activeProvider` and delegates all calls to it.
 */
export interface IConstructAIProvider {
	/**
	 * Stream a conversation to the active model, yielding AIStreamEvents.
	 * ALL AI responses must stream token-by-token. Never await a full
	 * response before showing output.
	 *
	 * @param messages Conversation messages in unified format.
	 * @param tools Tool definitions available to the model.
	 * @param options Chat options (signal, systemPrompt, maxTokens, temperature).
	 * @returns AsyncIterable of AIStreamEvent items.
	 */
	chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent>;

	/**
	 * Generate an inline code completion for the given prefix/suffix.
	 * Used for Copilot-style code suggestions.
	 *
	 * DEFERRED to v1.1. The method remains on the interface so the v1.1
	 * port doesn't have to change call sites.
	 *
	 * @param prefix Code before the cursor position.
	 * @param suffix Code after the cursor position (optional).
	 * @param options Completion options.
	 * @returns The completion result.
	 */
	complete(prefix: string, suffix: string, options?: ICompleteOptions): Promise<ICompleteResult>;

	/**
	 * List all models available from this provider.
	 * For Ollama, this queries /api/tags.
	 * For cloud providers, this queries /v1/models (or equivalent).
	 *
	 * @returns Array of model info objects.
	 */
	listModels(): Promise<IModelInfo[]>;

	/**
	 * Get the currently active model.
	 * This is the model that will be used for chat() and complete() calls.
	 */
	getActiveModel(): IModelInfo | undefined;

	/**
	 * Set the active model by ID.
	 * The model must be available from listModels().
	 *
	 * @param modelId The model ID to activate.
	 * @returns True if the model was successfully activated.
	 */
	setActiveModel(modelId: string): Promise<boolean>;

	/**
	 * Whether this provider can operate without internet.
	 * `ollama` returns true; cloud providers return false.
	 */
	isOffline(): boolean;

	/**
	 * Check the current status of this provider.
	 * Used by the onboarding wizard (v1.0+) and status bar.
	 */
	checkStatus(): Promise<ProviderStatus>;

	/**
	 * The type of this provider (one of the 13 concrete provider names).
	 */
	readonly providerType: AIProviderType;

	/**
	 * Event fired when the active model changes.
	 */
	readonly onDidChangeActiveModel: Event<IModelInfo | undefined>;

	/**
	 * Event fired when the provider status changes.
	 */
	readonly onDidChangeStatus: Event<ProviderStatus>;

	/**
	 * Dispose the provider and release resources (connections, etc.).
	 */
	dispose(): void;
}

// ---------------------------------------------------------------------------
// IConstructAIService interface (from constructAIService.ts)
// ---------------------------------------------------------------------------

/**
 * IConstructAIService — the unified AI service that selects the active
 * provider based on user configuration (`kovix.llm.activeProvider`) and
 * delegates all calls to it.
 *
 * Difference from old repo: the old repo's `autoSelectProvider()` would
 * probe Ollama → Xenova → Cloud at startup and pick the first available.
 * In fresh, the user's configured provider is always used directly; we
 * trust the user's choice and surface connection errors via the standard
 * error path. Auto-selection may return in v1.0-beta if we add the
 * onboarding wizard.
 */
export interface IConstructAIService {
	/**
	 * The currently active AI provider.
	 * All chat/complete calls are delegated to this provider.
	 */
	readonly activeProvider: IConstructAIProvider | undefined;

	/**
	 * The type of the currently active provider.
	 * Used for status bar display ("local" vs "cloud").
	 */
	readonly activeProviderType: AIProviderType | undefined;

	/**
	 * Stream a conversation using the active provider.
	 * Delegates to IConstructAIProvider.chat().
	 */
	chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent>;

	/**
	 * Generate an inline completion using the active provider.
	 * DEFERRED to v1.1 (delegates but call sites are not wired in v1.0).
	 */
	complete(prefix: string, suffix: string, options?: ICompleteOptions): Promise<ICompleteResult>;

	/**
	 * List models from the active provider.
	 */
	listModels(): Promise<IModelInfo[]>;

	/**
	 * Get the currently active model.
	 */
	getActiveModel(): IModelInfo | undefined;

	/**
	 * Set the active model on the active provider.
	 */
	setActiveModel(modelId: string): Promise<boolean>;

	/**
	 * Whether the active provider can work offline.
	 */
	isOffline(): boolean;

	/**
	 * Manually switch to a specific provider type.
	 *
	 * @param providerType The provider to switch to.
	 * @returns True if the switch was successful.
	 */
	switchProvider(providerType: AIProviderType): Promise<boolean>;

	/**
	 * Get a specific provider by type.
	 * Used for direct provider access (e.g., Ollama for model pulling).
	 */
	getProvider(type: AIProviderType): IConstructAIProvider | undefined;

	/**
	 * Event fired when the active provider changes.
	 */
	readonly onDidChangeActiveProvider: Event<AIProviderType>;

	/**
	 * Event fired when the active model changes.
	 */
	readonly onDidChangeActiveModel: Event<IModelInfo | undefined>;
}
