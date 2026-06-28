/**
 * openrouterProvider.ts — IConstructAIProvider for OpenRouter.
 *
 * OpenRouter is OpenAI-compatible, so we use the
 * `https://openrouter.ai/api/v1/chat/completions` endpoint
 * with SSE streaming, following the same patterns as nvidiaProvider.ts
 * but using OpenRouter-specific headers and default models.
 *
 * OpenRouter requires two extra headers per their docs:
 *   - HTTP-Referer: identifies the calling app
 *   - X-Title:      human-readable app name
 *
 * Supported models (see https://openrouter.ai/models):
 *   - anthropic/claude-sonnet-4
 *   - openai/gpt-4o
 *   - google/gemini-2.5-flash
 *   - meta-llama/llama-3.3-70b-instruct
 *   - deepseek/deepseek-chat
 *   - and hundreds more at https://openrouter.ai/models
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
	'openai/gpt-4o',
	'google/gemini-2.5-flash',
	'meta-llama/llama-3.3-70b-instruct',
	'deepseek/deepseek-chat',
	'qwen/qwen-2.5-72b-instruct',
];
const MAX_RETRIES = 3;
const SECRET_KEY = 'kovix.apiKey.openrouter';

/** Default max_tokens for OpenRouter models — must be high enough to avoid mid-sentence cut-offs. */
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Rough token estimation: ~4 chars per token for English text.
 * Used to trim conversation history before it exceeds the model's context window.
 */
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Minimal Disposable + EventEmitter (same as nvidiaProvider)
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
// Context window estimates per model family
// ---------------------------------------------------------------------------

const CONTEXT_WINDOW_MAP: Record<string, number> = {
	'claude': 200_000,
	'gpt-4o': 128_000,
	'gpt-4-turbo': 128_000,
	'gemini': 1_000_000,
	'llama-3.3': 128_000,
	'llama-3.1': 128_000,
	'deepseek': 128_000,
	'qwen': 128_000,
	'mistral': 128_000,
};

function estimateContextWindow(modelId: string): number {
	for (const [key, tokens] of Object.entries(CONTEXT_WINDOW_MAP)) {
		if (modelId.toLowerCase().includes(key.toLowerCase())) {
			return tokens;
		}
	}
	return 128_000; // safe default
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
			displayName: configuredModel || 'Claude Sonnet 4 (via OpenRouter)',
			provider: 'openrouter',
			contextWindowTokens: estimateContextWindow(configuredModel),
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
					'HTTP-Referer': 'https://kovix.ai',
					'X-Title': 'Kovix IDE',
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
			yield { type: 'error', text: 'OpenRouter API key not set. Set it via the settings dialog. Keys start with "sk-or-".' };
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
						'HTTP-Referer': 'https://kovix.ai',
						'X-Title': 'Kovix IDE',
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
					yield { type: 'error', text: 'OpenRouter API key is invalid or revoked. Keys should start with "sk-or-".' };
					return;
				}

				if (!response.ok) {
					const errorText = await response.text().catch(() => 'unknown');
					yield { type: 'error', text: `OpenRouter API error (${response.status}): ${errorText}` };
					return;
				}

				// Parse SSE stream (OpenAI format — same as NVIDIA)
				yield* this.parseSSEStream(response, options?.signal);
				return;
			} catch (error) {
				if (error instanceof Error && error.name === 'AbortError') {
					return;
				}
				const msg = error instanceof Error ? error.message : String(error);
				// Retry on transient network errors (fetch failed, ECONNRESET, etc.)
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
		// Trim conversation history to fit within the model's context window.
		const contextWindow = this._activeModel?.contextWindowTokens ?? 128_000;
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
			// OpenRouter + Llama/Mistral/Qwen models often reject parallel tool calls
			// with HTTP 400 "This model only supports single tool-calls at once!".
			// Setting parallel_tool_calls=false is a safe default for OpenRouter.
			body.parallel_tool_calls = false;
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

		// Estimate total tokens
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

		let totalTokens = estimateTokens(messages);
		if (totalTokens <= maxTokens) return messages;

		logger.warn(`[OpenRouterProvider] Context too large (~${totalTokens} tokens, budget ${maxTokens}). Trimming history.`);

		// Keep first message (usually system or first user) and trim from the middle.
		const result = [...messages];
		while (result.length > 2 && estimateTokens(result) > maxTokens) {
			// Remove the 2nd message (index 1) — keep first and last
			result.splice(1, 1);
		}

		const newTokens = estimateTokens(result);
		logger.info(`[OpenRouterProvider] Trimmed ${messages.length - result.length} messages. New estimate: ~${newTokens} tokens.`);
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
			yield { type: 'error', text: 'OpenRouter API returned empty body.' };
			return;
		}

		const decoder = new TextDecoder();
		let buffer = '';
		// Track tool calls across chunks (OpenAI streams tool calls incrementally)
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

								// Tool call finished
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
		if (this._cachedModels.length > 0) return this._cachedModels;

		const key = await this._resolveApiKey();
		if (!key) return [];

		try {
			const response = await fetch(OPENROUTER_MODELS_URL, {
				headers: {
					'Authorization': `Bearer ${key}`,
					'HTTP-Referer': 'https://kovix.ai',
					'X-Title': 'Kovix IDE',
				},
			});
			if (response.ok) {
				const data = await response.json() as { data: Array<{ id: string; context_length?: number }> };
				this._cachedModels = data.data
					.filter(m => m.id && !m.id.includes('embed') && !m.id.includes('retrieval'))
					.map(m => ({
						id: m.id,
						displayName: m.id.split('/').pop() ?? m.id,
						provider: 'openrouter' as AIProviderType,
						contextWindowTokens: m.context_length ?? estimateContextWindow(m.id),
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
			displayName: id.split('/').pop() ?? id,
			provider: 'openrouter' as AIProviderType,
			contextWindowTokens: estimateContextWindow(id),
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
			displayName: modelId.split('/').pop() ?? modelId,
			provider: 'openrouter',
			contextWindowTokens: estimateContextWindow(modelId),
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
