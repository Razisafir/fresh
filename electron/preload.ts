/**
 * preload.ts — Electron preload script.
 *
 * Runs in the renderer's preload context. Uses contextBridge.exposeInMainWorld
 * to expose a safe, limited API to the renderer process. The renderer accesses
 * this via `window.__kovix_api`.
 *
 * No Node.js or Electron APIs are directly exposed — only the explicitly
 * defined IPC bridge methods below.
 */

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const api = {
        // ---- Agent operations ----
        sendTask: (text: string) => ipcRenderer.invoke('agent:sendTask', text),
        chat: (text: string) => ipcRenderer.invoke('agent:chat', text),
        cancel: () => ipcRenderer.invoke('agent:cancel'),
        approvePlan: (plan: unknown) => ipcRenderer.invoke('agent:approvePlan', plan),
        cancelPlan: () => ipcRenderer.invoke('agent:cancelPlan'),
        resumeMilestone: () => ipcRenderer.invoke('agent:resumeMilestone'),
        skipMilestone: () => ipcRenderer.invoke('agent:skipMilestone'),
        listModels: () => ipcRenderer.invoke('agent:listModels'),
        setModel: (modelId: string) => ipcRenderer.invoke('agent:setModel', modelId),
        switchProvider: (providerType: string) => ipcRenderer.invoke('agent:switchProvider', providerType),
        listProviders: () => ipcRenderer.invoke('agent:listProviders'),
        getActiveProvider: () => ipcRenderer.invoke('agent:getActiveProvider'),

        // ---- Pending changes ----
        acceptChange: (filePath: string) => ipcRenderer.invoke('pending:accept', filePath),
        rejectChange: (filePath: string) => ipcRenderer.invoke('pending:reject', filePath),
        acceptAllChanges: () => ipcRenderer.invoke('pending:acceptAll'),
        rejectAllChanges: () => ipcRenderer.invoke('pending:rejectAll'),
        getPendingSnapshot: () => ipcRenderer.invoke('pending:getSnapshot'),
        getPendingEntryDetail: (filePath: string) => ipcRenderer.invoke('pending:getEntryDetail', filePath),

        // ---- File system (for file tree / editor) ----
        listDirectory: (dirPath: string) => ipcRenderer.invoke('fs:listDirectory', dirPath),
        readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),

        // ---- App operations ----
        pickFolder: () => ipcRenderer.invoke('app:pickFolder'),
        workspaceRoots: () => ipcRenderer.invoke('app:workspaceRoots'),
        getConfig: () => ipcRenderer.invoke('app:getConfig'),
        updateConfig: (updates: Record<string, unknown>) => ipcRenderer.invoke('app:updateConfig', updates),
        getAppState: () => ipcRenderer.invoke('app:ready'),

        // ---- Secrets ----
        getSecret: (key: string) => ipcRenderer.invoke('secrets:get', key),
        setSecret: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),

        // ---- Window controls (for frameless title bar) ----
        windowMinimize: () => ipcRenderer.invoke('window:minimize'),
        windowMaximize: () => ipcRenderer.invoke('window:maximize'),
        windowClose: () => ipcRenderer.invoke('window:close'),
        windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

        // ---- Pipeline (Idea-to-Execution) ----
        pipelineStartRefinement: (rawIdea: string) => ipcRenderer.invoke('pipeline:startRefinement', rawIdea),
        pipelineContinueRefinement: (userInput: string) => ipcRenderer.invoke('pipeline:continueRefinement', userInput),
        pipelineApproveSpec: () => ipcRenderer.invoke('pipeline:approveSpec'),
        pipelineRejectSpec: (feedback: string) => ipcRenderer.invoke('pipeline:rejectSpec', feedback),
        pipelineConfigurePreFlight: (config: unknown) => ipcRenderer.invoke('pipeline:configurePreFlight', config),
        pipelineExecute: () => ipcRenderer.invoke('pipeline:execute'),
        pipelineAbort: () => ipcRenderer.invoke('pipeline:abort'),
        pipelineGetState: () => ipcRenderer.invoke('pipeline:getState'),
        pipelineStartV2Refinement: (v2Feedback: string) => ipcRenderer.invoke('pipeline:startV2Refinement', v2Feedback),
        pipelineReset: () => ipcRenderer.invoke('pipeline:reset'),

        // ---- Swarm (multi-agent) ----
        swarmExecute: (plan: unknown) => ipcRenderer.invoke('swarm:execute', plan),
        swarmApprovePartition: () => ipcRenderer.invoke('swarm:approvePartition'),
        swarmRejectPartition: () => ipcRenderer.invoke('swarm:rejectPartition'),

        // ---- Credits / Cost governor ----
        getCreditsStatus: () => ipcRenderer.invoke('credits:getStatus'),
        addCredits: (amount: number) => ipcRenderer.invoke('credits:add', amount),
        resetCredits: () => ipcRenderer.invoke('credits:reset'),

        // ---- Command confirmation ----
        respondToConfirmation: (command: string, approved: boolean) =>
                ipcRenderer.invoke('prompt:confirmResponse', command, approved),

        // ---- Event listeners (main → renderer) ----
        onAgentEvent: (callback: (event: unknown) => void) => {
                const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
                ipcRenderer.on('agent:event', handler);
                return () => { ipcRenderer.removeListener('agent:event', handler); };
        },
        onPendingChanged: (callback: (entries: unknown) => void) => {
                const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
                ipcRenderer.on('pending:changed', handler);
                return () => { ipcRenderer.removeListener('pending:changed', handler); };
        },
        onPromptConfirmCommand: (callback: (command: string) => void) => {
                const handler = (_event: Electron.IpcRendererEvent, command: string) => callback(command);
                ipcRenderer.on('prompt:confirmCommand', handler);
                return () => { ipcRenderer.removeListener('prompt:confirmCommand', handler); };
        },
        onSwarmEvent: (callback: (event: unknown) => void) => {
                const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
                ipcRenderer.on('swarm:event', handler);
                return () => { ipcRenderer.removeListener('swarm:event', handler); };
        },
        onFileChanged: (callback: (event: unknown) => void) => {
                const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
                ipcRenderer.on('file:changed', handler);
                return () => { ipcRenderer.removeListener('file:changed', handler); };
        },
        onFileCreated: (callback: (event: unknown) => void) => {
                const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
                ipcRenderer.on('file:created', handler);
                return () => { ipcRenderer.removeListener('file:created', handler); };
        },
        onFileDeleted: (callback: (event: unknown) => void) => {
                const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
                ipcRenderer.on('file:deleted', handler);
                return () => { ipcRenderer.removeListener('file:deleted', handler); };
        },
        onPipelineEvent: (callback: (event: unknown) => void) => {
                const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
                ipcRenderer.on('pipeline:event', handler);
                return () => { ipcRenderer.removeListener('pipeline:event', handler); };
        },
};

contextBridge.exposeInMainWorld('__kovix_api', api);
