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

        // Create the main window.
        createWindow();

        // Register IPC handlers.
        registerIpcHandlers();

        logger.info(
                `Kovix ready. AI provider: ${aiService.activeProviderType ?? 'none'}, ` +
                `tools: ${registry.listTools().length}, ` +
                `agent loop: ready, ` +
                `MCP: ${mcpManager.connectedServerCount} servers.`,
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
