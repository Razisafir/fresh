/**
 * deepseekProvider.ts — IConstructAIProvider for DeepSeek.
 *
 * DeepSeek provides an OpenAI-compatible API at
 * `https://api.deepseek.com/v1/chat/completions`. This provider uses the same
 * SSE streaming, tool/function calling, and retry logic as the other
 * OpenAI-compatible providers (nvidiaProvider, openrouterProvider).
 *
 * Default models:
 *   - deepseek-chat      (DeepSeek-V3, general-purpose chat)
 *   - deepseek-coder     (DeepSeek-Coder-V2, code-specialised)
 *   - deepseek-reasoner  (DeepSeek-R1, reasoning chain)
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

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/v1/models';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
const FALLBACK_MODELS = [
	'deepseek-chat',
	'deepseek-coder',
	'deepseek-reasoner',
];
const MAX_RETRIES = 3;
const SECRET_KEY = 'kovix.apiKey.deepseek';

/** Default max_tokens for DeepSeek models. */
const DEFAULT_MAX_TOKENS = 8_192;

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
// DeepSeek SSE chunk types (OpenAI-compatible format)
// ---------------------------------------------------------------------------

interface IDeepSeekSSEChunk {
	id?: string;
	object?: string;
	choices?: Array<{
		index?: number;
		delta?: {
			role?: string;
			content?: string;
			reasoning_content?: string;
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
// Context window sizes for known DeepSeek models
// ---------------------------------------------------------------------------

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	'deepseek-chat': 64_000,
	'deepseek-coder': 128_000,
	'deepseek-reasoner': 64_000,
};

function getContextWindowForModel(modelId: string): number {
	if (MODEL_CONTEXT_WINDOWS[modelId]) {
		return MODEL_CONTEXT_WINDOWS[modelId];
	}
	// Check prefix match
	for (const [prefix, tokens] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (modelId.startsWith(prefix)) {
			return tokens;
		}
	}
	return 64_000; // Default for DeepSeek models
}

// ---------------------------------------------------------------------------
// DeepSeekProvider
// ---------------------------------------------------------------------------

export class DeepSeekProvider implements IConstructAIProvider, Disposable {

	readonly providerType: AIProviderType = 'deepseek';

	private _activeModel: IModelInfo | undefined;
	private _status: ProviderStatus = ProviderStatus.Unknown;
	private _cachedModels: IModelInfo[] = [];
	private _apiKey: string | undefined;

	private readonly _onDidChangeActiveModel = new EventEmitter<IModelInfo | undefined>();
	readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event;
	private readonly _onDidChangeStatus = new EventEmitter<ProviderStatus>();
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	constructor(private readonly secrets: ISecrets) {
		const configuredModel = getAppState().config.llmActiveModel || DEFAULT_DEEPSEEK_MODEL;

		this._activeModel = {
			id: configuredModel || DEFAULT_DEEPSEEK_MODEL,
			displayName: configuredModel || 'DeepSeek Chat',
			provider: 'deepseek',
			contextWindowTokens: getContextWindowForModel(configuredModel || DEFAULT_DEEPSEEK_MODEL),
			supportsTools: true,
			supportsStreaming: true,
		};

		logger.info(redactSecrets('[DeepSeekProvider] Initialized (default model: ' + this._activeModel.id + ')'));
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
			const response = await fetch(DEEPSEEK_MODELS_URL, {
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
			yield { type: 'error', text: 'DeepSeek API key not set. Set it via the settings dialog.' };
			return;
		}

		const body = this.buildRequestBody(messages, tools, options);

		let retries = 0;
		while (retries < MAX_RETRIES) {
			try {
				const response = await fetch(DEEPSEEK_API_URL, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${key}`,
						'Accept': 'text/event-stream',
					},
					body: JSON.stringify(body),
					signal: options?.signal,
				});

				if (response.status === 429) {
					const retryAfter = response.headers.get('retry-after');
					const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000 * (retries + 1);
					logger.warn(`[DeepSeekProvider] Rate limited, retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
					await new Promise(r => setTimeout(r, waitMs));
					retries++;
					continue;
				}

				if (response.status === 529 || response.status >= 500) {
					const waitMs = 2000 * (retries + 1);
					logger.warn(`[DeepSeekProvider] Server error ${response.status}, retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
					await new Promise(r => setTimeout(r, waitMs));
					retries++;
					continue;
				}

				if (response.status === 401 || response.status === 403) {
					yield { type: 'error', text: 'DeepSeek API key is invalid or revoked.' };
					return;
				}

				if (!response.ok) {
					const errorText = await response.text().catch(() => 'unknown');
					yield { type: 'error', text: `DeepSeek API error (${response.status}): ${errorText}` };
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
				const isTransient = /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg);
				if (isTransient && retries < MAX_RETRIES - 1) {
					const waitMs = 2000 * (retries + 1);
					logger.warn(`[DeepSeekProvider] Transient network error: "${msg}". Retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
					await new Promise(r => setTimeout(r, waitMs));
					retries++;
					continue;
				}
				logger.error(`[DeepSeekProvider] Request failed: ${msg}`);
				yield { type: 'error', text: `DeepSeek request failed: ${msg}` };
				return;
			}
		}

		yield { type: 'error', text: 'DeepSeek API: max retries exceeded.' };
	}

	private buildRequestBody(
		messages: IChatMessage[],
		tools: IToolDefinition[],
		options?: IChatOptions,
	): Record<string, unknown> {
		// Trim conversation history to fit within the model's context window.
		const contextWindow = this._activeModel?.contextWindowTokens ?? 64_000;
		const reservedForResponse = DEFAULT_MAX_TOKENS;
		const safetyMargin = 2_000;
		const maxInputTokens = contextWindow - reservedForResponse - safetyMargin;
		const trimmedMessages = this.trimMessagesToContextWindow(messages, maxInputTokens);

		const openaiMessages = this.convertToOpenAIMessages(trimmedMessages, options?.systemPrompt);
		const openaiTools = tools.length > 0 ? this.convertToOpenAITools(tools) : undefined;

		const body: Record<string, unknown> = {
			model: this._activeModel?.id ?? DEFAULT_DEEPSEEK_MODEL,
			max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
			messages: openaiMessages,
			stream: true,
		};

		if (openaiTools && openaiTools.length > 0) {
			body.tools = openaiTools;
		}

		// Only include temperature when explicitly provided.
		// deepseek-reasoner does not support the temperature parameter.
		const modelId = this._activeModel?.id ?? DEFAULT_DEEPSEEK_MODEL;
		const isReasoner = modelId === 'deepseek-reasoner';
		if (options?.temperature !== undefined && !isReasoner) {
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

		logger.warn(`[DeepSeekProvider] Context too large (~${totalTokens} tokens, budget ${maxTokens}). Trimming history.`);

		const result = [...messages];
		while (result.length > 2 && estimateTokens(result) > maxTokens) {
			// Remove the 2nd message (index 1) — keep first and last
			result.splice(1, 1);
		}

		const newTokens = estimateTokens(result);
		logger.info(`[DeepSeekProvider] Trimmed ${messages.length - result.length} messages. New estimate: ~${newTokens} tokens.`);
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
			yield { type: 'error', text: 'DeepSeek API returned empty body.' };
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
							const chunk = JSON.parse(jsonStr) as IDeepSeekSSEChunk;

							if (chunk.error) {
								yield { type: 'error', text: chunk.error.message ?? 'Unknown DeepSeek stream error' };
								return;
							}

							if (chunk.choices && chunk.choices.length > 0) {
								const choice = chunk.choices[0];
								const delta = choice.delta;

								// DeepSeek-reasoner emits reasoning_content for the chain-of-thought.
								// We emit it as regular tokens so the caller can display the
								// reasoning process.
								if (delta?.reasoning_content) {
									yield { type: 'token', text: delta.reasoning_content };
								}

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
		if (this._cachedModels.length > 0) return this._cachedModels;

		const key = await this._resolveApiKey();
		if (!key) return [];

		try {
			const response = await fetch(DEEPSEEK_MODELS_URL, {
				headers: {
					'Authorization': `Bearer ${key}`,
				},
			});
			if (response.ok) {
				const data = await response.json() as { data: Array<{ id: string; owned_by?: string }> };
				this._cachedModels = data.data
					.filter(m => m.id)
					.map(m => ({
						id: m.id,
						displayName: m.id,
						provider: 'deepseek' as AIProviderType,
						contextWindowTokens: getContextWindowForModel(m.id),
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
			provider: 'deepseek' as AIProviderType,
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
			provider: 'deepseek',
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
