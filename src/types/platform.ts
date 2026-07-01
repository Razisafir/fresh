/**
 * platform.ts — Platform abstraction types for the Electron standalone app.
 *
 * Replaces VS Code's ExtensionContext, SecretStorage, workspace configuration,
 * and workspace folders with plain interfaces that are satisfied by
 * src/platform/appState.ts in the Electron main process.
 *
 * Layer 1 — pure types, no runtime logic, no side-effect imports.
 */

// ---------------------------------------------------------------------------
// Secrets (replaces vscode.SecretStorage)
// ---------------------------------------------------------------------------

/**
 * Simple key-value secrets store. Implemented by AppState using
 * Electron safeStorage (or base64 fallback for dev).
 */
export interface ISecrets {
        /** Get a secret value. Returns undefined if the key does not exist. */
        get(key: string): Promise<string | undefined>;
        /** Store a secret value. */
        store(key: string, value: string): Promise<void>;
        /** Delete a secret. */
        delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Workspace roots (replaces vscode.workspace.workspaceFolders)
// ---------------------------------------------------------------------------

/**
 * Provides the list of workspace root paths. In the Electron app this
 * is set by the user picking a folder via the dialog.
 */
export interface IWorkspaceRoots {
        /** Ordered list of absolute paths the agent can access. */
        readonly roots: readonly string[];
}

// ---------------------------------------------------------------------------
// App config (replaces vscode.workspace.getConfiguration('kovix'))
// ---------------------------------------------------------------------------

/**
 * Application configuration. Read from kovix.config.json in the app
 * state directory, with sensible defaults.
 */
export interface IAppConfig {
        /** Active LLM provider (default: 'anthropic'). */
        llmActiveProvider: string;
        /** Active LLM model ID (default: ''). */
        llmActiveModel: string;
        /** Default autonomy mode (default: 'major_milestone'). */
        autonomyDefaultMode: string;
        /** Pause on verification failure (default: true). */
        autonomyPauseOnVerificationFailure: boolean;
        /** Embedding provider for semantic memory (default: 'ollama'). */
        memoryEmbedProvider: string;
        /** Embedding model name (default: 'nomic-embed-text'). */
        memoryEmbedModel: string;
        /** Vector store backend (default: 'in-process'). */
        memoryVectorStore: string;
        /** MCP server configurations. */
        mcpServers: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>;
        /** MCP tool timeout in ms (default: 30000). */
        mcpToolTimeoutMs: number;
        /** Allow external targets for web_fetch (default: false). */
        securityAllowExternalTargets: boolean;
        /** Verbose logging (default: false). */
        debugVerbose: boolean;
        /** Active agent role (default: 'general'). */
        agentRole: string;
}

// ---------------------------------------------------------------------------
// AppState (replaces vscode.ExtensionContext)
// ---------------------------------------------------------------------------

/**
 * Top-level application state. Singleton provided by src/platform/appState.ts.
 *
 * Replaces the ExtensionContext that was passed through the VS Code
 * activation flow. All services that previously consumed context.secrets,
 * context.workspaceFolders, or context.configuration now consume this.
 */
export interface IAppState {
        /** Secrets store (API keys, etc.). */
        readonly secrets: ISecrets;
        /** Workspace root paths. */
        readonly workspaceRoots: IWorkspaceRoots;
        /** Application configuration. */
        readonly config: IAppConfig;
        /** Base directory for app state files (secrets, config, memory index). */
        readonly baseDir: string;
}
