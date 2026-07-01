/**
 * ollamaProvider.ts — IConstructAIProvider for local Ollama instances.
 *
 * Connects to a local Ollama server at `http://localhost:11434` by default.
 * Uses the OpenAI-compatible endpoint that Ollama provides
 * (`/v1/chat/completions`) for streaming chat with tool/function calling.
 *
 * Auto-discovers available models via `GET /api/tags`.
 *
 * Structure follows nvidiaProvider.ts (OpenAI-compatible) with Ollama-specific
 * adaptations for model discovery and health checking.
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

const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';
const OLLAMA_CHAT_URL = '/v1/chat/completions';
const OLLAMA_TAGS_URL = '/api/tags';
const DEFAULT_OLLAMA_MODEL = 'llama3.1';
const FALLBACK_MODELS = [
	'llama3.1',
	'codellama',
	'deepseek-coder-v2',
	'mistral',
	'qwen2.5-coder',
];
const MAX_RETRIES = 3;
const BASE_URL_SECRET_KEY = 'kovix.ollama.baseUrl';

/** Default max_tokens for Ollama models. */
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Rough token estimation: ~4 chars per token for English text.
 * Used to trim conversation history before it exceeds the model's context window.
 */
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Minimal Disposable + EventEmitter (same as anthropicProvider)
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
// Ollama SSE chunk types (OpenAI-compatible format)
// ---------------------------------------------------------------------------

interface IOllamaSSEChunk {
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
// Ollama /api/tags response types
// ---------------------------------------------------------------------------

interface IOllamaTagModel {
	name: string;
	model: string;
	modified_at: string;
	size: number;
	digest: string;
	details?: {
		parent_model?: string;
		format?: string;
		family?: string;
		families?: string[];
		parameter_size?: string;
		quantization_level?: string;
	};
}

interface IOllamaTagsResponse {
	models: IOllamaTagModel[];
}

// ---------------------------------------------------------------------------
// Context window sizes for known Ollama models
// ---------------------------------------------------------------------------

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	'llama3.1': 128_000,
	'llama3': 8_192,
	'codellama': 16_384,
	'deepseek-coder-v2': 128_000,
	'mistral': 32_000,
	'qwen2.5-coder': 128_000,
	'mixtral': 32_000,
	'gemma2': 8_192,
	'llama2': 4_096,
};

function getContextWindowForModel(modelId: string): number {
	// Ollama model IDs may include tags like "llama3.1:8b"
	const baseName = modelId.split(':')[0];

	if (MODEL_CONTEXT_WINDOWS[baseName]) {
		return MODEL_CONTEXT_WINDOWS[baseName];
	}
	// Check prefix match
	for (const [prefix, tokens] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (baseName.startsWith(prefix)) {
			return tokens;
		}
	}
	return 8_192; // Conservative default for local models
}

// ---------------------------------------------------------------------------
// OllamaProvider
// ---------------------------------------------------------------------------

export class OllamaProvider implements IConstructAIProvider, Disposable {

	readonly providerType: AIProviderType = 'ollama';

	private _activeModel: IModelInfo | undefined;
	private _status: ProviderStatus = ProviderStatus.Unknown;
	private _cachedModels: IModelInfo[] = [];
	private _baseUrl: string | undefined;

	private readonly _onDidChangeActiveModel = new EventEmitter<IModelInfo | undefined>();
	readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event;
	private readonly _onDidChangeStatus = new EventEmitter<ProviderStatus>();
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	constructor(private readonly secrets: ISecrets) {
		const configuredModel = getAppState().config.llmActiveModel || DEFAULT_OLLAMA_MODEL;

		this._activeModel = {
			id: configuredModel || DEFAULT_OLLAMA_MODEL,
			displayName: configuredModel || 'Llama 3.1',
			provider: 'ollama',
			contextWindowTokens: getContextWindowForModel(configuredModel || DEFAULT_OLLAMA_MODEL),
			supportsTools: true,
			supportsStreaming: true,
		};

		logger.info(redactSecrets('[OllamaProvider] Initialized (default model: ' + this._activeModel.id + ')'));
	}

	isOffline(): boolean {
		return false;
	}

	private async _resolveBaseUrl(): Promise<string> {
		const custom = await this.secrets.get(BASE_URL_SECRET_KEY);
		if (custom) {
			this._baseUrl = custom.replace(/\/+$/, ''); // strip trailing slashes
			return this._baseUrl;
		}
		this._baseUrl = OLLAMA_DEFAULT_BASE_URL;
		return OLLAMA_DEFAULT_BASE_URL;
	}

	private _setStatus(status: ProviderStatus): void {
		if (this._status !== status) {
			this._status = status;
			this._onDidChangeStatus.fire(status);
		}
	}

	async checkStatus(): Promise<ProviderStatus> {
		const baseUrl = await this._resolveBaseUrl();

		try {
			const response = await fetch(`${baseUrl}${OLLAMA_TAGS_URL}`);
			if (response.ok) {
				this._setStatus(ProviderStatus.Available);
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
		const baseUrl = await this._resolveBaseUrl();
		const apiUrl = `${baseUrl}${OLLAMA_CHAT_URL}`;
		const body = this.buildRequestBody(messages, tools, options);

		let retries = 0;
		while (retries < MAX_RETRIES) {
			try {
				const response = await fetch(apiUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Accept': 'text/event-stream',
					},
					body: JSON.stringify(body),
					signal: options?.signal,
				});

				// Ollama returns 404 if the model is not found locally
				if (response.status === 404) {
					yield { type: 'error', text: `Ollama model "${this._activeModel?.id ?? DEFAULT_OLLAMA_MODEL}" not found. Pull it first with: ollama pull ${this._activeModel?.id ?? DEFAULT_OLLAMA_MODEL}` };
					return;
				}

				if (response.status >= 500) {
					const waitMs = 2000 * (retries + 1);
					logger.warn(`[OllamaProvider] Server error ${response.status}, retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
					await new Promise(r => setTimeout(r, waitMs));
					retries++;
					continue;
				}

				if (!response.ok) {
					const errorText = await response.text().catch(() => 'unknown');
					yield { type: 'error', text: `Ollama API error (${response.status}): ${errorText}` };
					return;
				}

				// Parse SSE stream (OpenAI-compatible format)
				yield* this.parseSSEStream(response, options?.signal);
				return;
			} catch (error) {
				if (error instanceof Error && error.name === 'AbortError') {
					return;
				}
				const msg = error instanceof Error ? error.message : String(error);
				// Retry on transient network errors
				const isTransient = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|ECONNREFUSED|network/i.test(msg);
				if (isTransient && retries < MAX_RETRIES - 1) {
					const waitMs = 2000 * (retries + 1);
					logger.warn(`[OllamaProvider] Transient network error: "${msg}". Retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
					await new Promise(r => setTimeout(r, waitMs));
					retries++;
					continue;
				}
				logger.error(`[OllamaProvider] Request failed: ${msg}`);
				yield { type: 'error', text: `Ollama request failed (is Ollama running?): ${msg}` };
				return;
			}
		}

		yield { type: 'error', text: 'Ollama API: max retries exceeded.' };
	}

	private buildRequestBody(
		messages: IChatMessage[],
		tools: IToolDefinition[],
		options?: IChatOptions,
	): Record<string, unknown> {
		// Trim conversation history to fit within the model's context window.
		const contextWindow = this._activeModel?.contextWindowTokens ?? 8_192;
		const reservedForResponse = DEFAULT_MAX_TOKENS;
		const safetyMargin = 2_000;
		const maxInputTokens = contextWindow - reservedForResponse - safetyMargin;
		const trimmedMessages = this.trimMessagesToContextWindow(messages, maxInputTokens);

		const openaiMessages = this.convertToOpenAIMessages(trimmedMessages, options?.systemPrompt);
		const openaiTools = tools.length > 0 ? this.convertToOpenAITools(tools) : undefined;

		const body: Record<string, unknown> = {
			model: this._activeModel?.id ?? DEFAULT_OLLAMA_MODEL,
			max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
			messages: openaiMessages,
			stream: true,
		};

		if (openaiTools && openaiTools.length > 0) {
			body.tools = openaiTools;
		}

		// Only include temperature when explicitly provided.
		if (options?.temperature !== undefined) {
			body.temperature = options.temperature;
		}

		return body;
	}

	/**
	 * Trim conversation history to fit within a token budget.
	 *
	 * Strategy: always keep the first message (system prompt / first user
	 * message) and the most recent messages. Drop middle messages when
	 * the total estimated token count exceeds the budget.
	 */
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

		logger.warn(`[OllamaProvider] Context too large (~${totalTokens} tokens, budget ${maxTokens}). Trimming history.`);

		const result = [...messages];
		while (result.length > 2 && estimateTokens(result) > maxTokens) {
			// Remove the 2nd message (index 1) — keep first and last
			result.splice(1, 1);
		}

		const newTokens = estimateTokens(result);
		logger.info(`[OllamaProvider] Trimmed ${messages.length - result.length} messages. New estimate: ~${newTokens} tokens.`);
		return result;
	}

	private convertToOpenAIMessages(messages: IChatMessage[], systemPrompt?: string): unknown[] {
		const result: unknown[] = [];

		// Add system prompt as the first message if provided.
		if (systemPrompt) {
			result.push({ role: 'system', content: systemPrompt });
		}

		for (const m of messages) {
			if (m.role === 'system') {
				// System messages are handled above via systemPrompt.
				continue;
			}

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
			yield { type: 'error', text: 'Ollama API returned empty body.' };
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';
		// Track tool calls across chunks (OpenAI-compatible streaming)
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
							const chunk = JSON.parse(jsonStr) as IOllamaSSEChunk;

							if (chunk.error) {
								yield { type: 'error', text: chunk.error.message ?? 'Unknown Ollama stream error' };
								return;
							}

							if (chunk.choices && chunk.choices.length > 0) {
								const choice = chunk.choices[0];
								const delta = choice.delta;

								if (delta?.content) {
									yield { type: 'token', text: delta.content };
								}

								// Handle tool calls in delta
								if (delta?.tool_calls && delta.tool_calls.length > 0) {
									for (const tc of delta.tool_calls) {
										const idx = tc.index ?? 0;

										if (tc.id) {
											// New tool call starting
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

								// Stream finished
								if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
									// Complete any pending tool calls
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
		// Always re-discover models from Ollama (local models can change at any time)
		const baseUrl = await this._resolveBaseUrl();

		try {
			const response = await fetch(`${baseUrl}${OLLAMA_TAGS_URL}`);
			if (response.ok) {
				const data = await response.json() as IOllamaTagsResponse;
				this._cachedModels = data.models.map(m => ({
					id: m.name,
					displayName: m.name,
					provider: 'ollama' as AIProviderType,
					contextWindowTokens: getContextWindowForModel(m.name),
					supportsTools: true,
					supportsStreaming: true,
				}));
				return this._cachedModels;
			}
		} catch {
			// Ollama not running — fallback.
		}

		return this._activeModel ? [this._activeModel] : FALLBACK_MODELS.map(id => ({
			id,
			displayName: id,
			provider: 'ollama' as AIProviderType,
			contextWindowTokens: getContextWindowForModel(id),
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
			provider: 'ollama',
			contextWindowTokens: getContextWindowForModel(modelId),
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
