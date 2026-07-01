/**
 * groqProvider.ts — IConstructAIProvider for Groq.
 *
 * Groq provides an OpenAI-compatible API at
 * `https://api.groq.com/openai/v1/chat/completions`. This provider uses the same
 * SSE streaming, tool/function calling, and retry logic as the other
 * OpenAI-compatible providers.
 *
 * Default models:
 *   - llama-3.3-70b-versatile  (general-purpose, fast)
 *   - llama-3.1-8b-instant     (lightweight, ultra-fast)
 *   - mixtral-8x7b-32768       (long context)
 *   - gemma2-9b-it             (Google Gemma 2)
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


const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODELS = [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'mixtral-8x7b-32768',
        'gemma2-9b-it',
];
const MAX_RETRIES = 3;
const SECRET_KEY = 'kovix.apiKey.groq';

/** Default max_tokens for Groq models. */
const DEFAULT_MAX_TOKENS = 8_192;

/**
 * Rough token estimation: ~4 chars per token for English text.
 */

export class GroqProvider implements IConstructAIProvider {
        readonly providerType: AIProviderType = 'groq';

        private readonly _secrets: ISecrets;
        private _activeModel: IModelInfo | undefined;
        private _status: ProviderStatus = ProviderStatus.Unknown;
        private _modelsCache: IModelInfo[] | null = null;
        private _modelsCacheTime = 0;
        private readonly _listeners = {
                activeModel: [] as Array<(m: IModelInfo | undefined) => void>,
                status: [] as Array<(s: ProviderStatus) => void>,
        };

        constructor(secrets: ISecrets) {
                this._secrets = secrets;
                this._activeModel = {
                        id: DEFAULT_GROQ_MODEL,
                        displayName: DEFAULT_GROQ_MODEL,
                        provider: 'groq',
                        contextWindowTokens: 131_072,
                        supportsTools: true,
                        supportsStreaming: true,
                };
        }

        get onDidChangeActiveModel() {
                return (listener: (m: IModelInfo | undefined) => void) => {
                        this._listeners.activeModel.push(listener);
                        return { dispose: () => { this._listeners.activeModel = this._listeners.activeModel.filter(l => l !== listener); } };
                };
        }

        get onDidChangeStatus() {
                return (listener: (s: ProviderStatus) => void) => {
                        this._listeners.status.push(listener);
                        return { dispose: () => { this._listeners.status = this._listeners.status.filter(l => l !== listener); } };
                };
        }

        getActiveModel(): IModelInfo | undefined {
                return this._activeModel;
        }

        async setActiveModel(modelId: string): Promise<boolean> {
                const models = await this.listModels();
                const found = models.find(m => m.id === modelId);
                if (found) {
                        this._activeModel = found;
                        this._listeners.activeModel.forEach(l => l(found));
                        return true;
                }
                logger.warn(`[GroqProvider] Model not found: ${modelId}`);
                return false;
        }

        isOffline(): boolean {
                return false;
        }

        async checkStatus(): Promise<ProviderStatus> {
                try {
                        const apiKey = await this._secrets.get(SECRET_KEY);
                        if (!apiKey) {
                                this._setStatus(ProviderStatus.Unreachable);
                                return this._status;
                        }
                        const response = await fetch(GROQ_MODELS_URL, {
                                headers: { 'Authorization': `Bearer ${apiKey}` },
                                signal: AbortSignal.timeout(5_000),
                        });
                        this._setStatus(response.ok ? ProviderStatus.Available : ProviderStatus.Unreachable);
                } catch {
                        this._setStatus(ProviderStatus.Unreachable);
                }
                return this._status;
        }

        async listModels(): Promise<IModelInfo[]> {
                const now = Date.now();
                if (this._modelsCache && now - this._modelsCacheTime < 300_000) {
                        return this._modelsCache;
                }

                try {
                        const apiKey = await this._secrets.get(SECRET_KEY);
                        if (!apiKey) return this._fallbackModels();

                        const response = await fetch(GROQ_MODELS_URL, {
                                headers: { 'Authorization': `Bearer ${apiKey}` },
                                signal: AbortSignal.timeout(10_000),
                        });

                        if (!response.ok) return this._fallbackModels();

                        const data = await response.json() as { data?: Array<{ id: string; context_window?: number }> };
                        if (!data.data) return this._fallbackModels();

                        this._modelsCache = data.data.map(m => ({
                                id: m.id,
                                displayName: m.id,
                                provider: 'groq' as AIProviderType,
                                contextWindowTokens: m.context_window ?? 131_072,
                                supportsTools: true,
                                supportsStreaming: true,
                        }));
                        this._modelsCacheTime = now;
                        return this._modelsCache;
                } catch {
                        return this._fallbackModels();
                }
        }

        async *chat(
                messages: IChatMessage[],
                tools: IToolDefinition[],
                options?: IChatOptions,
        ): AsyncIterable<AIStreamEvent> {
                const apiKey = await this._secrets.get(SECRET_KEY);
                if (!apiKey) {
                        yield { type: 'error', text: 'Groq API key not configured. Set it via /provider groq or settings.' };
                        return;
                }

                const body = this._buildRequestBody(messages, tools, options);
                let retries = 0;

                while (retries < MAX_RETRIES) {
                        try {
                                const response = await fetch(GROQ_API_URL, {
                                        method: 'POST',
                                        headers: {
                                                'Content-Type': 'application/json',
                                                'Authorization': `Bearer ${apiKey}`,
                                        },
                                        body: JSON.stringify(body),
                                        signal: options?.signal ?? AbortSignal.timeout(60_000),
                                });

                                if (response.status === 429) {
                                        const retryAfter = response.headers.get('retry-after');
                                        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.pow(2, retries) * 1000;
                                        logger.warn(`[GroqProvider] Rate limited (429). Retry ${retries + 1}/${MAX_RETRIES} after ${delay}ms`);
                                        await new Promise(r => setTimeout(r, delay));
                                        retries++;
                                        continue;
                                }

                                if (response.status === 401) {
                                        yield { type: 'error', text: 'Groq API key is invalid. Please check your key.' };
                                        return;
                                }

                                if (!response.ok) {
                                        const text = await response.text().catch(() => 'unknown error');
                                        yield { type: 'error', text: `Groq API error (${response.status}): ${redactSecrets(text)}` };
                                        return;
                                }

                                yield* this._processStream(response);
                                return;
                        } catch (err) {
                                if (options?.signal?.aborted) {
                                        yield { type: 'done', stopReason: 'aborted' };
                                        return;
                                }
                                retries++;
                                if (retries >= MAX_RETRIES) {
                                        yield { type: 'error', text: `Groq request failed after ${MAX_RETRIES} retries: ${err instanceof Error ? err.message : String(err)}` };
                                        return;
                                }
                                await new Promise(r => setTimeout(r, Math.pow(2, retries) * 1000));
                        }
                }
        }

        async complete(
                prefix: string,
                suffix: string,
                options?: ICompleteOptions,
        ): Promise<ICompleteResult> {
                const messages: IChatMessage[] = [
                        { role: 'user', content: `Complete the following code. Only return the completion, no explanation.\n\n${prefix}[CURSOR]${suffix}` },
                ];

                const chunks: string[] = [];
                for await (const event of this.chat(messages, [], options)) {
                        if (event.type === 'token') chunks.push(event.text);
                        if (event.type === 'error') break;
                }

                return { text: chunks.join(''), finished: true };
        }

        dispose(): void {
                this._listeners.activeModel.length = 0;
                this._listeners.status.length = 0;
                this._modelsCache = null;
        }

        // --- Private helpers ---

        private _setStatus(status: ProviderStatus): void {
                if (this._status !== status) {
                        this._status = status;
                        this._listeners.status.forEach(l => l(status));
                }
        }

        private _fallbackModels(): IModelInfo[] {
                return FALLBACK_MODELS.map(id => ({
                        id,
                        displayName: id,
                        provider: 'groq' as AIProviderType,
                        contextWindowTokens: 131_072,
                        supportsTools: true,
                        supportsStreaming: true,
                }));
        }

        private _buildRequestBody(
                messages: IChatMessage[],
                tools: IToolDefinition[],
                options?: IChatOptions,
        ): Record<string, unknown> {
                const body: Record<string, unknown> = {
                        model: this._activeModel?.id ?? DEFAULT_GROQ_MODEL,
                        messages: messages.map(m => ({
                                role: m.role,
                                content: m.content,
                                ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
                                ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
                        })),
                        stream: true,
                        max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
                        temperature: options?.temperature ?? 0.7,
                };

                if (tools.length > 0) {
                        body.tools = tools.map(t => ({
                                type: 'function',
                                function: {
                                        name: t.name,
                                        description: t.description,
                                        parameters: t.inputSchema,
                                },
                        }));
                }

                return body;
        }

        private async *_processStream(response: Response): AsyncIterable<AIStreamEvent> {
                const reader = response.body?.getReader();
                if (!reader) {
                        yield { type: 'error', text: 'Groq: No response body' };
                        return;
                }

                const decoder = new TextDecoder();
                let buffer = '';
                let currentToolCall: { id: string; name: string; arguments: string } | null = null;

                try {
                        while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;

                                buffer += decoder.decode(value, { stream: true });
                                const lines = buffer.split('\n');
                                buffer = lines.pop() ?? '';

                                for (const line of lines) {
                                        const trimmed = line.trim();
                                        if (!trimmed || !trimmed.startsWith('data: ')) continue;
                                        const data = trimmed.slice(6);
                                        if (data === '[DONE]') {
                                                if (currentToolCall) {
                                                        yield { type: 'tool_end', toolId: currentToolCall.id, toolName: currentToolCall.name, toolInput: currentToolCall.arguments };
                                                        currentToolCall = null;
                                                }
                                                yield { type: 'done', stopReason: 'stop' };
                                                return;
                                        }

                                        try {
                                                const parsed = JSON.parse(data) as {
                                                        choices?: Array<{
                                                                delta?: {
                                                                        content?: string;
                                                                        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string }; index?: number }>;
                                                                };
                                                                finish_reason?: string;
                                                        }>;
                                                };

                                                const choice = parsed.choices?.[0];
                                                if (!choice) continue;

                                                const delta = choice.delta;
                                                if (!delta) continue;

                                                // Handle tool calls
                                                if (delta.tool_calls && delta.tool_calls.length > 0) {
                                                        for (const tc of delta.tool_calls) {
                                                                if (tc.id && tc.function?.name) {
                                                                        if (currentToolCall) {
                                                                                yield { type: 'tool_end', toolId: currentToolCall.id, toolName: currentToolCall.name, toolInput: currentToolCall.arguments };
                                                                        }
                                                                        currentToolCall = { id: tc.id, name: tc.function.name, arguments: '' };
                                                                        yield { type: 'tool_start', toolId: tc.id, toolName: tc.function.name };
                                                                }
                                                                if (tc.function?.arguments && currentToolCall) {
                                                                        currentToolCall.arguments += tc.function.arguments;
                                                                        yield { type: 'tool_input', toolId: currentToolCall.id, text: tc.function.arguments };
                                                                }
                                                        }
                                                }

                                                // Handle text content
                                                if (delta.content) {
                                                        yield { type: 'token', text: delta.content };
                                                }

                                                if (choice.finish_reason === 'tool_calls' && currentToolCall) {
                                                        yield { type: 'tool_end', toolId: currentToolCall.id, toolName: currentToolCall.name, toolInput: currentToolCall.arguments };
                                                        currentToolCall = null;
                                                }
                                        } catch {
                                                // Skip malformed JSON chunks
                                        }
                                }
                        }
                } finally {
                        reader.releaseLock();
                }

                yield { type: 'done', stopReason: 'stop' };
        }
}
