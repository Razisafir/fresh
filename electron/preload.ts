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
	listRoles: () => ipcRenderer.invoke('agent:listRoles'),
	setRole: (role: string) => ipcRenderer.invoke('agent:setRole', role),
	getRole: () => ipcRenderer.invoke('agent:getRole'),
	listSlashCommands: () => ipcRenderer.invoke('agent:listSlashCommands'),

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
	getConfig: () => ipcRenderer.invoke('app:getConfig'),
	updateConfig: (updates: Record<string, unknown>) => ipcRenderer.invoke('app:updateConfig', updates),
	getAppState: () => ipcRenderer.invoke('app:ready'),

	// ---- Secrets ----
	hasSecret: (key: string) => ipcRenderer.invoke('secrets:has', key),
	getSecret: (key: string) => ipcRenderer.invoke('secrets:get', key),
	setSecret: (key: string, value: string) => ipcRenderer.invoke('secrets:set', key, value),
	deleteSecret: (key: string) => ipcRenderer.invoke('secrets:delete', key),

	// ---- Window controls (for frameless title bar) ----
	windowMinimize: () => ipcRenderer.invoke('window:minimize'),
	windowMaximize: () => ipcRenderer.invoke('window:maximize'),
	windowClose: () => ipcRenderer.invoke('window:close'),
	windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),

	// ---- Swarm (multi-agent) ----
	swarmExecute: (plan: unknown) => ipcRenderer.invoke('swarm:execute', plan),
	swarmApprovePartition: () => ipcRenderer.invoke('swarm:approvePartition'),
	swarmRejectPartition: () => ipcRenderer.invoke('swarm:rejectPartition'),

	// ---- Credits / Cost governor ----
	getCreditsStatus: () => ipcRenderer.invoke('credits:getStatus'),
	addCredits: (amount: number) => ipcRenderer.invoke('credits:add', amount),
	resetCredits: () => ipcRenderer.invoke('credits:reset'),

	// ---- Telemetry ----
	getUsageLog: (options?: { limit?: number; event?: string }) => ipcRenderer.invoke('telemetry:getUsageLog', options),
	getTelemetrySummary: () => ipcRenderer.invoke('telemetry:getSummary'),

	// ---- Command confirmation ----
	respondToConfirmation: (command: string, approved: boolean) =>
		ipcRenderer.invoke('prompt:confirmResponse', command, approved),

	// ---- Git integration ----
	gitStatus: (repoPath: string) => ipcRenderer.invoke('git:status', repoPath),
	gitBranches: (repoPath: string) => ipcRenderer.invoke('git:branches', repoPath),
	gitLog: (repoPath: string, count?: number) => ipcRenderer.invoke('git:log', repoPath, count),
	gitDiff: (repoPath: string, options?: { staged?: boolean; filePath?: string }) => ipcRenderer.invoke('git:diff', repoPath, options),
	gitDiffSummary: (repoPath: string) => ipcRenderer.invoke('git:diffSummary', repoPath),
	gitStage: (repoPath: string, filePaths: string[]) => ipcRenderer.invoke('git:stage', repoPath, filePaths),
	gitUnstage: (repoPath: string, filePaths: string[]) => ipcRenderer.invoke('git:unstage', repoPath, filePaths),
	gitCommit: (repoPath: string, message: string) => ipcRenderer.invoke('git:commit', repoPath, message),
	gitCheckout: (repoPath: string, branch: string) => ipcRenderer.invoke('git:checkout', repoPath, branch),
	gitCreateBranch: (repoPath: string, name: string, checkout?: boolean) => ipcRenderer.invoke('git:createBranch', repoPath, name, checkout),
	gitDeleteBranch: (repoPath: string, name: string, force?: boolean) => ipcRenderer.invoke('git:deleteBranch', repoPath, name, force),
	gitPull: (repoPath: string, remote?: string, branch?: string) => ipcRenderer.invoke('git:pull', repoPath, remote, branch),
	gitPush: (repoPath: string, remote?: string, branch?: string) => ipcRenderer.invoke('git:push', repoPath, remote, branch),
	gitStash: (repoPath: string, message?: string) => ipcRenderer.invoke('git:stash', repoPath, message),
	gitStashPop: (repoPath: string) => ipcRenderer.invoke('git:stashPop', repoPath),
	gitBlame: (repoPath: string, filePath: string) => ipcRenderer.invoke('git:blame', repoPath, filePath),
	gitFileHistory: (repoPath: string, filePath: string, count?: number) => ipcRenderer.invoke('git:fileHistory', repoPath, filePath, count),
	gitRemotes: (repoPath: string) => ipcRenderer.invoke('git:remotes', repoPath),
	gitInit: (repoPath: string) => ipcRenderer.invoke('git:init', repoPath),

	// ---- Conversation store ----
	listConversations: () => ipcRenderer.invoke('conversation:list'),
	loadConversation: (id: string) => ipcRenderer.invoke('conversation:load', id),
	createConversation: (title?: string) => ipcRenderer.invoke('conversation:create', title),
	deleteConversation: (id: string) => ipcRenderer.invoke('conversation:delete', id),
	getActiveConversation: () => ipcRenderer.invoke('conversation:getActive'),
	setActiveConversation: (id: string) => ipcRenderer.invoke('conversation:setActive', id),
	addConversationMessage: (conversationId: string, message: unknown) => ipcRenderer.invoke('conversation:addMessage', conversationId, message),

	// ---- Codebase indexer (RAG) ----
	getIndexerStatus: () => ipcRenderer.invoke('indexer:status'),
	startIndexing: (rootPath: string, options?: unknown) => ipcRenderer.invoke('indexer:start', rootPath, options),
	searchIndex: (query: string, options?: unknown) => ipcRenderer.invoke('indexer:search', query, options),
	getFileContext: (filePath: string, options?: unknown) => ipcRenderer.invoke('indexer:fileContext', filePath, options),

	// ---- File watcher ----
	startWatching: (rootPaths: string[]) => ipcRenderer.invoke('watcher:start', rootPaths),
	stopWatching: () => ipcRenderer.invoke('watcher:stop'),

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
	onIndexerProgress: (callback: (progress: unknown) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
		ipcRenderer.on('indexer:progress', handler);
		return () => { ipcRenderer.removeListener('indexer:progress', handler); };
	},
};

contextBridge.exposeInMainWorld('__kovix_api', api);
