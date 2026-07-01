/**
 * main.ts — Electron main process entry point for Kovix standalone.
 *
 * Phase 0 pivot (D-015): replaces src/extension.ts as the app entry point.
 * Handles:
 *   - App lifecycle (ready, window-all-closed, activate)
 *   - BrowserWindow creation with preload
 *   - Service initialization (AI service, tool registry, agent loop, pending changes)
 *   - IPC handlers (see Step 4 of the pivot plan)
 *   - App state (workspace folders, secrets, config)
 *
 * Services are initialized in the same order as the old extension.ts:
 *   1. App state (workspace roots, secrets, config)
 *   2. AI service (Anthropic provider)
 *   3. Pending changes service
 *   4. Tool registry (7 built-in tools)
 *   5. Agent loop
 *   6. MCP manager
 */

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'path';
import { initAppState, getAppState, isAppStateInitialized } from '../src/platform/appState';
import { ConstructAIService } from '../src/llm/aiService';
import { pendingChangesService } from '../src/diff/pendingChangesService';
import { initToolRegistry } from '../src/tools/toolRegistryService';
import { initAgentLoop, getAgentLoop } from '../src/agent/agentLoop';
import { McpManager } from '../src/mcp/mcpManager';
import { resolveCommandConfirmation } from '../src/platform/prompts';
import { initCostGovernor, getCreditSystem } from '../src/swarm/costGovernor';
import { getSwarmOrchestrator, resolveSwarmApproval } from '../src/swarm/orchestrator';
import { getGitService } from '../src/git';
import { initConversationStore, getConversationStore } from '../src/memory/conversationStore';
import { initCodebaseIndexer, getCodebaseIndexer, IIndexOptions, ISearchOptions, IContextOptions } from '../src/memory/codebaseIndexer';
import { getFileWatcherService } from '../src/platform/fileWatcher';
import { logger } from '../src/util/logger';
import type { IApprovedPlan, AgentLoopEvent } from '../src/types/agent';

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let aiService: ConstructAIService | undefined;
let mcpManager: McpManager | undefined;
let _activeAbortController: AbortController | null = null;

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
        logger.info('Kovix starting up (Electron standalone — Phase 0 pivot, D-015).');

        // 1. Initialize app state.
        const baseDir = path.join(app.getPath('userData'), 'kovix-state');
        await initAppState(baseDir);

        // Set up safeStorage encryption for secrets.
        const state = getAppState();
        try {
                const { safeStorage } = require('electron') as typeof import('electron');
                if (safeStorage.isEncryptionAvailable()) {
                        state.secrets.setCrypto(
                                (plaintext: string) => safeStorage.encryptString(plaintext).toString('base64'),
                                (cipher: string) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
                        );
                        logger.info('[Main] safeStorage encryption enabled for secrets.');
                }
        } catch {
                logger.warn('[Main] safeStorage not available — secrets stored as base64 (dev mode).');
        }

        // 2. AI service.
        aiService = new ConstructAIService();
        logger.info(`[Main] AI service initialized. Active provider: ${aiService.activeProviderType ?? 'none'}`);

        // 3. Pending changes service — already a singleton at module level.
        logger.info('[Main] Pending changes service ready.');

        // 4. Tool registry.
        const registry = initToolRegistry();
        logger.info(`[Main] ToolRegistry initialized with ${registry.listTools().length} built-in tools.`);

        // 5. Agent loop.
        const workspaceRoots = {
                getWorkspaceRoots: () => state.workspaceRoots.roots,
        };
        initAgentLoop({
                aiService,
                toolRegistry: registry,
                pendingChanges: pendingChangesService,
                workspaceRoots,
        });
        logger.info('[Main] AgentLoop service created.');

        // 6. MCP manager.
        mcpManager = new McpManager(registry);
        void mcpManager.start().then(() => {
                logger.verbose(`[MCP] Started: ${mcpManager!.connectedServerCount} servers, ${mcpManager!.registeredToolCount} tools registered`);
        });

        // 7. Cost governor (required before swarm — per 08_SWARM_DESIGN.md §5).
        const { creditSystem } = initCostGovernor({ totalCredits: 500, enabled: true });
        logger.info(`[Main] Cost governor initialized: ${creditSystem.getTotalCredits()} credits.`);

        // 8. Conversation store (chat persistence).
        const stateDir = path.join(app.getPath('userData'), 'kovix-state');
        initConversationStore(stateDir);
        logger.info('[Main] Conversation store initialized.');

        // 9. Codebase indexer (RAG).
        initCodebaseIndexer(stateDir);
        logger.info('[Main] Codebase indexer initialized.');

        // 10. File watcher.
        const fileWatcher = getFileWatcherService();
        // Forward file change events to renderer.
        fileWatcher.onDidChange(e => sendToRenderer('file:changed', e));
        fileWatcher.onDidCreate(e => sendToRenderer('file:created', e));
        fileWatcher.onDidDelete(e => sendToRenderer('file:deleted', e));

        // Start watching workspace roots.
        if (state.workspaceRoots.roots.length > 0) {
                fileWatcher.startWatching([...state.workspaceRoots.roots]);
                logger.info(`[Main] File watcher started for ${state.workspaceRoots.roots.length} root(s).`);
        }

        // Create the main window.
        createWindow();

        // Register IPC handlers.
        registerIpcHandlers();

        logger.info(
                `Kovix ready. AI provider: ${aiService.activeProviderType ?? 'none'}, ` +
                `tools: ${registry.listTools().length}, ` +
                `agent loop: ready, ` +
                `MCP: ${mcpManager.connectedServerCount} servers, ` +
                `providers: ${aiService.activeProviderType ?? 'none'}.`,
        );
});

app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
                app.quit();
        }
});

app.on('activate', () => {
        if (mainWindow === null) {
                createWindow();
        }
});

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow(): void {
        mainWindow = new BrowserWindow({
                width: 1200,
                height: 800,
                minWidth: 600,
                minHeight: 400,
                title: 'Kovix',
                frame: false,                      // Frameless — custom title bar
                titleBarStyle: 'hidden',           // macOS: hide title but keep traffic lights
                backgroundColor: '#0d1117',        // Match the dark theme background
                webPreferences: {
                        preload: path.join(__dirname, 'preload.js'),
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: false,
                },
        });

        // Load the renderer.
        const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
        mainWindow.loadFile(rendererPath).catch(() => {
                logger.error(`[Main] Failed to load renderer: ${rendererPath}`);
        });

        mainWindow.webContents.on('did-finish-load', () => {
                logger.info('[Main] Renderer loaded');
        });

        mainWindow.on('closed', () => {
                mainWindow = null;
        });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
        // ---- App ----
        ipcMain.handle('app:ready', async () => {
                if (!isAppStateInitialized()) return { status: 'not_ready' };
                const state = getAppState();
                return {
                        status: 'ready',
                        workspaceRoots: state.workspaceRoots.roots,
                        config: state.config,
                };
        });

        ipcMain.handle('app:pickFolder', async () => {
                if (!mainWindow) return { cancelled: true };
                const result = await dialog.showOpenDialog(mainWindow, {
                        properties: ['openDirectory'],
                        title: 'Select workspace folder',
                });
                if (result.canceled || result.filePaths.length === 0) {
                        return { cancelled: true };
                }
                const state = getAppState();
                state.workspaceRoots.setRoots(result.filePaths);
                return { cancelled: false, paths: result.filePaths };
        });

        ipcMain.handle('app:getConfig', async () => {
                if (!isAppStateInitialized()) return {};
                return getAppState().config;
        });

        ipcMain.handle('app:updateConfig', async (_event: Electron.IpcMainInvokeEvent, updates: Record<string, unknown>) => {
                if (!isAppStateInitialized()) return;
                const config = getAppState().config;
                for (const [key, value] of Object.entries(updates)) {
                        if (key in config) {
                                (config as unknown as Record<string, unknown>)[key] = value;
                        }
                }
                await getAppState().config.save();
        });

        // ---- Secrets ----
        ipcMain.handle('secrets:get', async (_event, key: string) => {
                if (!isAppStateInitialized()) return undefined;
                return getAppState().secrets.get(key);
        });

        ipcMain.handle('secrets:set', async (_event, key: string, value: string) => {
                if (!isAppStateInitialized()) return;
                await getAppState().secrets.store(key, value);
        });

        ipcMain.handle('secrets:delete', async (_event, key: string) => {
                if (!isAppStateInitialized()) return;
                await getAppState().secrets.delete(key);
        });

        // ---- Agent ----
        ipcMain.handle('agent:sendTask', async (_event, text: string) => {
                const agentLoop = getAgentLoop();
                if (!agentLoop) {
                        return { error: 'Agent loop not initialized' };
                }
                if (agentLoop.isRunning) {
                        return { error: 'Agent is already running' };
                }

                _activeAbortController = new AbortController();

                try {
                        const plan = await agentLoop.runPlanningPhase(text, _activeAbortController.signal);
                        // Forward plan to renderer for approval.
                        sendToRenderer('agent:event', { type: 'plan_ready', plan });
                        return { success: true, stepCount: plan.steps.length };
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        return { error: msg };
                }
        });

        ipcMain.handle('agent:chat', async (_event, text: string) => {
                const agentLoop = getAgentLoop();
                if (!agentLoop) return { error: 'Agent loop not initialized' };
                if (agentLoop.isRunning) return { error: 'Agent is already running' };

                _activeAbortController = new AbortController();

                try {
                        const stream = agentLoop.chat(text, _activeAbortController.signal);
                        for await (const event of stream) {
                                sendToRenderer('agent:event', forwardAgentLoopEvent(event));
                        }
                        return { success: true };
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        return { error: msg };
                }
        });

        ipcMain.handle('agent:cancel', async () => {
                if (_activeAbortController) {
                        _activeAbortController.abort();
                        _activeAbortController = null;
                }
                return { success: true };
        });

        ipcMain.handle('agent:approvePlan', async (_event, planData: unknown) => {
                const agentLoop = getAgentLoop();
                if (!agentLoop) return { error: 'Agent loop not initialized' };

                _activeAbortController = new AbortController();

                try {
                        const plan = planData as IApprovedPlan;
                        const stream = agentLoop.runWithApprovedPlan(plan, _activeAbortController.signal);

                        // Forward events to renderer as they arrive.
                        for await (const event of stream) {
                                const forwarded = forwardAgentLoopEvent(event);
                                sendToRenderer('agent:event', forwarded);
                        }
                        return { success: true };
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        return { error: msg };
                }
        });

        ipcMain.handle('agent:cancelPlan', async () => {
                if (_activeAbortController) {
                        _activeAbortController.abort();
                        _activeAbortController = null;
                }
                return { success: true };
        });

        ipcMain.handle('agent:resumeMilestone', async () => {
                const agentLoop = getAgentLoop();
                if (!agentLoop) return;
                agentLoop.resumeFromMilestone();
        });

        ipcMain.handle('agent:skipMilestone', async () => {
                const agentLoop = getAgentLoop();
                if (!agentLoop) return;
                agentLoop.skipCurrentMilestone();
        });

        ipcMain.handle('agent:listModels', async () => {
                if (!aiService || !aiService.activeProvider) return [];
                try {
                        return await aiService.activeProvider.listModels();
                } catch {
                        return [];
                }
        });

        ipcMain.handle('agent:setModel', async (_event: Electron.IpcMainInvokeEvent, modelId: string) => {
                if (!aiService || !aiService.activeProvider) return false;
                try {
                        const ok = await aiService.activeProvider.setActiveModel(modelId);
                        if (ok) {
                                // Persist the model choice
                                getAppState().config.llmActiveModel = modelId;
                        }
                        return ok;
                } catch {
                        return false;
                }
        });

        ipcMain.handle('agent:switchProvider', async (_event: Electron.IpcMainInvokeEvent, providerType: string) => {
                if (!aiService) return false;
                try {
                        const ok = await aiService.switchProvider(providerType as import('../src/types/llm').AIProviderType);
                        if (ok) {
                                // Persist the provider choice
                                getAppState().config.llmActiveProvider = providerType;
                                // Also persist — need to save config
                                await getAppState().config.save();
                        }
                        return ok;
                } catch {
                        return false;
                }
        });

        ipcMain.handle('agent:listProviders', async () => {
                // Return the list of registered providers with their active models.
                return [
                        { type: 'anthropic', displayName: 'Anthropic', activeModel: aiService?.getProvider('anthropic')?.getActiveModel()?.id ?? '' },
                        { type: 'nvidia-nim', displayName: 'NVIDIA NIM', activeModel: aiService?.getProvider('nvidia-nim')?.getActiveModel()?.id ?? '' },
                        { type: 'openrouter', displayName: 'OpenRouter', activeModel: aiService?.getProvider('openrouter')?.getActiveModel()?.id ?? '' },
                        { type: 'openai', displayName: 'OpenAI', activeModel: aiService?.getProvider('openai')?.getActiveModel()?.id ?? '' },
                        { type: 'ollama', displayName: 'Ollama (Local)', activeModel: aiService?.getProvider('ollama')?.getActiveModel()?.id ?? '' },
                        { type: 'deepseek', displayName: 'DeepSeek', activeModel: aiService?.getProvider('deepseek')?.getActiveModel()?.id ?? '' },
                ];
        });

        ipcMain.handle('agent:getActiveProvider', async () => {
                if (!aiService) return 'anthropic';
                return aiService.activeProviderType ?? 'anthropic';
        });

        // ---- Pending changes ----
        ipcMain.handle('pending:accept', async (_event: Electron.IpcMainInvokeEvent, filePath: string) => {
                // Use platform Uri to resolve and accept
                const { Uri } = require('../src/platform/uris') as typeof import('../src/platform/uris');
                await pendingChangesService.accept(Uri.file(filePath));
                notifyPendingChanged();
        });

        ipcMain.handle('pending:reject', async (_event: Electron.IpcMainInvokeEvent, filePath: string) => {
                const { Uri } = require('../src/platform/uris') as typeof import('../src/platform/uris');
                await pendingChangesService.reject(Uri.file(filePath));
                notifyPendingChanged();
        });

        ipcMain.handle('pending:acceptAll', async () => {
                await pendingChangesService.acceptAll();
                notifyPendingChanged();
        });

        ipcMain.handle('pending:rejectAll', async () => {
                await pendingChangesService.rejectAll();
                notifyPendingChanged();
        });

        ipcMain.handle('pending:getSnapshot', async () => {
                return pendingChangesService.pendingEntries.map(e => ({
                        filePath: e.uri.fsPath,
                        isNewFile: e.isNewFile,
                        proposedContentLength: e.proposedContent.length,
                }));
        });

        // ---- File system (for file tree / editor) ----
        ipcMain.handle('fs:listDirectory', async (_event: Electron.IpcMainInvokeEvent, dirPath: string) => {
                try {
                        const { listDirectory } = require('../src/platform/fs') as typeof import('../src/platform/fs');
                        // Normalize path separators for the current OS
                        const normalized = path.normalize(dirPath);
                        logger.info(`[fs:listDirectory] dirPath="${dirPath}" normalized="${normalized}"`);
                        const entries = await listDirectory(normalized);
                        // Sort: directories first, then files, alphabetical within each group.
                        entries.sort((a, b) => {
                                if (a[1] === b[1]) return a[0].localeCompare(b[0]);
                                return a[1] === 'directory' ? -1 : 1;
                        });
                        return { entries };
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        return { error: msg };
                }
        });

        ipcMain.handle('fs:readFile', async (_event: Electron.IpcMainInvokeEvent, filePath: string) => {
                try {
                        const { readFileText } = require('../src/platform/fs') as typeof import('../src/platform/fs');
                        const normalized = path.normalize(filePath);
                        const content = await readFileText(normalized);
                        return { content };
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        return { error: msg };
                }
        });

        // ---- Pending changes (detail) ----
        ipcMain.handle('pending:getEntryDetail', async (_event: Electron.IpcMainInvokeEvent, filePath: string) => {
                const entry = pendingChangesService.pendingEntries.find(e => e.uri.fsPath === filePath);
                if (!entry) {
                        return null;
                }
                return {
                        filePath: entry.uri.fsPath,
                        isNewFile: entry.isNewFile,
                        originalContent: entry.originalContent,
                        proposedContent: entry.proposedContent,
                };
        });

        // ---- Swarm (multi-agent) ----
        ipcMain.handle('swarm:execute', async (_event: Electron.IpcMainInvokeEvent, planData: unknown) => {
                if (!aiService) return { error: 'AI service not initialized' };
                try {
                        const plan = planData as IApprovedPlan;
                        const orchestrator = getSwarmOrchestrator(aiService);
                        const stream = orchestrator.execute(plan, {
                                aiService,
                                toolRegistry: initToolRegistry(),
                                pendingChanges: pendingChangesService,
                                workspaceRoots: { getWorkspaceRoots: () => getAppState().workspaceRoots.roots },
                        });

                        for await (const event of stream) {
                                sendToRenderer('swarm:event', event);
                        }
                        return { success: true };
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        return { error: msg };
                }
        });

        ipcMain.handle('swarm:approvePartition', async () => {
                resolveSwarmApproval(true);
                return { success: true };
        });

        ipcMain.handle('swarm:rejectPartition', async () => {
                resolveSwarmApproval(false);
                return { success: true };
        });

        // ---- Cost governor ----
        ipcMain.handle('credits:getStatus', async () => {
                const cs = getCreditSystem();
                return {
                        remaining: cs.getCreditsRemaining(),
                        total: cs.getTotalCredits(),
                        enabled: cs.isEnabled(),
                        stats: cs.getStats(),
                };
        });

        ipcMain.handle('credits:add', async (_event: Electron.IpcMainInvokeEvent, amount: number) => {
                getCreditSystem().addCredits(amount);
                return { success: true };
        });

        ipcMain.handle('credits:reset', async () => {
                getCreditSystem().reset();
                return { success: true };
        });

        // ---- Git integration ----
        const gitService = getGitService();

        ipcMain.handle('git:status', async (_event, repoPath: string) => {
                try { return await gitService.getStatus(repoPath); }
                catch (e) { return { error: (e as Error).message }; }
        });

        ipcMain.handle('git:branches', async (_event, repoPath: string) => {
                try { return await gitService.getBranches(repoPath); }
                catch (e) { return { error: (e as Error).message }; }
        });

        ipcMain.handle('git:log', async (_event, repoPath: string, count?: number) => {
                try { return await gitService.getLog(repoPath, count); }
                catch (e) { return { error: (e as Error).message }; }
        });

        ipcMain.handle('git:diff', async (_event, repoPath: string, options?: { staged?: boolean; filePath?: string }) => {
                try { return await gitService.getDiff(repoPath, options); }
                catch (e) { return { error: (e as Error).message }; }
        });

        ipcMain.handle('git:diffSummary', async (_event, repoPath: string) => {
                try { return await gitService.getDiffSummary(repoPath); }
                catch (e) { return { error: (e as Error).message }; }
        });

        ipcMain.handle('git:stage', async (_event, repoPath: string, filePaths: string[]) => {
                await gitService.stage(repoPath, filePaths);
        });

        ipcMain.handle('git:unstage', async (_event, repoPath: string, filePaths: string[]) => {
                await gitService.unstage(repoPath, filePaths);
        });

        ipcMain.handle('git:commit', async (_event, repoPath: string, message: string) => {
                return await gitService.commit(repoPath, message);
        });

        ipcMain.handle('git:checkout', async (_event, repoPath: string, branch: string) => {
                await gitService.checkout(repoPath, branch);
        });

        ipcMain.handle('git:createBranch', async (_event, repoPath: string, name: string, checkout?: boolean) => {
                await gitService.createBranch(repoPath, name, checkout);
        });

        ipcMain.handle('git:deleteBranch', async (_event, repoPath: string, name: string, force?: boolean) => {
                await gitService.deleteBranch(repoPath, name, force);
        });

        ipcMain.handle('git:pull', async (_event, repoPath: string, remote?: string, branch?: string) => {
                return await gitService.pull(repoPath, remote, branch);
        });

        ipcMain.handle('git:push', async (_event, repoPath: string, remote?: string, branch?: string) => {
                await gitService.push(repoPath, remote, branch);
        });

        ipcMain.handle('git:stash', async (_event, repoPath: string, message?: string) => {
                await gitService.stash(repoPath, message);
        });

        ipcMain.handle('git:stashPop', async (_event, repoPath: string) => {
                await gitService.stashPop(repoPath);
        });

        ipcMain.handle('git:blame', async (_event, repoPath: string, filePath: string) => {
                return await gitService.blame(repoPath, filePath);
        });

        ipcMain.handle('git:fileHistory', async (_event, repoPath: string, filePath: string, count?: number) => {
                return await gitService.getFileHistory(repoPath, filePath, count);
        });

        ipcMain.handle('git:remotes', async (_event, repoPath: string) => {
                return await gitService.getRemotes(repoPath);
        });

        ipcMain.handle('git:init', async (_event, repoPath: string) => {
                await gitService.init(repoPath);
        });

        // ---- Conversation store ----
        ipcMain.handle('conversation:list', async () => {
                return await getConversationStore().listConversations();
        });

        ipcMain.handle('conversation:load', async (_event, id: string) => {
                return await getConversationStore().loadConversation(id);
        });

        ipcMain.handle('conversation:create', async (_event, title?: string) => {
                return await getConversationStore().createConversation(title);
        });

        ipcMain.handle('conversation:delete', async (_event, id: string) => {
                await getConversationStore().deleteConversation(id);
        });

        ipcMain.handle('conversation:getActive', async () => {
                return await getConversationStore().getActiveConversation();
        });

        ipcMain.handle('conversation:setActive', async (_event, id: string) => {
                await getConversationStore().setActiveConversation(id);
        });

        ipcMain.handle('conversation:addMessage', async (_event, conversationId: string, message: unknown) => {
                const stored = message as import('../src/memory/conversationStore').IStoredMessage;
                const chatMsg: import('../src/types/llm').IChatMessage = {
                        role: stored.role as 'user' | 'assistant' | 'system',
                        content: stored.content,
                };
                await getConversationStore().addMessage(conversationId, chatMsg);
        });

        // ---- Codebase indexer ----
        ipcMain.handle('indexer:status', async () => {
                return getCodebaseIndexer().getIndexStatus();
        });

        ipcMain.handle('indexer:start', async (_event, rootPath: string, options?: unknown) => {
                const indexer = getCodebaseIndexer();
                const results = [];
                for await (const progress of indexer.indexWorkspace(rootPath, options as IIndexOptions)) {
                        sendToRenderer('indexer:progress', progress);
                        results.push(progress);
                }
                return results;
        });

        ipcMain.handle('indexer:search', async (_event, query: string, options?: unknown) => {
                return await getCodebaseIndexer().search(query, options as ISearchOptions);
        });

        ipcMain.handle('indexer:fileContext', async (_event, filePath: string, options?: unknown) => {
                return await getCodebaseIndexer().getFileContext(filePath, options as IContextOptions);
        });

        // ---- File watcher ----
        ipcMain.handle('watcher:start', async (_event, rootPaths: string[]) => {
                getFileWatcherService().startWatching(rootPaths);
        });

        ipcMain.handle('watcher:stop', async () => {
                getFileWatcherService().stopWatching();
        });

        // ---- Window controls (for frameless title bar) ----
        ipcMain.handle('window:minimize', async () => {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
        });
        ipcMain.handle('window:maximize', async () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                        if (mainWindow.isMaximized()) {
                                mainWindow.unmaximize();
                        } else {
                                mainWindow.maximize();
                        }
                }
        });
        ipcMain.handle('window:close', async () => {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        });
        ipcMain.handle('window:isMaximized', async () => {
                if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.isMaximized();
                return false;
        });

        // ---- Command confirmation ----
        ipcMain.handle('prompt:confirmResponse', async (_event, command: string, approved: boolean) => {
                resolveCommandConfirmation(command, approved);
        });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendToRenderer(channel: string, data: unknown): void {
        if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(channel, data);
        }
}

function notifyPendingChanged(): void {
        sendToRenderer('pending:changed', pendingChangesService.pendingEntries.map(e => ({
                filePath: e.uri.fsPath,
                isNewFile: e.isNewFile,
                originalContent: e.originalContent,
                proposedContent: e.proposedContent,
                proposedContentLength: e.proposedContent.length,
        })));
}

/**
 * Forward an AgentLoopEvent to the renderer. Translates the 12+ event
 * variants into a serialisable format. This is the same translation as
 * the old agentPanel.ts forwardAgentLoopEvent().
 *
 * We keep the same AgentLoopEvent types — no redesign.
 */
function forwardAgentLoopEvent(event: AgentLoopEvent): Record<string, unknown> {
        // AgentLoopEvent is already a plain object — just return it.
        // The renderer (chat.js) handles all 12+ variants.
        return { ...event };
}
