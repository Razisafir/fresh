/**
 * aiService.ts — Layer 2 concrete IConstructAIService.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/llm/constructAIService.ts` (384L)
 * Port strategy: REWRITE. The old repo's service orchestrated three
 * providers (Ollama, Xenova, Cloud) with auto-selection, lazy
 * instantiation to break DI cycles, and storage-backed preferences.
 * For v0.1 we ship Anthropic-only and trust the user's configured
 * provider directly. Auto-selection returns in v1.0-beta if we add
 * the onboarding wizard.
 *
 * 02_ARCHITECTURE.md §6 mapping table: Layer 2 — rewrite (simplified
 * from 384L to ~150L).
 *
 * What is PRESERVED:
 *   - The IConstructAIService interface contract (delegates to active
 *     provider, fires onDidChangeActiveProvider/onDidChangeActiveModel).
 *   - The active-stream controller pattern (Bug 4 fix from old repo):
 *     switching providers aborts any in-flight stream from the previous
 *     provider.
 *   - The "no provider available" error path: chat() yields an error
 *     event with a user-actionable message.
 *
 * What is GONE:
 *   - The 3-value AIProviderType enum (`'ollama' | 'xenova' | 'cloud'`)
 *     → replaced by the 13-value enum in src/types/llm.ts.
 *   - The LazyCloudProvider DI-cycle workaround → no DI container in
 *     fresh, so no cycle to break.
 *   - The auto-select priority loop (Ollama → Xenova → Cloud) → user's
 *     configured provider is always used directly.
 *   - The INotificationService.warn() call when no provider is
 *     available → replaced with a logger.warn(). The chat() call site
 *     surfaces the error to the user via the AIStreamEvent 'error'
 *     event, which the (future) UI renders in the agent panel.
 *   - The IStorageService preference persistence → not needed because
 *     the user's preference lives in `kovix.llm.activeProvider`
 *     (settings.json), not in private extension storage.
 *
 * v0.1 scope: Only AnthropicProvider is registered. switchProvider()
 * accepts any AIProviderType but only 'anthropic' will succeed. Other
 * providers ship in later Phase 3 rounds.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension
 * route). Bug 4 fix (abort in-flight stream on provider switch)
 * preserved.
 */

import * as vscode from 'vscode';
import { logger } from '../util/logger';
import {
	AIProviderType,
	AIStreamEvent,
	IChatMessage,
	IChatOptions,
	ICompleteOptions,
	ICompleteResult,
	IConstructAIProvider,
	IConstructAIService,
	IModelInfo,
	IToolDefinition,
	ProviderStatus,
} from '../types/llm';
import { AnthropicProvider } from './providers/anthropicProvider';

/**
 * ConstructAIService — selects the active provider based on
 * `kovix.llm.activeProvider` and delegates all calls to it.
 *
 * Singleton — constructed once by the future services.ts registry with
 * the extension context (for SecretStorage access). Use the exported
 * `aiService` instance.
 */
export class ConstructAIService implements IConstructAIService, vscode.Disposable {

	private readonly _providers = new Map<AIProviderType, IConstructAIProvider>();
	private _activeProvider: IConstructAIProvider | undefined;

	/** Active stream controller, aborted when switching providers. */
	private _activeStreamController: AbortController | null = null;

	private readonly _onDidChangeActiveProvider = new vscode.EventEmitter<AIProviderType>();
	readonly onDidChangeActiveProvider = this._onDidChangeActiveProvider.event;
	private readonly _onDidChangeActiveModel = new vscode.EventEmitter<IModelInfo | undefined>();
	readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event;

	constructor(context: vscode.ExtensionContext) {
		// Register the v0.1 provider. Additional providers ship in
		// later Phase 3 rounds.
		const anthropic = new AnthropicProvider(context.secrets);
		this._providers.set('anthropic', anthropic);

		// Forward provider events.
		anthropic.onDidChangeActiveModel(m => {
			if (this._activeProvider === anthropic) {
				this._onDidChangeActiveModel.fire(m);
			}
		});
		anthropic.onDidChangeStatus(s => {
			logger.verbose(`[ConstructAIService] anthropic status → ${s}`);
		});

		// Pick the active provider from settings (default: anthropic).
		const configured = vscode.workspace
			.getConfiguration('kovix')
			.get<AIProviderType>('llm.activeProvider', 'anthropic');

		const initial = this._providers.get(configured) ?? this._providers.get('anthropic');
		if (initial) {
			this._setActiveProvider(initial.providerType);
		}

		logger.info(`[ConstructAIService] Initialized with ${this._providers.size} provider(s). Active: ${this._activeProvider?.providerType ?? 'none'}`);
	}

	get activeProvider(): IConstructAIProvider | undefined {
		return this._activeProvider;
	}

	get activeProviderType(): AIProviderType | undefined {
		return this._activeProvider?.providerType;
	}

	async *chat(
		messages: IChatMessage[],
		tools: IToolDefinition[],
		options?: IChatOptions,
	): AsyncIterable<AIStreamEvent> {
		if (!this._activeProvider) {
			yield {
				type: 'error',
				text: 'No AI provider available. Set "kovix.llm.activeProvider" in settings and configure an API key via "Kovix: Manage API Keys".',
			};
			return;
		}

		// Bug 4 fix: create an AbortController so we can abort on
		// provider switch. Chain the user's signal with our controller.
		const streamController = new AbortController();
		this._activeStreamController = streamController;
		if (options?.signal) {
			options.signal.addEventListener('abort', () => streamController.abort());
		}

		const mergedOptions: IChatOptions = {
			...options,
			signal: streamController.signal,
		};

		try {
			yield* this._activeProvider.chat(messages, tools, mergedOptions);
		} finally {
			this._activeStreamController = null;
		}
	}

	async complete(
		prefix: string,
		suffix: string,
		options?: ICompleteOptions,
	): Promise<ICompleteResult> {
		// DEFERRED to v1.1 per 02_ARCHITECTURE.md §9. The method
		// exists to satisfy the interface contract; v1.0 call sites
		// (none today) get an empty result.
		if (!this._activeProvider) {
			return { text: '', finished: true };
		}
		return this._activeProvider.complete(prefix, suffix, options);
	}

	async listModels(): Promise<IModelInfo[]> {
		if (!this._activeProvider) {
			return [];
		}
		return this._activeProvider.listModels();
	}

	getActiveModel(): IModelInfo | undefined {
		return this._activeProvider?.getActiveModel();
	}

	async setActiveModel(modelId: string): Promise<boolean> {
		if (!this._activeProvider) {
			return false;
		}
		return this._activeProvider.setActiveModel(modelId);
	}

	isOffline(): boolean {
		return this._activeProvider?.isOffline() ?? false;
	}

	async switchProvider(providerType: AIProviderType): Promise<boolean> {
		const provider = this._providers.get(providerType);
		if (!provider) {
			logger.warn(`[ConstructAIService] Provider not registered: ${providerType}. Available: ${Array.from(this._providers.keys()).join(', ')}`);
			return false;
		}

		const status = await provider.checkStatus();
		if (status !== ProviderStatus.Available) {
			logger.warn(`[ConstructAIService] Provider ${providerType} not available (status: ${status}).`);
			return false;
		}

		this._setActiveProvider(providerType);
		logger.info(`[ConstructAIService] Switched to provider: ${providerType}`);
		return true;
	}

	getProvider(type: AIProviderType): IConstructAIProvider | undefined {
		return this._providers.get(type);
	}

	// --- Private helpers ---

	private _setActiveProvider(type: AIProviderType): void {
		// Bug 4 fix: abort any in-flight stream before switching.
		if (this._activeStreamController) {
			this._activeStreamController.abort();
			this._activeStreamController = null;
		}

		this._activeProvider = this._providers.get(type);
		this._onDidChangeActiveProvider.fire(type);
		if (this._activeProvider) {
			this._onDidChangeActiveModel.fire(this._activeProvider.getActiveModel());
		}
	}

	dispose(): void {
		for (const provider of this._providers.values()) {
			provider.dispose();
		}
		this._providers.clear();
		this._onDidChangeActiveProvider.dispose();
		this._onDidChangeActiveModel.dispose();
	}
}
