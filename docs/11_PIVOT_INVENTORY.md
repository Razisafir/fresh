# 11 — VS Code Dependency Inventory (Electron Pivot)

> Branch: `pivot/electron-standalone`
> Date: 2025-06-27
> Purpose: Complete catalog of every VS Code API dependency that must be abstracted or replaced for the Electron standalone pivot.

---

## 1. Package-Level Dependencies

| Dependency | Version | Type | Pivot Action |
|---|---|---|---|
| `@types/vscode` | `^1.95.0` | devDependency | Remove; replace with own interface definitions |
| `@vscode/vsce` | `^3.9.2` | devDependency | Remove; not needed for Electron packaging |
| `engines.vscode` | `^1.95.0` | package.json field | Remove; no longer a VS Code extension |

---

## 2. File-by-File VS Code API Usage

### 2.1 — Entry Point / Wiring (Layer 4)

| File | Import Style | VS Code APIs Used | Dependency Type |
|---|---|---|---|
| **`src/extension.ts`** | `import * as vscode from 'vscode'` | `vscode.workspace.workspaceFolders` (`.uri.fsPath`), `vscode.ExtensionContext` (param type, `.subscriptions`), `vscode.Disposable` (implicit via context) | **HARD** — This IS the VS Code activation entry point. Entire file must be replaced with an Electron `main.ts` |
| **`src/commands.ts`** | `import * as vscode from 'vscode'` | `vscode.ExtensionContext` (param, `.subscriptions`, `.secrets`), `vscode.commands.registerCommand`, `vscode.window.showErrorMessage`, `vscode.window.showWarningMessage`, `vscode.window.showInformationMessage`, `vscode.window.showInputBox`, `vscode.window.showQuickPick`, `vscode.window.withProgress`, `vscode.window.createOutputChannel`, `vscode.ProgressLocation.Notification`, `vscode.workspace.getConfiguration`, `vscode.ConfigurationTarget.Global`, `vscode.workspace.openTextDocument`, `vscode.window.showTextDocument` | **HARD** — All 7 command registrations use VS Code command/window APIs. Must be replaced with IPC handlers or Electron menu/keyboard shortcuts |
| **`src/ui/agentPanel.ts`** | `import * as vscode from 'vscode'` | `vscode.ExtensionContext`, `vscode.window.registerWebviewViewProvider`, `vscode.WebviewViewProvider`, `vscode.WebviewView`, `vscode.Disposable`, `vscode.Uri.joinPath`, `vscode.Uri.file`, `vscode.window.onDidChangeActiveColorTheme`, `vscode.commands.executeCommand`, `vscode.workspace.openTextDocument`, `vscode.window.showTextDocument`, `vscode.WebviewViewResolveContext` | **HARD** — WebviewViewProvider is a VS Code-specific concept. Must be replaced with a BrowserWindow or a webview in an Electron window |

### 2.2 — Built-in Tools (Layer 2)

| File | Import Style | VS Code APIs Used | Dependency Type |
|---|---|---|---|
| **`src/tools/builtin/readFile.ts`** | `import * as vscode from 'vscode'` | `vscode.workspace.fs.readFile`, `vscode.Uri.file`, `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` | **HARD** — File I/O via VS Code's FS API; replace with `fs.readFile` from Node.js |
| **`src/tools/builtin/writeFile.ts`** | `import * as vscode from 'vscode'` | `vscode.workspace.fs.stat`, `vscode.workspace.fs.readFile`, `vscode.Uri.file`, `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` | **HARD** — File I/O via VS Code's FS API; replace with Node.js `fs` |
| **`src/tools/builtin/editFile.ts`** | `import * as vscode from 'vscode'` | `vscode.Uri.file`, `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` | **HARD** — URI construction for pending-changes staging; replace with `path.resolve` + `file://` URI |
| **`src/tools/builtin/listDirectory.ts`** | `import * as vscode from 'vscode'` | `vscode.workspace.fs.readDirectory`, `vscode.FileType.Directory`, `vscode.FileType.SymbolicLink`, `vscode.Uri.file`, `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` | **HARD** — Directory listing via VS Code FS; replace with `fs.readdir` + `fs.stat` |
| **`src/tools/builtin/runCommand.ts`** | `import * as vscode from 'vscode'` | `vscode.window.showWarningMessage` (interpreter command confirmation dialog), `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` | **HARD** — Modal dialog for SEC-7 H4 interpreter approval + workspace root; replace with Electron dialog or IPC to renderer |
| **`src/tools/builtin/searchCode.ts`** | `import * as vscode from 'vscode'` | `vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` | **HARD** — Workspace root resolution; replace with direct config/env access |

### 2.3 — Core Services (Layer 2)

| File | Import Style | VS Code APIs Used | Dependency Type |
|---|---|---|---|
| **`src/diff/pendingChangesService.ts`** | `import * as vscode from 'vscode'` | `vscode.Disposable`, `vscode.EventEmitter`, `vscode.Uri` (param type, `.joinPath`, `.toString`), `vscode.workspace.fs.readFile`, `vscode.workspace.fs.writeFile`, `vscode.workspace.fs.stat`, `vscode.workspace.fs.createDirectory`, `vscode.workspace.fs.delete` | **HARD** — All disk I/O routed through VS Code FS; replace with Node.js `fs` module |
| **`src/agent/agentLoop.ts`** | `import * as vscode from 'vscode'` | `vscode.Disposable`, `vscode.EventEmitter<T>` | **HARD** — Uses `vscode.Disposable` and `vscode.EventEmitter` as base types; replace with own `Disposable` + `EventEmitter` implementations |
| **`src/agent/verification.ts`** | `import * as vscode from 'vscode'` | `vscode.workspace.workspaceFolders?.[0]`, `vscode.Uri.joinPath`, `vscode.workspace.fs.readFile`, `vscode.workspace.fs.stat` | **HARD** — Reads package.json/tsconfig.json via VS Code FS; replace with Node.js `fs` |
| **`src/llm/aiService.ts`** | `import * as vscode from 'vscode'` | `vscode.Disposable`, `vscode.EventEmitter`, `vscode.ExtensionContext`, `vscode.workspace.getConfiguration('kovix').get(...)` | **HARD** — Config + SecretStorage access; replace with own config store + keychain |
| **`src/llm/providers/anthropicProvider.ts`** | `import * as vscode from 'vscode'` | `vscode.Disposable`, `vscode.EventEmitter`, `vscode.SecretStorage` (param type), `vscode.workspace.getConfiguration('kovix').get(...)` | **HARD** — API key from SecretStorage + config from VS Code settings; replace with keytar/keychain + config file |
| **`src/memory/memoryService.ts`** | `import * as vscode from 'vscode'` | `vscode.workspace.getConfiguration('kovix.memory').get(...)` | **HARD** — Config read; replace with own config store |
| **`src/mcp/mcpManager.ts`** | `import * as vscode from 'vscode'` | `vscode.workspace.getConfiguration('kovix.mcp').get(...)` | **HARD** — Config read; replace with own config store |

### 2.4 — Infrastructure (Layer 1/4)

| File | Import Style | VS Code APIs Used | Dependency Type |
|---|---|---|---|
| **`src/util/logger.ts`** | `import * as vscode from 'vscode'` | `vscode.OutputChannel`, `vscode.window.createOutputChannel`, `vscode.workspace.getConfiguration('kovix').get(...)` | **HARD** — Output channel + config; replace with console/pino + config file |
| **`src/security/workspaceRoots.ts`** | `import * as vscode from 'vscode'` | `vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath)` | **HARD** — Workspace root resolution; replace with CLI arg / config / cwd |

### 2.5 — Type-Only References (Layer 1)

| File | Import Style | VS Code APIs Used | Dependency Type |
|---|---|---|---|
| **`src/types/llm.ts`** | `import type { Event } from 'vscode'` | `Event<T>` (type only) | **TYPE-ONLY** — Replace with own `Event<T>` interface |
| **`src/types/agent.ts`** | `import type { Event } from 'vscode'` | `Event<T>` (type only) | **TYPE-ONLY** — Replace with own `Event<T>` interface |
| **`src/diff/pendingChanges.ts`** | `import type { Event, Uri } from 'vscode'` | `Event<T>`, `Uri` (types only) | **TYPE-ONLY** — Replace with own `Event<T>` and `Uri` type definitions |

### 2.6 — Webview Client (Runs in VS Code Webview Context)

| File | Import Style | VS Code APIs Used | Dependency Type |
|---|---|---|---|
| **`src/ui/webview/agentPanel.js`** | `acquireVsCodeApi()` (implicit) | `vscode.postMessage(...)` (webview API) | **HARD** — VS Code webview messaging; replace with Electron `ipcRenderer.send` / `ipcRenderer.on` |

---

## 3. VS Code API Surface Summary

### APIs that must be abstracted or replaced:

| VS Code API | Used In | Replacement for Electron |
|---|---|---|
| `vscode.workspace.fs.readFile` | readFile, writeFile, pendingChangesService, verification | Node.js `fs.promises.readFile` |
| `vscode.workspace.fs.writeFile` | pendingChangesService | Node.js `fs.promises.writeFile` |
| `vscode.workspace.fs.stat` | writeFile, pendingChangesService, verification | Node.js `fs.promises.stat` |
| `vscode.workspace.fs.readDirectory` | listDirectory | Node.js `fs.promises.readdir` + `fs.promises.stat` |
| `vscode.workspace.fs.createDirectory` | pendingChangesService | Node.js `fs.promises.mkdir` |
| `vscode.workspace.fs.delete` | pendingChangesService | Node.js `fs.promises.rm` |
| `vscode.workspace.workspaceFolders` | extension, readFile, writeFile, editFile, listDirectory, searchCode, runCommand, verification, workspaceRoots | CLI argument / config / `process.cwd()` |
| `vscode.workspace.getConfiguration` | commands, logger, aiService, anthropicProvider, memoryService, mcpManager | Own config store (JSON file + watcher) |
| `vscode.Uri.file` / `vscode.Uri.joinPath` | readFile, writeFile, editFile, listDirectory, agentPanel, verification, pendingChanges | Node.js `path` module + `URL` / `file://` protocol |
| `vscode.ExtensionContext` | extension, commands, agentPanel, aiService | Own app context (Electron app lifecycle) |
| `vscode.SecretStorage` | commands, anthropicProvider | `keytar` / Electron `safeStorage` API |
| `vscode.commands.registerCommand` | commands | Electron IPC handlers / menu actions |
| `vscode.commands.executeCommand` | agentPanel | Electron IPC invoke |
| `vscode.window.showErrorMessage` | commands | Electron `dialog.showErrorBox` or renderer IPC |
| `vscode.window.showWarningMessage` | commands, runCommand | Electron `dialog.showMessageBox` or renderer IPC |
| `vscode.window.showInformationMessage` | commands | Renderer IPC (toast/notification) |
| `vscode.window.showInputBox` | commands | Renderer IPC (input dialog component) |
| `vscode.window.showQuickPick` | commands | Renderer IPC (dropdown component) |
| `vscode.window.withProgress` | commands | Renderer IPC (progress bar component) |
| `vscode.window.createOutputChannel` | commands, logger | `console` / pino / Electron log file |
| `vscode.window.registerWebviewViewProvider` | agentPanel | `BrowserWindow` / `webContents` |
| `vscode.window.onDidChangeActiveColorTheme` | agentPanel | Electron native theme detection |
| `vscode.window.showTextDocument` | commands, agentPanel | Open in Electron editor pane / external editor |
| `vscode.workspace.openTextDocument` | commands, agentPanel | `fs.readFile` + display in renderer |
| `vscode.ProgressLocation.Notification` | commands | Renderer progress component |
| `vscode.ConfigurationTarget.Global` | commands | Config file write |
| `vscode.FileType.Directory / .SymbolicLink` | listDirectory | `fs.stat` → `stats.isDirectory()` / `.isSymbolicLink()` |
| `vscode.Disposable` | agentLoop, aiService, anthropicProvider, pendingChangesService, agentPanel | Own `IDisposable` interface |
| `vscode.EventEmitter` | agentLoop, aiService, anthropicProvider, pendingChangesService, agentPanel | Own `EventEmitter<T>` class |
| `vscode.WebviewViewProvider` | agentPanel | Electron BrowserWindow / webContents |
| `vscode.WebviewView` | agentPanel | Electron `webContents` |
| `vscode.OutputChannel` | logger | Own logger (pino/winston) |
| `vscode.Event<T>` (type) | types/llm, types/agent, pendingChanges | Own `Event<T>` interface |
| `vscode.Uri` (type) | pendingChanges | Own `Uri` type or `URL` |
| Webview `acquireVsCodeApi()` | agentPanel.js | Electron `ipcRenderer` |

---

## 4. Pivot Complexity by File

### Green (Easy — type-only or minimal change):
- `src/types/llm.ts` — Replace `Event<T>` import
- `src/types/agent.ts` — Replace `Event<T>` import
- `src/diff/pendingChanges.ts` — Replace `Event<T>` and `Uri` type imports

### Yellow (Medium — swap API calls, logic stays):
- `src/tools/builtin/readFile.ts` — Swap `vscode.workspace.fs.readFile` → `fs.readFile`, `vscode.Uri` → `path`
- `src/tools/builtin/writeFile.ts` — Swap `vscode.workspace.fs.stat/readFile` → `fs.stat/readFile`
- `src/tools/builtin/editFile.ts` — Swap `vscode.Uri.file` → `path.resolve`
- `src/tools/builtin/listDirectory.ts` — Swap `vscode.workspace.fs.readDirectory` → `fs.readdir` + stat
- `src/tools/builtin/searchCode.ts` — Swap `vscode.workspace.workspaceFolders` → config
- `src/security/workspaceRoots.ts` — Swap `vscode.workspace.workspaceFolders` → config
- `src/memory/memoryService.ts` — Swap `vscode.workspace.getConfiguration` → config store
- `src/mcp/mcpManager.ts` — Swap `vscode.workspace.getConfiguration` → config store
- `src/util/logger.ts` — Swap `vscode.OutputChannel` → pino/console
- `src/agent/verification.ts` — Swap `vscode.workspace.fs` → Node `fs`
- `src/diff/pendingChangesService.ts` — Swap `vscode.workspace.fs` → Node `fs`, `vscode.EventEmitter` → own

### Red (Hard — full rewrite or major restructure):
- **`src/extension.ts`** — Entire file is VS Code activation. Replace with Electron `main.ts` + BrowserWindow bootstrap
- **`src/commands.ts`** — All 7 commands use VS Code window/dialog APIs. Replace with IPC handlers to renderer
- **`src/ui/agentPanel.ts`** — WebviewViewProvider is VS Code-specific. Replace with Electron BrowserWindow + IPC bridge
- **`src/ui/webview/agentPanel.js`** — Uses VS Code webview API. Replace with Electron `ipcRenderer`
- **`src/tools/builtin/runCommand.ts`** — Modal dialog via `vscode.window.showWarningMessage`. Replace with Electron IPC dialog
- **`src/agent/agentLoop.ts`** — `vscode.Disposable` + `vscode.EventEmitter` as base types. Need own implementations
- **`src/llm/aiService.ts`** — `vscode.ExtensionContext`, `SecretStorage`, config. Need own lifecycle + keychain
- **`src/llm/providers/anthropicProvider.ts`** — `SecretStorage` for API keys, config reads. Need keychain + config

---

## 5. Abstraction Strategy

### 5.1 Interfaces to Create (replace `vscode.*` types)

```typescript
// src/platform/types.ts (NEW)

/** Replaces vscode.Event<T> */
export interface Event<T> {
    (listener: (e: T) => any): IDisposable;
}

/** Replaces vscode.Disposable */
export interface IDisposable {
    dispose(): void;
}

/** Replaces vscode.Uri */
export interface Uri {
    readonly fsPath: string;
    readonly scheme: string;
    toString(): string;
}

/** Replaces vscode.EventEmitter<T> */
export class EventEmitter<T> {
    event: Event<T>;
    fire(data: T): void;
    dispose(): void;
}

/** Replaces vscode.CancellationToken / AbortSignal adapter */
export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    onCancellationRequested: Event<any>;
}

/** Replaces vscode.SecretStorage */
export interface ISecretStorage {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
    onDidChange: Event<{ key: string }>;
}

/** Replaces vscode.workspace.fs */
export interface IFileSystem {
    readFile(uri: Uri): Promise<Uint8Array>;
    writeFile(uri: Uri, content: Uint8Array): Promise<void>;
    stat(uri: Uri): Promise<{ type: FileType; mtime: number; size: number }>;
    readDirectory(uri: Uri): Promise<[string, FileType][]>;
    createDirectory(uri: Uri): Promise<void>;
    delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;
}

/** Replaces vscode.workspace.getConfiguration */
export interface IConfiguration {
    get<T>(section: string, defaultValue?: T): T;
    update(section: string, value: any, scope?: 'global' | 'workspace'): Promise<void>;
    onDidChange: Event<{ key: string }>;
}

/** Replaces vscode.workspace.workspaceFolders */
export interface IWorkspace {
    readonly roots: readonly string[];
    onDidChangeRoots: Event<void>;
}
```

### 5.2 Platform Implementations

| Interface | VS Code Impl | Electron Impl |
|---|---|---|
| `IFileSystem` | `vscode.workspace.fs` | Node.js `fs.promises` + `path` |
| `IConfiguration` | `vscode.workspace.getConfiguration` | JSON config file + chokidar watcher |
| `ISecretStorage` | `vscode.SecretStorage` | `keytar` / Electron `safeStorage` |
| `IWorkspace` | `vscode.workspace.workspaceFolders` | CLI `--workspace` arg / `process.cwd()` |
| `IDialog` | `vscode.window.showXxxMessage` | Electron `dialog` + renderer IPC |
| `IOutputChannel` | `vscode.OutputChannel` | pino/winston logger |
| `ICommandRegistry` | `vscode.commands.registerCommand` | Electron IPC handlers |
| `IWebviewHost` | `vscode.WebviewViewProvider` | Electron `BrowserWindow` |

---

## 6. Files with NO VS Code Dependencies (Safe as-is)

These files do not import `vscode` and require no changes for the pivot:

- `src/types/tools.ts`
- `src/types/mcp.ts`
- `src/security/workspaceGuard.ts` (pure logic, accepts `IWorkspaceRootsProvider`)
- `src/security/promptSanitiser.ts`
- `src/security/secretPatterns.ts`
- `src/security/childEnv.ts`
- `src/terminal/commandBlocklist.ts`
- `src/terminal/terminalExecutor.ts` (uses `child_process.spawn`, no `vscode`)
- `src/memory/embeddingService.ts`
- `src/memory/vectorStore.ts`
- `src/memory/types.ts`
- `src/mcp/mcpClient.ts`
- `src/mcp/types.ts`
- `src/agent/promptSanitizer.ts`
- `src/agent/agentLoopHelpers.ts`
- All files under `src/tools/builtin/` except the 5 listed above
- `src/ui/webview/agentPanel.html`
- `src/ui/webview/agentPanel.css`

---

## 7. Statistics

| Metric | Count |
|---|---|
| Files importing `vscode` (hard dependency) | 18 |
| Files importing `vscode` (type-only) | 3 |
| Files using `vscode.postMessage` (webview) | 1 |
| Total files touching VS Code API | 22 |
| Distinct VS Code API surfaces used | 30+ |
| Files with NO VS Code dependency | ~15 |
| Package-level VS Code deps | 2 (`@types/vscode`, `@vscode/vsce`) |
