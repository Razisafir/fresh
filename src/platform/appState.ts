/**
 * appState.ts — Singleton application state for the Electron standalone app.
 *
 * Replaces VS Code's ExtensionContext + workspace configuration + SecretStorage.
 * Initialised once by electron/main.ts when the app starts up.
 *
 * What this provides:
 *   - Workspace roots (set by the user via the folder-picker dialog)
 *   - Secrets (encrypted via Electron safeStorage, or base64 fallback for dev)
 *   - Config (read from kovix.config.json in the app state directory)
 *
 * The singleton is accessed via getAppState() after initAppState() has been
 * called. Calling getAppState() before initAppState() throws.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { IAppState, ISecrets, IWorkspaceRoots, IAppConfig } from '../types/platform';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: IAppConfig = {
        workspaceRoots: [],
        llmActiveProvider: 'anthropic',
        llmActiveModel: '',
        autonomyDefaultMode: 'major_milestone',
        autonomyPauseOnVerificationFailure: true,
        memoryEmbedProvider: 'ollama',
        memoryEmbedModel: 'nomic-embed-text',
        memoryVectorStore: 'in-process',
        mcpServers: [],
        mcpToolTimeoutMs: 30_000,
        securityAllowExternalTargets: false,
        debugVerbose: false,
        agentMode: 'chat',
        uiMode: 'ide',
};

// ---------------------------------------------------------------------------
// Secrets implementation
// ---------------------------------------------------------------------------

/**
 * Secrets store backed by a JSON file. In production, values are encrypted
 * via Electron's safeStorage; in dev/test (where safeStorage is unavailable),
 * values are stored as base64 strings.
 */
class FileSecrets implements ISecrets {
        private readonly filePath: string;
        private readonly _data = new Map<string, string>();
        private _encrypt: ((plaintext: string) => string) | undefined;
        private _decrypt: ((cipher: string) => string) | undefined;
        private _loaded = false;

        constructor(baseDir: string) {
                this.filePath = path.join(baseDir, 'secrets.json');
        }

        /** Set the encryption/decryption functions. Called by electron/main.ts
         *  after app is ready and safeStorage is available. */
        setCrypto(encrypt: (plaintext: string) => string, decrypt: (cipher: string) => string): void {
                this._encrypt = encrypt;
                this._decrypt = decrypt;
        }

        private async ensureLoaded(): Promise<void> {
                if (this._loaded) return;
                this._loaded = true;
                try {
                        const raw = await fs.readFile(this.filePath, 'utf8');
                        const parsed = JSON.parse(raw) as Record<string, string>;
                        for (const [key, value] of Object.entries(parsed)) {
                                this._data.set(key, value);
                        }
                } catch {
                        // File doesn't exist yet — start with empty map.
                }
        }

        private async persist(): Promise<void> {
                const obj: Record<string, string> = {};
                for (const [key, value] of this._data) {
                        obj[key] = value;
                }
                await fs.writeFile(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
        }

        async get(key: string): Promise<string | undefined> {
                await this.ensureLoaded();
                const cipher = this._data.get(key);
                if (cipher === undefined) return undefined;
                if (this._decrypt) {
                        try {
                                return this._decrypt(cipher);
                        } catch {
                                // Fallback: might be a base64 value from before safeStorage was set
                                try {
                                        return Buffer.from(cipher, 'base64').toString('utf8');
                                } catch {
                                        return undefined;
                                }
                        }
                }
                // Dev mode: base64 decode
                try {
                        return Buffer.from(cipher, 'base64').toString('utf8');
                } catch {
                        return cipher;
                }
        }

        async store(key: string, value: string): Promise<void> {
                await this.ensureLoaded();
                if (this._encrypt) {
                        this._data.set(key, this._encrypt(value));
                } else {
                        // Dev mode: base64 encode
                        this._data.set(key, Buffer.from(value, 'utf8').toString('base64'));
                }
                await this.persist();
        }

        async delete(key: string): Promise<void> {
                await this.ensureLoaded();
                this._data.delete(key);
                await this.persist();
        }
}

// ---------------------------------------------------------------------------
// WorkspaceRoots implementation
// ---------------------------------------------------------------------------

class MutableWorkspaceRoots implements IWorkspaceRoots {
        private _roots: readonly string[] = [];

        get roots(): readonly string[] {
                return this._roots;
        }

        setRoots(roots: readonly string[]): void {
                this._roots = roots;
                logger.info(`[AppState] Workspace roots set: ${roots.join(', ') || '(none)'}`);
                // Persist workspace roots to config so they survive app restart.
                try {
                        const config = getAppState().config as FileConfig;
                        config.workspaceRoots = [...roots];
                        config.save().catch(err => {
                                logger.warn(`[AppState] Failed to persist workspace roots: ${err}`);
                        });
                } catch {
                        // getAppState() may not be available during init — that's OK.
                }
        }
}

// ---------------------------------------------------------------------------
// Config implementation
// ---------------------------------------------------------------------------

class FileConfig implements IAppConfig {
        private _data: IAppConfig;
        private readonly filePath: string;

        constructor(baseDir: string) {
                this.filePath = path.join(baseDir, 'kovix.config.json');
                this._data = { ...DEFAULT_CONFIG };
        }

        get workspaceRoots(): string[] { return this._data.workspaceRoots; }
        set workspaceRoots(v: string[]) { this._data.workspaceRoots = v; }
        get llmActiveProvider(): string { return this._data.llmActiveProvider; }
        set llmActiveProvider(v: string) { this._data.llmActiveProvider = v; }
        get llmActiveModel(): string { return this._data.llmActiveModel; }
        set llmActiveModel(v: string) { this._data.llmActiveModel = v; }
        get autonomyDefaultMode(): string { return this._data.autonomyDefaultMode; }
        set autonomyDefaultMode(v: string) { this._data.autonomyDefaultMode = v; }
        get autonomyPauseOnVerificationFailure(): boolean { return this._data.autonomyPauseOnVerificationFailure; }
        set autonomyPauseOnVerificationFailure(v: boolean) { this._data.autonomyPauseOnVerificationFailure = v; }
        get memoryEmbedProvider(): string { return this._data.memoryEmbedProvider; }
        set memoryEmbedProvider(v: string) { this._data.memoryEmbedProvider = v; }
        get memoryEmbedModel(): string { return this._data.memoryEmbedModel; }
        set memoryEmbedModel(v: string) { this._data.memoryEmbedModel = v; }
        get memoryVectorStore(): string { return this._data.memoryVectorStore; }
        set memoryVectorStore(v: string) { this._data.memoryVectorStore = v; }
        get mcpServers(): IAppConfig['mcpServers'] { return this._data.mcpServers; }
        set mcpServers(v: IAppConfig['mcpServers']) { this._data.mcpServers = v; }
        get mcpToolTimeoutMs(): number { return this._data.mcpToolTimeoutMs; }
        set mcpToolTimeoutMs(v: number) { this._data.mcpToolTimeoutMs = v; }
        get securityAllowExternalTargets(): boolean { return this._data.securityAllowExternalTargets; }
        set securityAllowExternalTargets(v: boolean) { this._data.securityAllowExternalTargets = v; }
        get debugVerbose(): boolean { return this._data.debugVerbose; }
        set debugVerbose(v: boolean) { this._data.debugVerbose = v; }
        get agentMode(): IAppConfig['agentMode'] { return this._data.agentMode; }
        set agentMode(v: IAppConfig['agentMode']) { this._data.agentMode = v; }
        get uiMode(): IAppConfig['uiMode'] { return this._data.uiMode; }
        set uiMode(v: IAppConfig['uiMode']) { this._data.uiMode = v; }

        async load(): Promise<void> {
                try {
                        const raw = await fs.readFile(this.filePath, 'utf8');
                        const parsed = JSON.parse(raw) as Partial<IAppConfig>;
                        this._data = { ...DEFAULT_CONFIG, ...parsed };
                        logger.info(`[AppState] Config loaded from ${this.filePath}`);
                } catch {
                        logger.info(`[AppState] No config file at ${this.filePath}, using defaults.`);
                }
        }

        async save(): Promise<void> {
                await fs.writeFile(this.filePath, JSON.stringify(this._data, null, 2), 'utf8');
                logger.verbose(`[AppState] Config saved to ${this.filePath}`);
        }
}

// ---------------------------------------------------------------------------
// AppState singleton
// ---------------------------------------------------------------------------

let _instance: IAppState & {
        secrets: FileSecrets;
        workspaceRoots: MutableWorkspaceRoots;
        config: FileConfig;
} | undefined;

/**
 * Initialise the application state. Called once by electron/main.ts.
 *
 * @param baseDir Directory for app state files (config, secrets, memory index).
 *   Created if it doesn't exist.
 */
export async function initAppState(baseDir: string): Promise<void> {
        if (_instance) {
                throw new Error('initAppState() called twice — use getAppState() instead.');
        }

        // Ensure base directory exists.
        await fs.mkdir(baseDir, { recursive: true });

        const secrets = new FileSecrets(baseDir);
        const workspaceRoots = new MutableWorkspaceRoots();
        const config = new FileConfig(baseDir);
        await config.load();

        // Restore persisted workspace roots from config (survives app restart).
        // Directly set _roots without calling setRoots() to avoid circular
        // persistence (we're loading from config, no need to save back).
        if (config.workspaceRoots && config.workspaceRoots.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (workspaceRoots as any)._roots = config.workspaceRoots;
                logger.info(`[AppState] Restored ${config.workspaceRoots.length} workspace root(s) from config.`);
        }

        // Apply debugVerbose to logger
        // (logger reads config on each call, but we set it up here for consistency)

        _instance = {
                secrets,
                workspaceRoots,
                config,
                get baseDir() { return baseDir; },
        };

        logger.info(`[AppState] Initialized (baseDir: ${baseDir})`);
}

/**
 * Returns the singleton application state. Throws if initAppState()
 * has not been called yet.
 */
export function getAppState(): IAppState & {
        secrets: FileSecrets;
        workspaceRoots: MutableWorkspaceRoots;
        config: FileConfig;
} {
        if (!_instance) {
                throw new Error('getAppState() called before initAppState().');
        }
        return _instance;
}

/**
 * Returns true if the app state has been initialized.
 */
export function isAppStateInitialized(): boolean {
        return _instance !== undefined;
}

/**
 * Reset the app state (for testing only).
 */
export function _resetAppState(): void {
        _instance = undefined;
}
