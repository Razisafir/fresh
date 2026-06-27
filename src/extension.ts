/**
 * extension.ts — Layer 4 entry point for the Kovix VS Code extension.
 *
 * Phase 3 Round 2D status: AI service + pending changes service + tool
 * registry (7 built-in tools) + AGENT LOOP + 6 commands + AGENT PANEL
 * WEBVIEW all wired. The Plan→Approve→Execute→Verify loop is now end-
 * to-end functional via the agent panel webview (the polished UI per
 * D-012 + D-013). The `kovix.runTask` command-palette entry remains as
 * the headless / power-user path.
 *
 * Per 02_ARCHITECTURE.md §4.8, activate() registers:
 *   1. AI service (Anthropic provider)
 *   2. Pending changes service (P0-5 enforcement)
 *   3. Tool registry (7 built-in tools)
 *   4. Agent loop (the crown jewel)
 *   5. Command handlers (6 v0.1 commands)
 *   6. Webview view providers (agent panel — this round)
 *
 * All are singletons held by the extension context for disposal.
 *
 * Decisions referenced: D-011 (extension route), D-012 (2-webview scope),
 * D-013 (Material aesthetic). Bug 4 fix (abort in-flight stream on
 * provider switch) lives in aiService.ts. P0-5 fix (no direct disk
 * writes from agent loop) lives in pendingChangesService.ts.
 * SEC-3/SEC-7/SEC-9 invariants enforced by terminalExecutor + commandBlocklist.
 * SEC-4 enforced by workspaceGuard + the built-in file tools.
 * R-008 fix (WebviewViewProvider instead of openView) lives in agentPanel.ts.
 */

import * as vscode from 'vscode';
import { logger } from './util/logger';
import { ConstructAIService } from './llm/aiService';
import { pendingChangesService } from './diff/pendingChangesService';
import { initToolRegistry, getToolRegistry } from './tools/toolRegistryService';
import { initAgentLoop, getAgentLoop } from './agent/agentLoop';
import { IWorkspaceRootsProvider } from './security/workspaceGuard';
import { registerCommands } from './commands';
import { registerAgentPanel } from './ui/agentPanel';
import { McpManager } from './mcp/mcpManager';

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

        // 6. Register the agent panel webview view provider (Round 2D).
        //    This binds the `kovix.agentPanel` view declared in package.json
        //    to the WebviewViewProvider in src/ui/agentPanel.ts. The
        //    provider resolves when the user first clicks the Kovix activity
        //    bar icon — fixing R-008 (openView was unreliable on first launch).
        //    We pass the AI service directly to avoid a circular import
        //    (agentPanel → extension → commands → agentPanel).
        registerAgentPanel(context, _aiService);

        // 7. MCP server host (Phase 8-B, M6). Reads kovix.mcp.servers, connects
        //    to each configured MCP server via stdio, discovers their tools, and
        //    registers them with the toolRegistry alongside the 7 built-ins.
        //    v1.0-beta scope: stdio transport only. Degrades gracefully if no
        //    servers are configured (zero-cost when unused).
        const mcpManager = new McpManager(registry);
        void mcpManager.start().then(() => {
                logger.verbose(`[MCP] Started: ${mcpManager.connectedServerCount} servers, ${mcpManager.registeredToolCount} tools registered`);
        });
        context.subscriptions.push({ dispose: () => void mcpManager.stop() });

        logger.info(
                `Kovix extension activated. AI provider: ${_aiService.activeProviderType ?? 'none'}, ` +
                `tools registered: ${registry.listTools().length}, ` +
                `agent loop: ready, ` +
                `agent panel: registered, ` +
                `MCP: ${mcpManager.connectedServerCount} servers connected.`,
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
