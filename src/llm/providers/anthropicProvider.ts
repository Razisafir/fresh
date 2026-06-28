/**
 * anthropicProvider.ts — Layer 2 concrete IConstructAIProvider for the
 * Anthropic Messages API.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.Disposable → custom Disposable interface
 *   - vscode.EventEmitter → local EventEmitter
 *   - vscode.SecretStorage → ISecrets from platform types
 *   - vscode.workspace.getConfiguration → getAppState().config
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

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
// Valid Anthropic model IDs. The default must be a real model ID that the
// Anthropic API actually accepts. The listModels() endpoint fetches the
// authoritative list at runtime; this fallback is for when the API is unreachable.
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const FALLBACK_MODELS = [
        'claude-sonnet-4-20250514',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
];
const MAX_RETRIES = 3;
const SECRET_KEY = 'kovix.apiKey.anthropic';

// ---------------------------------------------------------------------------
// Minimal Disposable + EventEmitter (replaces vscode.*)
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
// AnthropicProvider
// ---------------------------------------------------------------------------

interface IAnthropicSSEChunk {
        type: string;
        content_block?: { type: string; id?: string; name?: string; text?: string };
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        error?: { message?: string };
}

export class AnthropicProvider implements IConstructAIProvider, Disposable {

        readonly providerType: AIProviderType = 'anthropic';

        private _activeModel: IModelInfo | undefined;
        private _status: ProviderStatus = ProviderStatus.Unknown;
        private _cachedModels: IModelInfo[] = [];
        private _apiKey: string | undefined;

        private readonly _onDidChangeActiveModel = new EventEmitter<IModelInfo | undefined>();
        readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event;
        private readonly _onDidChangeStatus = new EventEmitter<ProviderStatus>();
        readonly onDidChangeStatus = this._onDidChangeStatus.event;

        constructor(private readonly secrets: ISecrets) {
                const configuredModel = getAppState().config.llmActiveModel || DEFAULT_ANTHROPIC_MODEL;

                this._activeModel = {
                        id: configuredModel || DEFAULT_ANTHROPIC_MODEL,
                        displayName: configuredModel || 'Claude Sonnet 4',
                        provider: 'anthropic',
                        contextWindowTokens: 200_000,
                        supportsTools: true,
                        supportsStreaming: true,
                };

                logger.info(redactSecrets('[AnthropicProvider] Initialized (default model: ' + this._activeModel.id + ')'));
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
                        const response = await fetch(ANTHROPIC_MODELS_URL, {
                                headers: {
                                        'x-api-key': key,
                                        'anthropic-version': '2023-06-01',
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
                        yield { type: 'error', text: 'Anthropic API key not set. Set it via the settings dialog.' };
                        return;
                }

                const body = this.buildRequestBody(messages, tools, options);

                let retries = 0;
                while (retries < MAX_RETRIES) {
                        try {
                                const response = await fetch(ANTHROPIC_API_URL, {
                                        method: 'POST',
                                        headers: {
                                                'content-type': 'application/json',
                                                'x-api-key': key,
                                                'anthropic-version': '2023-06-01',
                                                'anthropic-dangerous-direct-browser-access': 'true',
                                        },
                                        body: JSON.stringify(body),
                                        signal: options?.signal,
                                });

                                if (response.status === 429) {
                                        const retryAfter = response.headers.get('retry-after');
                                        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000 * (retries + 1);
                                        logger.warn(`[AnthropicProvider] Rate limited, retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
                                        await new Promise(r => setTimeout(r, waitMs));
                                        retries++;
                                        continue;
                                }

                                if (response.status === 529 || response.status >= 500) {
                                        const waitMs = 2000 * (retries + 1);
                                        logger.warn(`[AnthropicProvider] Server error ${response.status}, retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
                                        await new Promise(r => setTimeout(r, waitMs));
                                        retries++;
                                        continue;
                                }

                                if (response.status === 401 || response.status === 403) {
                                        yield { type: 'error', text: 'Anthropic API key is invalid or revoked.' };
                                        return;
                                }

                                if (!response.ok) {
                                        const errorText = await response.text().catch(() => 'unknown');
                                        yield { type: 'error', text: `Anthropic API error (${response.status}): ${errorText}` };
                                        return;
                                }

                                // Parse SSE stream
                                yield* this.parseSSEStream(response, options?.signal);
                                return;
                        } catch (error) {
                                if (error instanceof Error && error.name === 'AbortError') {
                                        return;
                                }
                                const msg = error instanceof Error ? error.message : String(error);
                                logger.error(`[AnthropicProvider] Request failed: ${msg}`);
                                yield { type: 'error', text: `Anthropic request failed: ${msg}` };
                                return;
                        }
                }

                yield { type: 'error', text: 'Anthropic API: max retries exceeded.' };
        }

        private buildRequestBody(
                messages: IChatMessage[],
                tools: IToolDefinition[],
                options?: IChatOptions,
        ): Record<string, unknown> {
                const anthropicMessages = this.convertToAnthropicMessages(messages);
                const anthropicTools = tools.length > 0 ? this.convertToAnthropicTools(tools) : undefined;

                return {
                        model: this._activeModel?.id ?? DEFAULT_ANTHROPIC_MODEL,
                        max_tokens: options?.maxTokens ?? 8192,
                        temperature: options?.temperature ?? 0.3,
                        messages: anthropicMessages,
                        tools: anthropicTools,
                        stream: true,
                        system: options?.systemPrompt ?? undefined,
                };
        }

        private convertToAnthropicMessages(messages: IChatMessage[]): unknown[] {
                return messages
                        .filter(m => m.role !== 'system')
                        .map(m => {
                                if (m.role === 'tool') {
                                        return {
                                                role: 'user',
                                                content: [{
                                                        type: 'tool_result',
                                                        tool_use_id: m.toolCallId ?? '',
                                                        content: m.content,
                                                }],
                                        };
                                }
                                if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
                                        const content: unknown[] = [];
                                        if (m.content) {
                                                content.push({ type: 'text', text: m.content });
                                        }
                                        for (const tc of m.toolCalls) {
                                                content.push({
                                                        type: 'tool_use',
                                                        id: tc.id,
                                                        name: tc.name,
                                                        input: JSON.parse(tc.arguments || '{}'),
                                                });
                                        }
                                        return { role: 'assistant', content };
                                }
                                return { role: m.role, content: m.content };
                        });
        }

        private convertToAnthropicTools(tools: IToolDefinition[]): unknown[] {
                return tools.map(t => ({
                        name: t.name,
                        description: t.description,
                        input_schema: t.inputSchema,
                }));
        }

        private async *parseSSEStream(response: Response, signal?: AbortSignal): AsyncIterable<AIStreamEvent> {
                const reader = response.body?.getReader();
                if (!reader) {
                        yield { type: 'error', text: 'Anthropic API returned empty body.' };
                        return;
                }

                const decoder = new TextDecoder();
                let buffer = '';
                let currentToolId: string | undefined;
                let currentToolName: string | undefined;

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
                                                        const chunk = JSON.parse(jsonStr) as IAnthropicSSEChunk;

                                                        if (chunk.type === 'content_block_start') {
                                                                if (chunk.content_block?.type === 'tool_use') {
                                                                        currentToolId = chunk.content_block.id;
                                                                        currentToolName = chunk.content_block.name;
                                                                        yield { type: 'tool_start', toolId: currentToolId ?? '', toolName: currentToolName ?? '' };
                                                                }
                                                        } else if (chunk.type === 'content_block_delta') {
                                                                if (chunk.delta?.type === 'text_delta' && chunk.delta.text) {
                                                                        yield { type: 'token', text: chunk.delta.text };
                                                                } else if (chunk.delta?.type === 'input_json_delta' && chunk.delta.partial_json) {
                                                                        yield { type: 'tool_input', toolId: currentToolId ?? '', text: chunk.delta.partial_json };
                                                                }
                                                        } else if (chunk.type === 'content_block_stop') {
                                                                if (currentToolId) {
                                                                        yield { type: 'tool_end', toolId: currentToolId, toolName: currentToolName ?? '', toolInput: undefined };
                                                                        currentToolId = undefined;
                                                                        currentToolName = undefined;
                                                                }
                                                        } else if (chunk.type === 'message_delta') {
                                                                if (chunk.delta?.stop_reason) {
                                                                        yield { type: 'done', stopReason: chunk.delta.stop_reason ?? 'end_turn' };
                                                                }
                                                        } else if (chunk.type === 'error') {
                                                                yield { type: 'error', text: chunk.error?.message ?? 'Unknown Anthropic stream error' };
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
                        const response = await fetch(ANTHROPIC_MODELS_URL, {
                                headers: {
                                        'x-api-key': key,
                                        'anthropic-version': '2023-06-01',
                                },
                        });
                        if (response.ok) {
                                const data = await response.json() as { data: Array<{ id: string; display_name?: string }> };
                                this._cachedModels = data.data.map(m => ({
                                        id: m.id,
                                        displayName: m.display_name ?? m.id,
                                        provider: 'anthropic' as AIProviderType,
                                        contextWindowTokens: 200_000,
                                        supportsTools: true,
                                        supportsStreaming: true,
                                }));
                                return this._cachedModels;
                        }
                } catch {
                        // Fallback to default model.
                }

                return this._activeModel ? [this._activeModel] : FALLBACK_MODELS.map(id => ({
                        id,
                        displayName: id,
                        provider: 'anthropic' as AIProviderType,
                        contextWindowTokens: 200_000,
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
                        provider: 'anthropic',
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
