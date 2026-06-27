/**
 * llm.ts — Layer 1 type definitions for the LLM provider layer.
 *
 * Phase 0 pivot (D-015): removed `import type { Event } from 'vscode'`.
 * The `Event` type is now defined locally — it's just a function type.
 */

// ---------------------------------------------------------------------------
// Event type (replaces vscode.Event<T>)
// ---------------------------------------------------------------------------

/**
 * Minimal Event type. Same shape as vscode.Event<T>.
 * An event listener function that returns a disposable.
 */
export type Event<T> = (listener: (e: T) => unknown) => { dispose(): void };

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

export interface IChatOptions {
        signal?: AbortSignal;
        systemPrompt?: string;
        maxTokens?: number;
        temperature?: number;
}

export interface ICompleteOptions {
        signal?: AbortSignal;
        maxTokens?: number;
        temperature?: number;
        stop?: string[];
}

export interface ICompleteResult {
        text: string;
        finished: boolean;
}

// ---------------------------------------------------------------------------
// IConstructAIProvider interface
// ---------------------------------------------------------------------------

export interface IConstructAIProvider {
        chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent>;
        complete(prefix: string, suffix: string, options?: ICompleteOptions): Promise<ICompleteResult>;
        listModels(): Promise<IModelInfo[]>;
        getActiveModel(): IModelInfo | undefined;
        setActiveModel(modelId: string): Promise<boolean>;
        isOffline(): boolean;
        checkStatus(): Promise<ProviderStatus>;
        readonly providerType: AIProviderType;
        readonly onDidChangeActiveModel: Event<IModelInfo | undefined>;
        readonly onDidChangeStatus: Event<ProviderStatus>;
        dispose(): void;
}

// ---------------------------------------------------------------------------
// IConstructAIService interface
// ---------------------------------------------------------------------------

export interface IConstructAIService {
        readonly activeProvider: IConstructAIProvider | undefined;
        readonly activeProviderType: AIProviderType | undefined;
        chat(messages: IChatMessage[], tools: IToolDefinition[], options?: IChatOptions): AsyncIterable<AIStreamEvent>;
        complete(prefix: string, suffix: string, options?: ICompleteOptions): Promise<ICompleteResult>;
        listModels(): Promise<IModelInfo[]>;
        getActiveModel(): IModelInfo | undefined;
        setActiveModel(modelId: string): Promise<boolean>;
        isOffline(): boolean;
        switchProvider(providerType: AIProviderType): Promise<boolean>;
        getProvider(type: AIProviderType): IConstructAIProvider | undefined;
        readonly onDidChangeActiveProvider: Event<AIProviderType>;
        readonly onDidChangeActiveModel: Event<IModelInfo | undefined>;
}
