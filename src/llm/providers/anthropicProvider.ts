/**
 * anthropicProvider.ts — Layer 2 concrete IConstructAIProvider for the
 * Anthropic Messages API (https://api.anthropic.com/v1/messages).
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/llm/cloudProvider.ts`
 *              (Anthropic-specific portions only: chatAnthropic(),
 *              convertToAnthropicMessages(), convertToAnthropicTools(),
 *              checkAnthropicStatus(), completeAnthropic()).
 * Port strategy: PORT WITH TRANSLATION + REWRITE. The Anthropic chat
 * logic is preserved (SSE parsing, content-block handling, retry/backoff,
 * tool_use/tool_result translation). The wrapper structure is rewritten
 * to be Anthropic-only (the old CloudProvider handled 12+ providers via
 * a single class with branching; fresh has one class per provider per
 * 02_ARCHITECTURE.md §6).
 *
 * 02_ARCHITECTURE.md §6 mapping table: Layer 2 — port with translation
 * (Anthropic subset extracted from cloudProvider.ts).
 *
 * v0.1 scope: This is the ONLY provider ported in Round 2A. The package.json
 * default for `kovix.llm.activeProvider` is "anthropic" — Claude Sonnet 4
 * is the default model. Additional providers (OpenAI, Ollama, etc.) ship
 * in later Phase 3 rounds per 02_ARCHITECTURE.md §6 porting order.
 *
 * Translation notes:
 *   - `Disposable` (VS Code internal) → custom minimal Disposable
 *     interface. Same pattern as pendingChangesService.ts.
 *   - `Emitter<T>` (VS Code internal) → `vscode.EventEmitter<T>`.
 *   - `ILogService` → `logger` from src/util/logger.ts.
 *   - `IConfigurationService.getValue<T>(key)` →
 *     `vscode.workspace.getConfiguration('kovix').get<T>(subKey, default)`.
 *   - `IStorageService` for the API key → `vscode.SecretStorage`
 *     (`context.secrets`). The old repo's ISecureKeyManager wrapped
 *     OS keychain; vscode.SecretStorage is the public extension API
 *     equivalent (backed by Keychain on macOS, Credential Manager on
 *     Windows, libsecret on Linux).
 *   - The old repo's `LazyCloudProvider` DI-cycle workaround is GONE.
 *     There's no DI container in fresh, so there's no cycle to break.
 *   - The old repo's auto-detection of Anthropic-by-key-prefix
 *     (`sk-ant-`) is GONE — we know we're Anthropic because we're the
 *     Anthropic provider class.
 *
 * What is PRESERVED verbatim:
 *   - The full Anthropic SSE parsing state machine (content_block_start,
 *     content_block_delta, content_block_stop, message_delta, error).
 *   - The retry/backoff logic for 429 and 5xx responses (exponential
 *     backoff, MAX_RETRIES=3, abort-signal-aware sleep).
 *   - The error type mapping (401 → ConstructAuthError, 429 →
 *     ConstructRateLimitError, 529 → ConstructOverloadedError).
 *   - The Anthropic message conversion (system stripped, tool_result
 *     wrapped in user message, leading non-user messages shifted off).
 *   - The Anthropic tool conversion (name + description + input_schema).
 *   - The `anthropic-version: 2023-06-01` and
 *     `anthropic-dangerous-direct-browser-access: true` headers.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension
 * route). SEC-5 (redact secrets in logs) preserved via redactSecrets().
 */

import * as vscode from 'vscode';
import { logger } from '../../util/logger';
import { redactSecrets } from '../../security/secretRedactor';
import {
        AIProviderType,
        AIStreamEvent,
        ConstructAuthError,
        ConstructOverloadedError,
        ConstructRateLimitError,
        IChatMessage,
        IChatOptions,
        ICompleteOptions,
        ICompleteResult,
        IConstructAIProvider,
        IModelInfo,
        IToolDefinition,
        ProviderStatus,
} from '../../types/llm';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const MAX_RETRIES = 3;
const SECRET_KEY = 'kovix.apiKey.anthropic';

/**
 * Parsed SSE chunk from the Anthropic streaming API.
 * Preserved verbatim from old repo.
 */
interface IAnthropicSSEChunk {
        type: string;
        content_block?: { type: string; id?: string; name?: string; text?: string };
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        error?: { message?: string };
}

/**
 * AnthropicProvider — concrete AI provider for the Anthropic Messages API.
 *
 * NOT OFFLINE: requires internet. The user must set an API key via the
 * VS Code SecretStorage (the future "Kovix: Manage API Keys" command
 * writes to `context.secrets`). The provider reads the key lazily on
 * each request so key rotation takes effect without re-activation.
 */
export class AnthropicProvider implements IConstructAIProvider, vscode.Disposable {

        readonly providerType: AIProviderType = 'anthropic';

        private _activeModel: IModelInfo | undefined;
        private _status: ProviderStatus = ProviderStatus.Unknown;
        private _cachedModels: IModelInfo[] = [];
        private _apiKey: string | undefined;

        private readonly _onDidChangeActiveModel = new vscode.EventEmitter<IModelInfo | undefined>();
        readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event;
        private readonly _onDidChangeStatus = new vscode.EventEmitter<ProviderStatus>();
        readonly onDidChangeStatus = this._onDidChangeStatus.event;

        /**
         * @param secrets The VS Code SecretStorage (`context.secrets` from
         *                the extension context). Used for API key retrieval.
         *                Passed in by the future services.ts registry.
         */
        constructor(private readonly secrets: vscode.SecretStorage) {
                // Default model is set eagerly so the provider is usable before
                // the first checkStatus() call. The model ID is overridable via
                // the `kovix.llm.activeModel` setting.
                const configuredModel = vscode.workspace
                        .getConfiguration('kovix')
                        .get<string>('llm.activeModel', DEFAULT_ANTHROPIC_MODEL);

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

        /**
         * Read the API key from SecretStorage. Cached per-call only — we
         * re-read on every checkStatus()/chat() so a key rotation via the
         * "Manage API Keys" command takes effect without re-activation.
         *
         * SEC-7: the key is NEVER written to settings.json or storage.json.
         * Only SecretStorage (OS keychain) holds the plaintext.
         */
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

                // Anthropic has a /v1/models endpoint as of 2024-05. Try it
                // first; fall back to the static list if it fails (offline,
                // 401, etc.). The static list is what the old repo used.
                try {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 10_000);
                        const response = await fetch(ANTHROPIC_MODELS_URL, {
                                headers: {
                                        'x-api-key': key,
                                        'anthropic-version': '2023-06-01',
                                },
                                signal: controller.signal,
                        });
                        clearTimeout(timeout);

                        if (response.ok) {
                                const data = await response.json() as { data?: Array<{ id: string; display_name?: string }> };
                                if (data.data && data.data.length > 0) {
                                        this._cachedModels = data.data.map(m => ({
                                                id: m.id,
                                                displayName: m.display_name || m.id,
                                                provider: 'anthropic',
                                                contextWindowTokens: 200_000,
                                                supportsTools: true,
                                                supportsStreaming: true,
                                        }));
                                }
                                this._setStatus(ProviderStatus.Available);
                                return this._status;
                        }
                        if (response.status === 401) {
                                this._setStatus(ProviderStatus.Unreachable);
                                return this._status;
                        }
                } catch {
                        // Network error or abort — fall through to static list.
                }

                // Static fallback list (preserved from old repo's checkAnthropicStatus).
                this._cachedModels = [
                        {
                                id: DEFAULT_ANTHROPIC_MODEL,
                                displayName: 'Claude Sonnet 4',
                                provider: 'anthropic',
                                contextWindowTokens: 200_000,
                                supportsTools: true,
                                supportsStreaming: true,
                        },
                        {
                                id: 'claude-3-5-sonnet-20241022',
                                displayName: 'Claude 3.5 Sonnet',
                                provider: 'anthropic',
                                contextWindowTokens: 200_000,
                                supportsTools: true,
                                supportsStreaming: true,
                        },
                        {
                                id: 'claude-3-5-haiku-20241022',
                                displayName: 'Claude 3.5 Haiku',
                                provider: 'anthropic',
                                contextWindowTokens: 200_000,
                                supportsTools: true,
                                supportsStreaming: true,
                        },
                ];
                this._setStatus(ProviderStatus.Available);
                return this._status;
        }

        async listModels(): Promise<IModelInfo[]> {
                if (this._cachedModels.length === 0) {
                        await this.checkStatus();
                }
                return this._cachedModels;
        }

        getActiveModel(): IModelInfo | undefined {
                return this._activeModel;
        }

        async setActiveModel(modelId: string): Promise<boolean> {
                const models = await this.listModels();
                const found = models.find(m => m.id === modelId);
                if (!found) {
                        logger.warn(`[AnthropicProvider] Model not found: ${modelId}`);
                        return false;
                }
                this._activeModel = found;
                this._onDidChangeActiveModel.fire(found);
                return true;
        }

        // -------------------------------------------------------------------------
        // chat() — streaming via Anthropic Messages API
        // -------------------------------------------------------------------------

        async *chat(
                messages: IChatMessage[],
                tools: IToolDefinition[],
                options?: IChatOptions,
        ): AsyncIterable<AIStreamEvent> {
                const apiKey = await this._resolveApiKey();
                if (!apiKey) {
                        yield {
                                type: 'error',
                                text: 'Anthropic API key is not set. Use "Kovix: Manage API Keys" to set it.',
                        };
                        return;
                }

                if (!this._activeModel) {
                        yield { type: 'error', text: 'No active Anthropic model set.' };
                        return;
                }

                const anthropicMessages = this._convertToAnthropicMessages(messages);
                const anthropicTools = this._convertToAnthropicTools(tools);

                const body: Record<string, unknown> = {
                        model: this._activeModel.id,
                        max_tokens: options?.maxTokens ?? 8192,
                        messages: anthropicMessages,
                        stream: true,
                };

                if (options?.systemPrompt) {
                        body.system = options.systemPrompt;
                }
                if (options?.temperature !== undefined) {
                        body.temperature = options.temperature;
                }
                if (anthropicTools.length > 0) {
                        body.tools = anthropicTools;
                }

                let retryCount = 0;

                while (retryCount <= MAX_RETRIES) {
                        try {
                                const response = await fetch(ANTHROPIC_API_URL, {
                                        method: 'POST',
                                        headers: {
                                                'Content-Type': 'application/json',
                                                'x-api-key': apiKey,
                                                'anthropic-version': '2023-06-01',
                                                'anthropic-dangerous-direct-browser-access': 'true',
                                        },
                                        body: JSON.stringify(body),
                                        signal: options?.signal,
                                });

                                if (response.status === 401) {
                                        throw new ConstructAuthError(
                                                'Anthropic API key is invalid. Use "Kovix: Manage API Keys" to update it.',
                                        );
                                }
                                if (response.status === 529) {
                                        throw new ConstructOverloadedError(
                                                'Anthropic API is overloaded. Please try again later.',
                                        );
                                }
                                if (response.status === 429) {
                                        retryCount++;
                                        if (retryCount > MAX_RETRIES) {
                                                const retryAfterHeader = response.headers.get('retry-after');
                                                const retryAfter = retryAfterHeader
                                                        ? parseInt(retryAfterHeader, 10)
                                                        : undefined;
                                                throw new ConstructRateLimitError(
                                                        'Rate limited by Anthropic API. Please try again later.',
                                                        retryAfter,
                                                );
                                        }
                                        const backoffMs = Math.pow(2, retryCount) * 1000;
                                        yield {
                                                type: 'error',
                                                text: `Rate limited. Retrying in ${backoffMs / 1000}s...`,
                                        };
                                        await this._sleep(backoffMs, options?.signal);
                                        continue;
                                }
                                if (response.status >= 500) {
                                        retryCount++;
                                        if (retryCount > MAX_RETRIES) {
                                                throw new ConstructOverloadedError(
                                                        `Anthropic API server error (${response.status}).`,
                                                );
                                        }
                                        await this._sleep(Math.pow(2, retryCount) * 1000, options?.signal);
                                        continue;
                                }
                                if (!response.ok) {
                                        const errorText = await response.text();
                                        yield {
                                                type: 'error',
                                                text: `Anthropic API error (${response.status}): ${errorText}`,
                                        };
                                        return;
                                }
                                if (!response.body) {
                                        yield { type: 'error', text: 'No response body from Anthropic API.' };
                                        return;
                                }

                                // Parse Anthropic SSE stream (preserved verbatim from old repo).
                                let currentToolId: string | null = null;
                                let currentToolName: string | null = null;
                                let currentToolInput = '';

                                const reader = response.body.getReader();
                                const decoder = new TextDecoder();
                                let buffer = '';

                                try {
                                        while (true) {
                                                const { done, value } = await reader.read();
                                                if (done) { break; }

                                                buffer += decoder.decode(value, { stream: true });
                                                const lines = buffer.split('\n');
                                                buffer = lines.pop() ?? '';

                                                for (const line of lines) {
                                                        const trimmed = line.trim();
                                                        if (!trimmed || !trimmed.startsWith('data: ')) { continue; }

                                                        const jsonStr = trimmed.slice(6);
                                                        if (jsonStr === '[DONE]') { continue; }

                                                        let chunk: IAnthropicSSEChunk;
                                                        try {
                                                                chunk = JSON.parse(jsonStr) as IAnthropicSSEChunk;
                                                        } catch {
                                                                continue;
                                                        }

                                                        const eventType = chunk.type;

                                                        if (eventType === 'content_block_start') {
                                                                const contentBlock = chunk.content_block;
                                                                if (contentBlock?.type === 'tool_use') {
                                                                        currentToolId = contentBlock.id ?? null;
                                                                        currentToolName = contentBlock.name ?? null;
                                                                        currentToolInput = '';
                                                                        yield {
                                                                                type: 'tool_start',
                                                                                toolId: currentToolId ?? '',
                                                                                toolName: currentToolName ?? '',
                                                                        };
                                                                }
                                                        } else if (eventType === 'content_block_delta') {
                                                                const delta = chunk.delta;
                                                                if (delta?.type === 'text_delta' && delta.text) {
                                                                        yield { type: 'token', text: delta.text };
                                                                } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                                                                        currentToolInput += delta.partial_json;
                                                                        yield {
                                                                                type: 'tool_input',
                                                                                toolId: currentToolId ?? '',
                                                                                text: delta.partial_json,
                                                                        };
                                                                }
                                                        } else if (eventType === 'content_block_stop') {
                                                                if (currentToolId && currentToolName) {
                                                                        let parsedInput: unknown = {};
                                                                        if (currentToolInput) {
                                                                                try {
                                                                                        parsedInput = JSON.parse(currentToolInput);
                                                                                } catch {
                                                                                        parsedInput = { raw: currentToolInput };
                                                                                }
                                                                        }
                                                                        yield {
                                                                                type: 'tool_end',
                                                                                toolId: currentToolId,
                                                                                toolName: currentToolName,
                                                                                toolInput: parsedInput,
                                                                        };
                                                                        currentToolId = null;
                                                                        currentToolName = null;
                                                                        currentToolInput = '';
                                                                }
                                                        } else if (eventType === 'message_delta') {
                                                                const delta = chunk.delta;
                                                                if (delta?.stop_reason) {
                                                                        yield { type: 'done', stopReason: delta.stop_reason };
                                                                }
                                                        } else if (eventType === 'error') {
                                                                yield {
                                                                        type: 'error',
                                                                        text: chunk.error?.message ?? 'Unknown streaming error',
                                                                };
                                                        }
                                                }
                                        }
                                } finally {
                                        reader.releaseLock();
                                }

                                return;
                        } catch (error: unknown) {
                                if (error instanceof DOMException && error.name === 'AbortError') {
                                        yield { type: 'error', text: 'Request cancelled.' };
                                        return;
                                }

                                // Re-throw typed errors (auth, rate limit, overloaded) without retry.
                                if (
                                        error instanceof ConstructAuthError ||
                                        error instanceof ConstructRateLimitError ||
                                        error instanceof ConstructOverloadedError
                                ) {
                                        yield { type: 'error', text: error.message };
                                        return;
                                }

                                retryCount++;
                                if (retryCount > MAX_RETRIES) {
                                        yield {
                                                type: 'error',
                                                text: `Anthropic connection failed: ${error instanceof Error ? error.message : String(error)}`,
                                        };
                                        return;
                                }

                                await this._sleep(Math.pow(2, retryCount) * 1000, options?.signal);
                        }
                }
        }

        // -------------------------------------------------------------------------
        // complete() — inline code completion (DEFERRED to v1.1)
        // -------------------------------------------------------------------------

        async complete(
                _prefix: string,
                _suffix: string,
                _options?: ICompleteOptions,
        ): Promise<ICompleteResult> {
                // Per 02_ARCHITECTURE.md §9 non-goals: inline completions are
                // deferred to v1.1. The interface contract requires the method
                // to exist; we return an empty result so v1.0 call sites (none
                // today) fail gracefully.
                logger.verbose('[AnthropicProvider] complete() called — deferred to v1.1');
                return { text: '', finished: true };
        }

        // -------------------------------------------------------------------------
        // Private helpers (preserved from old repo)
        // -------------------------------------------------------------------------

        /**
         * Convert unified messages to Anthropic Messages API format.
         * Preserved verbatim from old repo's convertToAnthropicMessages.
         *
         * Anthropic uses content blocks (tool_use, tool_result) instead of
         * separate message roles for tool calls. System messages are
         * stripped (passed via the top-level `system` field instead).
         */
        private _convertToAnthropicMessages(
                messages: IChatMessage[],
        ): Array<Record<string, unknown>> {
                const result: Array<Record<string, unknown>> = [];

                for (const msg of messages) {
                        if (msg.role === 'system') {
                                // System messages are handled via the top-level 'system'
                                // field in the request body, skip here.
                                continue;
                        } else if (msg.role === 'user') {
                                result.push({ role: 'user', content: msg.content });
                        } else if (msg.role === 'assistant') {
                                const contentBlocks: Array<Record<string, unknown>> = [];
                                if (msg.content) {
                                        contentBlocks.push({ type: 'text', text: msg.content });
                                }
                                if (msg.toolCalls && msg.toolCalls.length > 0) {
                                        for (const tc of msg.toolCalls) {
                                                let parsedArgs: unknown = {};
                                                try {
                                                        parsedArgs = JSON.parse(tc.arguments);
                                                } catch {
                                                        parsedArgs = { raw: tc.arguments };
                                                }
                                                contentBlocks.push({
                                                        type: 'tool_use',
                                                        id: tc.id,
                                                        name: tc.name,
                                                        input: parsedArgs,
                                                });
                                        }
                                }
                                result.push({
                                        role: 'assistant',
                                        content: contentBlocks.length > 0 ? contentBlocks : msg.content,
                                });
                        } else if (msg.role === 'tool') {
                                // Anthropic wraps tool results in a user message with
                                // tool_result content blocks.
                                result.push({
                                        role: 'user',
                                        content: [{
                                                type: 'tool_result',
                                                tool_use_id: msg.toolCallId,
                                                content: msg.content,
                                        }],
                                });
                        }
                }

                // Anthropic requires the conversation to start with a user
                // message. Remove any leading assistant messages.
                while (result.length > 0 && (result[0] as { role: string }).role !== 'user') {
                        result.shift();
                }

                return result;
        }

        /**
         * Convert unified tool definitions to Anthropic tool format.
         * Preserved verbatim from old repo's convertToAnthropicTools.
         */
        private _convertToAnthropicTools(
                tools: IToolDefinition[],
        ): Array<Record<string, unknown>> {
                return tools.map(tool => ({
                        name: tool.name,
                        description: tool.description,
                        input_schema: tool.inputSchema,
                }));
        }

        /**
         * Abort-signal-aware sleep. Rejects with AbortError if the signal
         * fires before the timeout. Preserved from old repo.
         */
        private _sleep(ms: number, signal?: AbortSignal): Promise<void> {
                return new Promise((resolve, reject) => {
                        const timer = setTimeout(resolve, ms);
                        signal?.addEventListener('abort', () => {
                                clearTimeout(timer);
                                reject(new DOMException('Aborted', 'AbortError'));
                        }, { once: true });
                });
        }

        dispose(): void {
                this._onDidChangeActiveModel.dispose();
                this._onDidChangeStatus.dispose();
        }
}
