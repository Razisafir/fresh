/**
 * openrouterProvider.ts — IConstructAIProvider for OpenRouter.
 *
 * OpenRouter is an OpenAI-compatible API that routes to multiple LLM providers
 * (Claude, GPT-4o, Gemini, Llama, etc.) via a single API key.
 * Endpoint: https://openrouter.ai/api/v1/chat/completions
 *
 * Structure closely follows nvidiaProvider.ts since both are OpenAI-compatible.
 */

import { logger } from '../../util/logger';
import { redactSecrets } from '../../security/secretRedactor';
import {
        AIProviderType,
        ProviderStatus,
} from '../../types/llm';
import type {
        AIStreamEvent,
        IChatMessage,
        IChatOptions,
        ICompleteOptions,
        ICompleteResult,
        IConstructAIProvider,
        IModelInfo,
        IToolDefinition,
} from '../../types/llm';
import type { ISecrets } from '../../types/platform';
import { getAppState } from '../../platform/appState';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4';
const FALLBACK_MODELS = [
        'anthropic/claude-sonnet-4',
        'anthropic/claude-3.5-sonnet',
        'openai/gpt-4o',
        'google/gemini-2.0-flash-001',
        'meta-llama/llama-3.3-70b-instruct',
];
const MAX_RETRIES = 3;
const SECRET_KEY = 'kovix.apiKey.openrouter';

/** Default max_tokens for OpenRouter models. */
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Rough token estimation: ~4 chars per token for English text.
 */
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Minimal Disposable + EventEmitter
// ---------------------------------------------------------------------------

interface Disposable {
        dispose(): void;
}

class EventEmitter<T> {
        private listeners: Array<(data: T) => void> = [];

        get event(): (listener: (data: T) => void) => { dispose(): void } {
                return (listener: (data: T) => void) => {
                        this.listeners.push(listener);
                        return {
                                dispose: () => {
                                        const idx = this.listeners.indexOf(listener);
                                        if (idx >= 0) { this.listeners.splice(idx, 1); }
                                },
                        };
                };
        }

        fire(data: T): void {
                for (const listener of [...this.listeners]) {
                        try { listener(data); } catch {
                                // Swallow
                        }
                }
        }

        dispose(): void {
                this.listeners = [];
        }
}

// ---------------------------------------------------------------------------
// OpenRouter SSE chunk types (OpenAI-compatible format)
// ---------------------------------------------------------------------------

interface IOpenRouterSSEChunk {
        id?: string;
        object?: string;
        choices?: Array<{
                index?: number;
                delta?: {
                        role?: string;
                        content?: string;
                        tool_calls?: Array<{
                                index?: number;
                                id?: string;
                                type?: string;
                                function?: {
                                        name?: string;
                                        arguments?: string;
                                };
                        }>;
                };
                finish_reason?: string;
        }>;
        error?: { message?: string; type?: string; code?: string };
}

// ---------------------------------------------------------------------------
// OpenRouterProvider
// ---------------------------------------------------------------------------

export class OpenRouterProvider implements IConstructAIProvider, Disposable {

        readonly providerType: AIProviderType = 'openrouter';

        private _activeModel: IModelInfo | undefined;
        private _status: ProviderStatus = ProviderStatus.Unknown;
        private _cachedModels: IModelInfo[] = [];
        private _apiKey: string | undefined;

        private readonly _onDidChangeActiveModel = new EventEmitter<IModelInfo | undefined>();
        readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event;
        private readonly _onDidChangeStatus = new EventEmitter<ProviderStatus>();
        readonly onDidChangeStatus = this._onDidChangeStatus.event;

        constructor(private readonly secrets: ISecrets) {
                const configuredModel = getAppState().config.llmActiveModel || DEFAULT_OPENROUTER_MODEL;

                this._activeModel = {
                        id: configuredModel || DEFAULT_OPENROUTER_MODEL,
                        displayName: configuredModel || 'Claude Sonnet 4',
                        provider: 'openrouter',
                        contextWindowTokens: 200_000,
                        supportsTools: true,
                        supportsStreaming: true,
                };

                logger.info(redactSecrets('[OpenRouterProvider] Initialized (default model: ' + this._activeModel.id + ')'));
        }

        isOffline(): boolean {
                return false;
        }

        private async _resolveApiKey(): Promise<string | undefined> {
                this._apiKey = await this.secrets.get(SECRET_KEY);
                return this._apiKey;
        }

        private _setStatus(status: ProviderStatus): void {
                if (this._status !== status) {
                        this._status = status;
                        this._onDidChangeStatus.fire(status);
                }
        }

        async checkStatus(): Promise<ProviderStatus> {
                const key = await this._resolveApiKey();
                if (!key) {
                        this._setStatus(ProviderStatus.NoModels);
                        return this._status;
                }

                try {
                        const response = await fetch(OPENROUTER_MODELS_URL, {
                                headers: {
                                        'Authorization': `Bearer ${key}`,
                                },
                        });
                        if (response.ok) {
                                this._setStatus(ProviderStatus.Available);
                        } else if (response.status === 401 || response.status === 403) {
                                this._setStatus(ProviderStatus.NoModels);
                        } else {
                                this._setStatus(ProviderStatus.Unreachable);
                        }
                } catch {
                        this._setStatus(ProviderStatus.Unreachable);
                }

                return this._status;
        }

        async *chat(
                messages: IChatMessage[],
                tools: IToolDefinition[],
                options?: IChatOptions,
        ): AsyncIterable<AIStreamEvent> {
                const key = await this._resolveApiKey();
                if (!key) {
                        yield { type: 'error', text: 'OpenRouter API key not set. Set it via the settings dialog.' };
                        return;
                }

                const body = this.buildRequestBody(messages, tools, options);

                let retries = 0;
                while (retries < MAX_RETRIES) {
                        try {
                                const response = await fetch(OPENROUTER_API_URL, {
                                        method: 'POST',
                                        headers: {
                                                'Content-Type': 'application/json',
                                                'Authorization': `Bearer ${key}`,
                                                'HTTP-Referer': 'https://kovix.dev',
                                                'X-Title': 'Kovix',
                                                'Accept': 'text/event-stream',
                                        },
                                        body: JSON.stringify(body),
                                        signal: options?.signal,
                                });

                                if (response.status === 429) {
                                        const retryAfter = response.headers.get('retry-after');
                                        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000 * (retries + 1);
                                        logger.warn(`[OpenRouterProvider] Rate limited, retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
                                        await new Promise(r => setTimeout(r, waitMs));
                                        retries++;
                                        continue;
                                }

                                if (response.status === 529 || response.status >= 500) {
                                        const waitMs = 2000 * (retries + 1);
                                        logger.warn(`[OpenRouterProvider] Server error ${response.status}, retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
                                        await new Promise(r => setTimeout(r, waitMs));
                                        retries++;
                                        continue;
                                }

                                if (response.status === 401 || response.status === 403) {
                                        yield { type: 'error', text: 'OpenRouter API key is invalid or revoked.' };
                                        return;
                                }

                                if (!response.ok) {
                                        const errorText = await response.text().catch(() => 'unknown');
                                        yield { type: 'error', text: `OpenRouter API error (${response.status}): ${errorText}` };
                                        return;
                                }

                                // Parse SSE stream (OpenAI format)
                                yield* this.parseSSEStream(response, options?.signal);
                                return;
                        } catch (error) {
                                if (error instanceof Error && error.name === 'AbortError') {
                                        return;
                                }
                                const msg = error instanceof Error ? error.message : String(error);
                                const isTransient = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg);
                                if (isTransient && retries < MAX_RETRIES - 1) {
                                        const waitMs = 2000 * (retries + 1);
                                        logger.warn(`[OpenRouterProvider] Transient network error: "${msg}". Retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
                                        await new Promise(r => setTimeout(r, waitMs));
                                        retries++;
                                        continue;
                                }
                                logger.error(`[OpenRouterProvider] Request failed: ${msg}`);
                                yield { type: 'error', text: `OpenRouter request failed: ${msg}` };
                                return;
                        }
                }

                yield { type: 'error', text: 'OpenRouter API: max retries exceeded.' };
        }

        private buildRequestBody(
                messages: IChatMessage[],
                tools: IToolDefinition[],
                options?: IChatOptions,
        ): Record<string, unknown> {
                const contextWindow = this._activeModel?.contextWindowTokens ?? 200_000;
                const reservedForResponse = DEFAULT_MAX_TOKENS;
                const safetyMargin = 2_000;
                const maxInputTokens = contextWindow - reservedForResponse - safetyMargin;
                const trimmedMessages = this.trimMessagesToContextWindow(messages, maxInputTokens);

                const openaiMessages = this.convertToOpenAIMessages(trimmedMessages, options?.systemPrompt);
                const openaiTools = tools.length > 0 ? this.convertToOpenAITools(tools) : undefined;

                const body: Record<string, unknown> = {
                        model: this._activeModel?.id ?? DEFAULT_OPENROUTER_MODEL,
                        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
                        messages: openaiMessages,
                        stream: true,
                };

                if (openaiTools && openaiTools.length > 0) {
                        body.tools = openaiTools;
                }

                if (options?.temperature !== undefined) {
                        body.temperature = options.temperature;
                }

                return body;
        }

        private trimMessagesToContextWindow(messages: IChatMessage[], maxTokens: number): IChatMessage[] {
                if (messages.length <= 2) return messages;

                const estimateTokens = (msgs: IChatMessage[]): number => {
                        let chars = 0;
                        for (const m of msgs) {
                                chars += m.content.length;
                                if (m.toolCalls) {
                                        for (const tc of m.toolCalls) {
                                                chars += tc.arguments.length + tc.name.length;
                                        }
                                }
                        }
                        return Math.ceil(chars / CHARS_PER_TOKEN);
                };

                const totalTokens = estimateTokens(messages);
                if (totalTokens <= maxTokens) return messages;

                logger.warn(`[OpenRouterProvider] Context too large (~${totalTokens} tokens, budget ${maxTokens}). Trimming history.`);

                const result = [...messages];
                while (result.length > 2 && estimateTokens(result) > maxTokens) {
                        result.splice(1, 1);
                }

                const newTokens = estimateTokens(result);
                logger.info(`[OpenRouterProvider] Trimmed ${messages.length - result.length} messages. New estimate: ~${newTokens} tokens.`);
                return result;
        }

        private convertToOpenAIMessages(messages: IChatMessage[], systemPrompt?: string): unknown[] {
                const result: unknown[] = [];

                if (systemPrompt) {
                        result.push({ role: 'system', content: systemPrompt });
                }

                for (const m of messages) {
                        if (m.role === 'system') continue;

                        if (m.role === 'tool') {
                                result.push({
                                        role: 'tool',
                                        tool_call_id: m.toolCallId ?? '',
                                        content: m.content,
                                });
                                continue;
                        }

                        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
                                const toolCalls = m.toolCalls.map(tc => ({
                                        id: tc.id,
                                        type: 'function',
                                        function: {
                                                name: tc.name,
                                                arguments: tc.arguments || '{}',
                                        },
                                }));
                                result.push({
                                        role: 'assistant',
                                        content: m.content || null,
                                        tool_calls: toolCalls,
                                });
                                continue;
                        }

                        result.push({ role: m.role, content: m.content });
                }

                return result;
        }

        private convertToOpenAITools(tools: IToolDefinition[]): unknown[] {
                return tools.map(t => ({
                        type: 'function',
                        function: {
                                name: t.name,
                                description: t.description,
                                parameters: t.inputSchema,
                        },
                }));
        }

        private async *parseSSEStream(response: Response, signal?: AbortSignal): AsyncIterable<AIStreamEvent> {
                const reader = response.body?.getReader();
                if (!reader) {
                        yield { type: 'error', text: 'OpenRouter API returned empty body.' };
                        return;
                }

                const decoder = new TextDecoder();
                let buffer = '';
                const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

                try {
                        while (true) {
                                if (signal?.aborted) return;

                                const { done, value } = await reader.read();
                                if (done) break;

                                buffer += decoder.decode(value, { stream: true });
                                const lines = buffer.split('\n');
                                buffer = lines.pop() ?? '';

                                for (const line of lines) {
                                        const trimmed = line.trim();
                                        if (!trimmed || trimmed.startsWith('event:')) continue;

                                        if (trimmed.startsWith('data:')) {
                                                const jsonStr = trimmed.slice(5).trim();
                                                if (!jsonStr || jsonStr === '[DONE]') continue;

                                                try {
                                                        const chunk = JSON.parse(jsonStr) as IOpenRouterSSEChunk;

                                                        if (chunk.error) {
                                                                yield { type: 'error', text: chunk.error.message ?? 'Unknown OpenRouter stream error' };
                                                                return;
                                                        }

                                                        if (chunk.choices && chunk.choices.length > 0) {
                                                                const choice = chunk.choices[0];
                                                                const delta = choice.delta;

                                                                if (delta?.content) {
                                                                        yield { type: 'token', text: delta.content };
                                                                }

                                                                if (delta?.tool_calls && delta.tool_calls.length > 0) {
                                                                        for (const tc of delta.tool_calls) {
                                                                                const idx = tc.index ?? 0;

                                                                                if (tc.id) {
                                                                                        const name = tc.function?.name ?? '';
                                                                                        pendingToolCalls.set(idx, {
                                                                                                id: tc.id,
                                                                                                name,
                                                                                                arguments: '',
                                                                                        });
                                                                                        yield { type: 'tool_start', toolId: tc.id, toolName: name };
                                                                                }

                                                                                if (tc.function?.arguments) {
                                                                                        const pending = pendingToolCalls.get(idx);
                                                                                        if (pending) {
                                                                                                pending.arguments += tc.function.arguments;
                                                                                                yield { type: 'tool_input', toolId: pending.id, text: tc.function.arguments };
                                                                                        }
                                                                                }
                                                                        }
                                                                }

                                                                if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
                                                                        if (choice.finish_reason === 'tool_calls') {
                                                                                for (const [, tc] of pendingToolCalls) {
                                                                                        let toolInput: unknown;
                                                                                        try {
                                                                                                toolInput = JSON.parse(tc.arguments);
                                                                                        } catch {
                                                                                                toolInput = {};
                                                                                        }
                                                                                        yield { type: 'tool_end', toolId: tc.id, toolName: tc.name, toolInput };
                                                                                }
                                                                        }
                                                                        pendingToolCalls.clear();
                                                                        yield { type: 'done', stopReason: choice.finish_reason ?? 'stop' };
                                                                }
                                                        }
                                                } catch {
                                                        // Malformed JSON — skip.
                                                }
                                        }
                                }
                        }
                } finally {
                        reader.releaseLock();
                }
        }

        async complete(_prefix: string, _suffix: string, _options?: ICompleteOptions): Promise<ICompleteResult> {
                return { text: '', finished: true };
        }

        async listModels(): Promise<IModelInfo[]> {
                if (this._cachedModels.length > 0) return this._cachedModels;

                const key = await this._resolveApiKey();
                if (!key) return [];

                try {
                        const response = await fetch(OPENROUTER_MODELS_URL, {
                                headers: {
                                        'Authorization': `Bearer ${key}`,
                                },
                        });
                        if (response.ok) {
                                const data = await response.json() as { data: Array<{ id: string; context_length?: number; owned_by?: string }> };
                                this._cachedModels = data.data
                                        .filter(m => m.id)
                                        .map(m => ({
                                                id: m.id,
                                                displayName: m.id,
                                                provider: 'openrouter' as AIProviderType,
                                                contextWindowTokens: m.context_length ?? 128_000,
                                                supportsTools: true,
                                                supportsStreaming: true,
                                        }));
                                return this._cachedModels;
                        }
                } catch {
                        // Fallback to default models.
                }

                return this._activeModel ? [this._activeModel] : FALLBACK_MODELS.map(id => ({
                        id,
                        displayName: id,
                        provider: 'openrouter' as AIProviderType,
                        contextWindowTokens: 128_000,
                        supportsTools: true,
                        supportsStreaming: true,
                }));
        }

        getActiveModel(): IModelInfo | undefined {
                return this._activeModel;
        }

        async setActiveModel(modelId: string): Promise<boolean> {
                this._activeModel = {
                        id: modelId,
                        displayName: modelId,
                        provider: 'openrouter',
                        contextWindowTokens: 200_000,
                        supportsTools: true,
                        supportsStreaming: true,
                };
                this._onDidChangeActiveModel.fire(this._activeModel);
                return true;
        }

        dispose(): void {
                this._onDidChangeActiveModel.dispose();
                this._onDidChangeStatus.dispose();
        }
}
