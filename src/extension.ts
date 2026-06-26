/**
 * extension.ts — Layer 4 entry point for the Kovix VS Code extension.
 *
 * Phase 3 Round 2C status: AI service + pending changes service + tool
 * registry (7 built-in tools) + AGENT LOOP + 6 commands wired. The
 * Plan→Approve→Execute→Verify loop is now end-to-end functional via
 * the `kovix.runTask` command (output streamed to a Kovix Agent output
 * channel for v0.1; the webview UI lands in a later round).
 *
 * Per 02_ARCHITECTURE.md §4.8, the eventual activate() will also
 * register webview view providers (ui/*.ts) and configuration change
 * listeners (configuration.ts). Those arrive in the next round (UI
 * Layer 3).
 *
 * v0.1-alpha scope: activate() constructs the AI service (Anthropic
 * provider), the pending changes service, the tool registry (7 built-in
 * tools), the agent loop (the crown jewel), and registers the command
 * handlers. All are singletons held by the extension context for
 * disposal.
 *
 * Decisions referenced: D-011 (extension route). Bug 4 fix (abort
 * in-flight stream on provider switch) lives in aiService.ts. P0-5 fix
 * (no direct disk writes from agent loop) lives in pendingChangesService.ts.
 * SEC-3/SEC-7/SEC-9 invariants enforced by terminalExecutor + commandBlocklist.
 * SEC-4 enforced by workspaceGuard + the built-in file tools.
 */

import * as vscode from 'vscode';
import { logger } from './util/logger';
import { ConstructAIService } from './llm/aiService';
import { pendingChangesService } from './diff/pendingChangesService';
import { initToolRegistry, getToolRegistry } from './tools/toolRegistryService';
import { initAgentLoop, getAgentLoop } from './agent/agentLoop';
import { IWorkspaceRootsProvider } from './security/workspaceGuard';
import { registerCommands } from './commands';

let _aiService: ConstructAIService | undefined;

/**
 * Workspace roots provider — adapts vscode.workspace.workspaceFolders to
 * the IWorkspaceRootsProvider interface declared in workspaceGuard.ts
 * (Layer 1). This keeps Layer 1 free of `vscode` imports.
 */
class WorkspaceRootsProvider implements IWorkspaceRootsProvider {
	getWorkspaceRoots(): readonly string[] {
		return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
	}
}

/**
 * Returns the singleton AI service instance. Available after activate()
 * has been called by VS Code. Returns undefined if the extension has
 * not been activated yet (e.g., during unit tests).
 */
export function getAIService(): ConstructAIService | undefined {
	return _aiService;
}

/**
 * Returns the singleton tool registry instance. Available after activate().
 * Returns undefined if the extension has not been activated yet.
 */
export function getToolRegistryInstance() {
	return getToolRegistry();
}

/**
 * Returns the singleton agent loop instance. Available after activate().
 * Returns undefined if the extension has not been activated yet.
 */
export function getAgentLoopInstance() {
	return getAgentLoop();
}

/**
 * Called by VS Code when the extension is activated.
 * Activation events are declared in package.json (lazy: on `kovix.*` commands).
 */
export function activate(context: vscode.ExtensionContext): void {
	logger.info('Kovix extension activating (Phase 3 Round 2C — agent loop + commands wired).');

	// 1. AI service (registers Anthropic provider, reads kovix.llm.activeProvider).
	_aiService = new ConstructAIService(context);
	context.subscriptions.push(_aiService);

	// 2. Pending changes service (module-level singleton; P0-5 enforcement).
	context.subscriptions.push(pendingChangesService);

	// 3. Tool registry singleton. Auto-registers the 7 v0.1 built-in tools
	//    (read_file, write_file, list_directory, edit_file, run_command,
	//    search_code, web_fetch) via registerBuiltinTools() in its constructor.
	const registry = initToolRegistry();
	context.subscriptions.push({ dispose: () => logger.info('[ToolRegistry] Disposed via extension context') });

	// 4. Agent loop — the crown jewel. Wires AI service + tool registry +
	//    pending changes + workspace roots into the Plan→Approve→Execute→
	//    Verify loop.
	const workspaceRoots = new WorkspaceRootsProvider();
	const agentLoop = initAgentLoop({
		aiService: _aiService,
		toolRegistry: registry,
		pendingChanges: pendingChangesService,
		workspaceRoots,
	});
	context.subscriptions.push(agentLoop);

	// 5. Register v0.1 commands (openAgentPanel, manageApiKeys,
	//    setActiveMode, runTask, viewPendingChanges, resumeMilestone,
	//    skipMilestone).
	registerCommands(context);

	logger.info(
		`Kovix extension activated. AI provider: ${_aiService.activeProviderType ?? 'none'}, ` +
		`tools registered: ${registry.listTools().length}, ` +
		`agent loop: ready.`,
	);
}

/**
 * Called by VS Code when the extension is deactivated.
 * Release any resources held by services here.
 */
export function deactivate(): void {
	logger.info('Kovix extension deactivated.');
	_aiService = undefined;
}
