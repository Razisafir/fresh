/**
 * toolRegistryService.ts — Layer 2 concrete implementation of
 * IConstructToolRegistry.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/tools/constructToolRegistryService.ts` (1916L)
 * Port strategy: PORT WITH TRANSLATION + REWRITE (significant scope reduction).
 *
 * 02_ARCHITECTURE.md §6 mapping table: Layer 2 — port with translation.
 * 02_ARCHITECTURE.md §4.3 lists 7 built-in tools for v0.1 (read_file,
 * write_file, list_directory, edit_file, run_command, search_code,
 * web_fetch). The old repo shipped ~25 registered tools (including
 * 10+ agent_reach MCP proxies, 3 security tools, 2 terminal aliases,
 * search_codebase, web_search, create_directory). We port ONLY the 7
 * v0.1 tools; the rest are dropped per the architecture doc.
 *
 * What this service does (preserved from old repo):
 *   - Maintains a `Map<toolName, {definition, executeFn}>` of registered tools.
 *   - `registerTool(def, fn)` adds a tool (overwrites silently on name clash).
 *   - `execute(name, input, signal)` looks up the tool, calls its executeFn,
 *     wraps in try/catch, and stamps `metadata.durationMs`.
 *   - Tools with `requiresNetwork: true` are gated by an online-mode check.
 *     In v0.1 we don't have an `onlineMode` setting — the SSRF guard
 *     (`urlGuard.ts`) is the only network gate. So `requiresNetwork` is
 *     currently informational; the architecture may add an `onlineMode`
 *     setting in v1.0 when MCP servers land.
 *
 * Translation notes:
 *   - DI markers (@ILogService, @IFileService, ...) removed — singletons.
 *   - VS Code's IConfigurationService → vscode.workspace.getConfiguration.
 *   - IFileService / IWorkspaceContextService are not needed here at the
 *     registry level — each built-in tool imports what it needs directly
 *     (vscode.workspace.fs, vscode.workspace.workspaceFolders).
 *   - Kali WSL detection, terminal profile state, registerSecurityTools(),
 *     and the 10+ agent_reach proxy tools are all DROPPED (D-008 + W2).
 *   - The agent_reach MCP proxy tools (agent_reach__read_webpage, etc.)
 *     are replaced in v0.1 by the simpler `web_fetch` tool. v1.0+ may
 *     re-introduce MCP-discovered tools when the MCP stack lands.
 *
 * The registry is constructed once and exposed as a singleton. Built-in
 * tools are registered at construction time via `registerBuiltinTools()`
 * from `src/tools/builtin/index.ts`. The dependency injection shape
 * (logger, pendingChanges, terminalExecutor) is passed in via the
 * `registerBuiltinTools()` call so individual tool files don't reach
 * into other modules' singletons.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-008 (security tools
 * dropped), D-011 (extension route), W2 (no Kali), 02_ARCHITECTURE.md §4.3
 * (7 v0.1 tools).
 */

import { logger } from '../util/logger';
import type {
	IConstructToolRegistry,
	ITool,
	IToolResult,
	ToolExecuteFn,
} from '../types/tools';
import { registerBuiltinTools } from './builtin';

/**
 * Concrete implementation of IConstructToolRegistry.
 *
 * Singleton — constructed once by `src/extension.ts` (Layer 4) and
 * re-exported via `getToolRegistry()` accessor. Built-in tools are
 * registered at construction time.
 */
export class ToolRegistryService implements IConstructToolRegistry {

	private readonly _tools: Map<string, { definition: ITool; executeFn: ToolExecuteFn }> = new Map();

	constructor() {
		// Register the 7 v0.1 built-in tools. They live in
		// src/tools/builtin/*.ts and each exports a register function
		// that takes the registry and any dependencies it needs.
		registerBuiltinTools(this);
		logger.info(`[ToolRegistry] Initialized with ${this._tools.size} built-in tools`);
	}

	listTools(): ITool[] {
		return Array.from(this._tools.values()).map(t => t.definition);
	}

	getTool(name: string): ITool | undefined {
		return this._tools.get(name)?.definition;
	}

	async execute(
		name: string,
		input: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<IToolResult> {
		const tool = this._tools.get(name);
		if (!tool) {
			return {
				success: false,
				output: `Unknown tool: ${name}`,
				truncated: false,
			};
		}

		// Network-gated tools: in v0.1 we don't have an onlineMode setting.
		// The web_fetch tool applies urlGuard.ts (SSRF defence) itself.
		// We keep the flag check here for forward compatibility — if v1.0
		// adds an `onlineMode` toggle, this is where the gate would live.
		// (No-op for v0.1.)
		if (tool.definition.requiresNetwork) {
			logger.verbose(`[ToolRegistry] Tool ${name} requires network — delegating SSRF check to tool impl`);
		}

		const startTime = Date.now();
		try {
			const result = await tool.executeFn(input, signal);
			result.metadata = {
				...result.metadata,
				durationMs: Date.now() - startTime,
			};
			return result;
		} catch (error) {
			return {
				success: false,
				output: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
				truncated: false,
				metadata: { durationMs: Date.now() - startTime },
			};
		}
	}

	registerTool(tool: ITool, executeFn: ToolExecuteFn): void {
		if (this._tools.has(tool.name)) {
			logger.warn(`[ToolRegistry] Tool already registered: ${tool.name}. Overwriting.`);
		}
		this._tools.set(tool.name, { definition: tool, executeFn });
		logger.verbose(`[ToolRegistry] Registered tool: ${tool.name}`);
	}

	unregisterTool(name: string): void {
		this._tools.delete(name);
		logger.verbose(`[ToolRegistry] Unregistered tool: ${name}`);
	}
}

// ---------------------------------------------------------------------------
// Singleton + accessor
// ---------------------------------------------------------------------------

let _instance: ToolRegistryService | undefined;

/**
 * Construct the singleton tool registry. Called once by `extension.ts`
 * during activate(). Throws if called twice (defensive — single-construction
 * guarantee for the registry).
 *
 * @internal
 */
export function initToolRegistry(): ToolRegistryService {
	if (_instance) {
		throw new Error('ToolRegistryService has already been initialised. Use getToolRegistry() instead.');
	}
	_instance = new ToolRegistryService();
	return _instance;
}

/**
 * Returns the singleton tool registry instance. Available after
 * `initToolRegistry()` has been called by `extension.ts` during activate().
 * Returns undefined if the extension has not been activated yet.
 */
export function getToolRegistry(): ToolRegistryService | undefined {
	return _instance;
}
