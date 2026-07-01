/**
 * lmStudioProvider.ts — IConstructAIProvider for LM Studio.
 *
 * LM Studio provides an OpenAI-compatible API at
 * `http://localhost:1234/v1/chat/completions` by default. The base URL is
 * configurable via the `kovix.lmStudio.baseUrl` secret. This provider uses the
 * same SSE streaming, tool/function calling, and retry logic as the other
 * OpenAI-compatible providers.
 *
 * LM Studio is a local-only provider (like Ollama) — no API key is required.
 * Models are discovered via `GET /v1/models`.
 */

import { logger } from '../../util/logger';
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


const LM_STUDIO_DEFAULT_BASE_URL = 'http://localhost:1234';
const LM_STUDIO_CHAT_PATH = '/v1/chat/completions';
const LM_STUDIO_MODELS_PATH = '/v1/models';
const DEFAULT_LM_STUDIO_MODEL = '';  // Will be set from first discovered model
const MAX_RETRIES = 2;
const BASE_URL_SECRET_KEY = 'kovix.lmStudio.baseUrl';

/** Default max_tokens for LM Studio models. */
const DEFAULT_MAX_TOKENS = 8_192;

export class LmStudioProvider implements IConstructAIProvider {
        readonly providerType: AIProviderType = 'lm-studio';

        private readonly _secrets: ISecrets;
        private _baseUrl: string;
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
                this._baseUrl = LM_STUDIO_DEFAULT_BASE_URL;
                this._loadBaseUrl();
        }

        private async _loadBaseUrl(): Promise<void> {
                try {
                        const custom = await this._secrets.get(BASE_URL_SECRET_KEY);
                        if (custom) {
                                this._baseUrl = custom.replace(/\/$/, '');
                        }
                } catch {
                        // Use default
                }
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
                logger.warn(`[LmStudioProvider] Model not found: ${modelId}`);
                return false;
        }

        isOffline(): boolean {
                return true; // LM Studio is always local
        }

        async checkStatus(): Promise<ProviderStatus> {
                try {
                        const response = await fetch(`${this._baseUrl}${LM_STUDIO_MODELS_PATH}`, {
                                signal: AbortSignal.timeout(3_000),
                        });
                        this._setStatus(response.ok ? ProviderStatus.Available : ProviderStatus.Unreachable);
                } catch {
                        this._setStatus(ProviderStatus.Unreachable);
                }
                return this._status;
        }

        async listModels(): Promise<IModelInfo[]> {
                const now = Date.now();
                if (this._modelsCache && now - this._modelsCacheTime < 60_000) {
                        return this._modelsCache;
                }

                try {
                        const response = await fetch(`${this._baseUrl}${LM_STUDIO_MODELS_PATH}`, {
                                signal: AbortSignal.timeout(5_000),
                        });

                        if (!response.ok) return [];

                        const data = await response.json() as { data?: Array<{ id: string }> };
                        if (!data.data || data.data.length === 0) return [];

                        this._modelsCache = data.data.map(m => ({
                                id: m.id,
                                displayName: m.id,
                                provider: 'lm-studio' as AIProviderType,
                                contextWindowTokens: 32_768, // LM Studio models vary widely
                                supportsTools: true,
                                supportsStreaming: true,
                        }));
                        this._modelsCacheTime = now;

                        // Auto-select first model if none selected
                        if (!this._activeModel && this._modelsCache.length > 0) {
                                this._activeModel = this._modelsCache[0];
                        }

                        return this._modelsCache;
                } catch {
                        return [];
                }
        }

        async *chat(
                messages: IChatMessage[],
                tools: IToolDefinition[],
                options?: IChatOptions,
        ): AsyncIterable<AIStreamEvent> {
                if (!this._activeModel) {
                        const models = await this.listModels();
                        if (models.length === 0) {
                                yield { type: 'error', text: 'LM Studio: No models loaded. Start LM Studio and load a model first.' };
                                return;
                        }
                }

                const url = `${this._baseUrl}${LM_STUDIO_CHAT_PATH}`;
                const body = this._buildRequestBody(messages, tools, options);
                let retries = 0;

                while (retries < MAX_RETRIES) {
                        try {
                                const response = await fetch(url, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify(body),
                                        signal: options?.signal ?? AbortSignal.timeout(120_000),
                                });

                                if (!response.ok) {
                                        const text = await response.text().catch(() => 'unknown error');
                                        yield { type: 'error', text: `LM Studio API error (${response.status}): ${text}` };
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
                                        yield { type: 'error', text: `LM Studio request failed: ${err instanceof Error ? err.message : String(err)}. Ensure LM Studio is running at ${this._baseUrl}` };
                                        return;
                                }
                                await new Promise(r => setTimeout(r, 1000));
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

        private _buildRequestBody(
                messages: IChatMessage[],
                tools: IToolDefinition[],
                options?: IChatOptions,
        ): Record<string, unknown> {
                const body: Record<string, unknown> = {
                        model: this._activeModel?.id ?? DEFAULT_LM_STUDIO_MODEL,
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
                        yield { type: 'error', text: 'LM Studio: No response body' };
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
