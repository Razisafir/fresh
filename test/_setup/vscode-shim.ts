/**
 * vscode-shim.ts — minimal mock of the 'vscode' module for unit/integration tests.
 *
 * The real `vscode` module is provided by the VS Code extension host at runtime.
 * Tests run in plain Node, so we provide a minimal mock with just the surface
 * area our code uses:
 *   - EventEmitter (with .event getter, .fire(), .dispose())
 *   - Disposable (with .dispose())
 *   - workspace.fs (basic read/write helpers — not used in tests that mock services)
 *   - commands.executeCommand (stub)
 *   - window.showInformationMessage / showWarningMessage / showErrorMessage (stubs)
 *   - SecretStorage (stub)
 *   - Uri / workspace.workspaceFolders (stubs)
 *
 * This file is loaded via the `require` hook in `vscode-shim-register.ts`,
 * which is required by `.mocharc.json` BEFORE any test files run.
 */

class EventEmitter<T = unknown> {
        private listeners: ((data: T) => void)[] = [];

        get event(): (listener: (data: T) => void) => { dispose: () => void } {
                return (listener: (data: T) => void) => {
                        this.listeners.push(listener);
                        return {
                                dispose: () => {
                                        const idx = this.listeners.indexOf(listener);
                                        if (idx >= 0) { this.listeners.splice(idx, 1); }
                                },
                        };
                };
        }

        fire(data: T): void {
                for (const listener of [...this.listeners]) {
                        try { listener(data); } catch (err) {
                                // Swallow — test environment, don't let one bad listener break others
                                console.error('[vscode-shim] EventEmitter listener threw:', err);
                        }
                }
        }

        dispose(): void {
                this.listeners = [];
        }
}

class Disposable {
        private fn: (() => void) | undefined;
        constructor(fn?: () => void) {
                this.fn = fn;
        }
        dispose(): void {
                if (this.fn) {
                        try { this.fn(); } catch { /* swallow */ }
                        this.fn = undefined;
                }
        }
}

const secretStore: Record<string, string | undefined> = {};

const vscodeMock = {
        EventEmitter,
        Disposable,
        workspace: {
                workspaceFolders: [{ uri: { fsPath: process.cwd() }, name: 'test', index: 0 }],
                fs: {
                        readFile: async (_uri: unknown): Promise<Uint8Array> => new Uint8Array(0),
                        writeFile: async (_uri: unknown, _content: Uint8Array): Promise<void> => { /* stub */ },
                        stat: async (_uri: unknown) => ({ size: 0, type: 0, mtime: 0, ctime: 0 }),
                },
                getConfiguration: (_section?: string) => ({
                        get: (key: string, defaultValue?: unknown) => defaultValue,
                        update: async (_key: string, _value: unknown) => { /* stub */ },
                }),
        },
        commands: {
                registerCommand: () => new Disposable(),
                executeCommand: async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined,
        },
        window: {
                showInformationMessage: async (_msg: string, ..._items: unknown[]): Promise<unknown> => undefined,
                showWarningMessage: async (_msg: string, ..._items: unknown[]): Promise<unknown> => undefined,
                showErrorMessage: async (_msg: string, ..._items: unknown[]): Promise<unknown> => undefined,
                createOutputChannel: () => ({
                        append: (_value: string) => { /* stub */ },
                        appendLine: (_value: string) => { /* stub */ },
                        show: () => { /* stub */ },
                        hide: () => { /* stub */ },
                        dispose: () => { /* stub */ },
                }),
                showInputBox: async () => undefined,
                showQuickPick: async () => undefined,
        },
        Uri: {
                file: (path: string) => ({ fsPath: path, scheme: 'file' }),
                parse: (uri: string) => ({ fsPath: uri, scheme: 'file' }),
        },
        secrets: {
                store: async (key: string, value: string) => { secretStore[key] = value; },
                get: async (key: string) => secretStore[key] ?? undefined,
                delete: async (key: string) => { delete secretStore[key]; },
        },
        ExtensionMode: {
                Production: 1,
                Development: 2,
                Test: 3,
        },
};

export = vscodeMock;
