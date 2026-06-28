/**
 * aiService.ts — Layer 2 concrete IConstructAIService.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.Disposable → custom Disposable
 *   - vscode.EventEmitter → local EventEmitter
 *   - vscode.SecretStorage → ISecrets from getAppState()
 *   - vscode.workspace.getConfiguration → getAppState().config
 */

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
import { NvidiaProvider } from './providers/nvidiaProvider';
import { OpenRouterProvider } from './providers/openrouterProvider';
import { getAppState } from '../platform/appState';

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
                                // Swallow errors in listeners.
                        }
                }
        }

        dispose(): void {
                this.listeners = [];
        }
}

// ---------------------------------------------------------------------------
// ConstructAIService
// ---------------------------------------------------------------------------

export class ConstructAIService implements IConstructAIService, Disposable {

        private readonly _providers = new Map<AIProviderType, IConstructAIProvider>();
        private _activeProvider: IConstructAIProvider | undefined;

        /** Active stream controller, aborted when switching providers. */
        private _activeStreamController: AbortController | null = null;

        private readonly _onDidChangeActiveProvider = new EventEmitter<AIProviderType>();
        readonly onDidChangeActiveProvider = this._onDidChangeActiveProvider.event;
        private readonly _onDidChangeActiveModel = new EventEmitter<IModelInfo | undefined>();
        readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event;

        constructor() {
                const secrets = getAppState().secrets;

                // Register Anthropic provider.
                const anthropic = new AnthropicProvider(secrets);
                this._providers.set('anthropic', anthropic);

                anthropic.onDidChangeActiveModel(m => {
                        if (this._activeProvider === anthropic) {
                                this._onDidChangeActiveModel.fire(m);
                        }
                });
                anthropic.onDidChangeStatus(s => {
                        logger.verbose(`[ConstructAIService] anthropic status → ${s}`);
                });

                // Register NVIDIA NIM provider.
                const nvidia = new NvidiaProvider(secrets);
                this._providers.set('nvidia-nim', nvidia);

                nvidia.onDidChangeActiveModel(m => {
                        if (this._activeProvider === nvidia) {
                                this._onDidChangeActiveModel.fire(m);
                        }
                });
                nvidia.onDidChangeStatus(s => {
                        logger.verbose(`[ConstructAIService] nvidia-nim status → ${s}`);
                });

                // Register OpenRouter provider.
                const openrouter = new OpenRouterProvider(secrets);
                this._providers.set('openrouter', openrouter);

                openrouter.onDidChangeActiveModel(m => {
                        if (this._activeProvider === openrouter) {
                                this._onDidChangeActiveModel.fire(m);
                        }
                });
                openrouter.onDidChangeStatus(s => {
                        logger.verbose(`[ConstructAIService] openrouter status → ${s}`);
                });

                // Pick the active provider from config (default: anthropic).
                const configured = getAppState().config.llmActiveProvider as AIProviderType;

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
                                text: 'No AI provider available. Configure an API key via the settings.',
                        };
                        return;
                }

                // Bug 4 fix: create an AbortController so we can abort on provider switch.
                const streamController = new AbortController();
                this._activeStreamController = streamController;
                if (options?.signal) {
                        options.signal.addEventListener('abort', () => streamController.abort());
                }

                const mergedOptions: IChatOptions = {
                        ...options,
                        signal: streamController.signal,
                };

                // If the active model doesn't support tool use, strip tools from the request.
                // This prevents 404 errors from OpenRouter when using free models like
                // nemotron-3.5-content-safety:free that lack tool support.
                const activeModel = this._activeProvider.getActiveModel();
                const effectiveTools = (activeModel && !activeModel.supportsTools) ? [] : tools;

                try {
                        yield* this._activeProvider.chat(messages, effectiveTools, mergedOptions);
                } finally {
                        this._activeStreamController = null;
                }
        }

        async complete(
                prefix: string,
                suffix: string,
                options?: ICompleteOptions,
        ): Promise<ICompleteResult> {
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
