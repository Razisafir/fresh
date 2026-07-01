/**
 * geminiProvider.ts — IConstructAIProvider for Google Gemini.
 *
 * Google Gemini provides a REST API at
 * `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent`.
 * While not fully OpenAI-compatible, the chat and tool-calling semantics are
 * similar enough to adapt into the IConstructAIProvider interface.
 *
 * Default models:
 *   - gemini-2.0-flash       (fast, cost-effective)
 *   - gemini-2.0-flash-lite  (lightweight)
 *   - gemini-1.5-pro         (best reasoning, long context)
 *   - gemini-1.5-flash       (balanced)
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


const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
const FALLBACK_MODELS = [
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-pro',
        'gemini-1.5-flash',
];
const MAX_RETRIES = 3;
const SECRET_KEY = 'kovix.apiKey.gemini';

/** Default max_tokens for Gemini models. */
const DEFAULT_MAX_TOKENS = 8_192;

export class GeminiProvider implements IConstructAIProvider {
        readonly providerType: AIProviderType = 'gemini';

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
                        id: DEFAULT_GEMINI_MODEL,
                        displayName: 'Gemini 2.0 Flash',
                        provider: 'gemini',
                        contextWindowTokens: 1_048_576,
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
                logger.warn(`[GeminiProvider] Model not found: ${modelId}`);
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
                        const response = await fetch(`${GEMINI_BASE_URL}/models?key=${apiKey}`, {
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

                        const response = await fetch(`${GEMINI_BASE_URL}/models?key=${apiKey}`, {
                                signal: AbortSignal.timeout(10_000),
                        });

                        if (!response.ok) return this._fallbackModels();

                        const data = await response.json() as { models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number }> };
                        if (!data.models) return this._fallbackModels();

                        this._modelsCache = data.models
                                .filter(m => m.name.includes('gemini'))
                                .map(m => {
                                        const id = m.name.replace('models/', '');
                                        return {
                                                id,
                                                displayName: m.displayName ?? id,
                                                provider: 'gemini' as AIProviderType,
                                                contextWindowTokens: (m.inputTokenLimit ?? 1_000_000) + (m.outputTokenLimit ?? 8_192),
                                                supportsTools: true,
                                                supportsStreaming: true,
                                        };
                                });
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
                        yield { type: 'error', text: 'Gemini API key not configured. Set it via /provider gemini or settings.' };
                        return;
                }

                const modelId = this._activeModel?.id ?? DEFAULT_GEMINI_MODEL;
                const url = `${GEMINI_BASE_URL}/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;

                const body = this._buildGeminiRequestBody(messages, tools, options);
                let retries = 0;

                while (retries < MAX_RETRIES) {
                        try {
                                const response = await fetch(url, {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify(body),
                                        signal: options?.signal ?? AbortSignal.timeout(120_000),
                                });

                                if (response.status === 429) {
                                        const delay = Math.pow(2, retries) * 1000;
                                        logger.warn(`[GeminiProvider] Rate limited (429). Retry ${retries + 1}/${MAX_RETRIES} after ${delay}ms`);
                                        await new Promise(r => setTimeout(r, delay));
                                        retries++;
                                        continue;
                                }

                                if (response.status === 401 || response.status === 403) {
                                        yield { type: 'error', text: 'Gemini API key is invalid or lacks permissions. Please check your key.' };
                                        return;
                                }

                                if (!response.ok) {
                                        const text = await response.text().catch(() => 'unknown error');
                                        yield { type: 'error', text: `Gemini API error (${response.status}): ${redactSecrets(text)}` };
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
                                        yield { type: 'error', text: `Gemini request failed after ${MAX_RETRIES} retries: ${err instanceof Error ? err.message : String(err)}` };
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
                        provider: 'gemini' as AIProviderType,
                        contextWindowTokens: id.includes('1.5-pro') ? 2_097_152 : 1_048_576,
                        supportsTools: true,
                        supportsStreaming: true,
                }));
        }

        /**
         * Convert IChatMessage[] to Gemini's content format.
         * Gemini uses 'user' and 'model' roles instead of 'user' and 'assistant'.
         */
        private _convertMessages(messages: IChatMessage[]): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
                return messages.map(m => {
                        const role = m.role === 'assistant' ? 'model' : m.role === 'tool' ? 'user' : m.role;
                        const parts: Array<Record<string, unknown>> = [];

                        if (m.content) {
                                parts.push({ text: m.content });
                        }

                        if (m.toolCalls) {
                                for (const tc of m.toolCalls) {
                                        parts.push({
                                                functionCall: {
                                                        name: tc.name,
                                                        args: JSON.parse(tc.arguments || '{}'),
                                                },
                                        });
                                }
                        }

                        if (m.role === 'tool' && m.toolCallId) {
                                // Gemini uses functionResponse for tool results
                                parts.push({
                                        functionResponse: {
                                                name: m.toolCallId,
                                                response: m.content ? JSON.parse(m.content) : {},
                                        },
                                });
                        }

                        return { role, parts };
                });
        }

        private _buildGeminiRequestBody(
                messages: IChatMessage[],
                tools: IToolDefinition[],
                options?: IChatOptions,
        ): Record<string, unknown> {
                const contents = this._convertMessages(messages);

                const body: Record<string, unknown> = {
                        contents,
                        generationConfig: {
                                maxOutputTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
                                temperature: options?.temperature ?? 0.7,
                        },
                };

                if (options?.systemPrompt) {
                        body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
                }

                if (tools.length > 0) {
                        body.tools = [{
                                functionDeclarations: tools.map(t => ({
                                        name: t.name,
                                        description: t.description,
                                        parameters: t.inputSchema,
                                })),
                        }];
                }

                return body;
        }

        private async *_processStream(response: Response): AsyncIterable<AIStreamEvent> {
                const reader = response.body?.getReader();
                if (!reader) {
                        yield { type: 'error', text: 'Gemini: No response body' };
                        return;
                }

                const decoder = new TextDecoder();
                let buffer = '';

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

                                        try {
                                                const parsed = JSON.parse(data) as {
                                                        candidates?: Array<{
                                                                content?: {
                                                                        parts?: Array<{
                                                                                text?: string;
                                                                                functionCall?: { name: string; args: Record<string, unknown> };
                                                                        }>;
                                                                };
                                                                finishReason?: string;
                                                        }>;
                                                };

                                                const candidate = parsed.candidates?.[0];
                                                if (!candidate?.content?.parts) continue;

                                                for (const part of candidate.content.parts) {
                                                        if (part.text) {
                                                                yield { type: 'token', text: part.text };
                                                        }
                                                        if (part.functionCall) {
                                                                const id = `gemini_tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                                                                yield { type: 'tool_start', toolId: id, toolName: part.functionCall.name };
                                                                const args = JSON.stringify(part.functionCall.args);
                                                                yield { type: 'tool_input', toolId: id, text: args };
                                                                yield { type: 'tool_end', toolId: id, toolName: part.functionCall.name, toolInput: args };
                                                        }
                                                }

                                                if (candidate.finishReason === 'STOP') {
                                                        yield { type: 'done', stopReason: 'stop' };
                                                        return;
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
