/**
 * vscode-shim.cjs — minimal mock of the 'vscode' module for unit/integration tests.
 *
 * Plain JS (no TypeScript) so it can be required by .mocharc.json BEFORE
 * ts-node/register is loaded. This is the compiled hand-equivalent of
 * test/_setup/vscode-shim.ts. The two files MUST stay in sync — if you
 * add a stub to the .ts version, mirror it here.
 *
 * The real `vscode` module is provided by the VS Code extension host at
 * runtime. Tests run in plain Node, so we provide a minimal mock with
 * just the surface area our code uses:
 *   - EventEmitter (with .event getter, .fire(), .dispose())
 *   - Disposable (with .dispose())
 *   - workspace.fs (basic read/write helpers — not used in tests that mock services)
 *   - commands.executeCommand (stub)
 *   - window.showInformationMessage / showWarningMessage / showErrorMessage (stubs)
 *   - SecretStorage (stub)
 *   - Uri / workspace.workspaceFolders (stubs)
 *
 * Loaded via the require hook in vscode-shim-register.cjs, which is
 * required by .mocharc.json BEFORE any test files run.
 */

class EventEmitter {
  constructor() {
    this.listeners = [];
  }
  get event() {
    return (listener) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          const idx = this.listeners.indexOf(listener);
          if (idx >= 0) { this.listeners.splice(idx, 1); }
        },
      };
    };
  }
  fire(data) {
    for (const listener of [...this.listeners]) {
      try { listener(data); } catch (err) {
        // Swallow — test environment, don't let one bad listener break others
        console.error('[vscode-shim] EventEmitter listener threw:', err);
      }
    }
  }
  dispose() {
    this.listeners = [];
  }
}

class Disposable {
  constructor(fn) {
    this.fn = fn;
  }
  dispose() {
    if (this.fn) {
      try { this.fn(); } catch { /* swallow */ }
      this.fn = undefined;
    }
  }
}

const secretStore = {};

const vscodeMock = {
  EventEmitter,
  Disposable,
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() }, name: 'test', index: 0 }],
    fs: {
      readFile: async (_uri) => new Uint8Array(0),
      writeFile: async (_uri, _content) => { /* stub */ },
      stat: async (_uri) => ({ size: 0, type: 0, mtime: 0, ctime: 0 }),
      readDirectory: async (_uri) => [],
      createDirectory: async (_uri) => { /* stub */ },
      delete: async (_uri, _opts) => { /* stub */ },
    },
    getConfiguration: (_section) => ({
      get: (_key, defaultValue) => defaultValue,
      update: async (_key, _value) => { /* stub */ },
    }),
    openTextDocument: async () => undefined,
  },
  commands: {
    registerCommand: () => new Disposable(),
    executeCommand: async (_command, ..._args) => undefined,
  },
  window: {
    showInformationMessage: async (_msg, ..._items) => undefined,
    showWarningMessage: async (_msg, ..._items) => undefined,
    showErrorMessage: async (_msg, ..._items) => undefined,
    createOutputChannel: () => ({
      append: (_value) => { /* stub */ },
      appendLine: (_value) => { /* stub */ },
      show: () => { /* stub */ },
      hide: () => { /* stub */ },
      dispose: () => { /* stub */ },
    }),
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    registerWebviewViewProvider: () => new Disposable(),
    onDidChangeActiveColorTheme: () => new Disposable(),
    showTextDocument: async () => undefined,
    withProgress: async (_options, task) => task({ report: () => { /* stub */ } }),
  },
  Uri: {
    file: (path) => ({ fsPath: path, scheme: 'file', authority: '', path: '/' + path, query: '', fragment: '' }),
    parse: (uri) => ({ fsPath: uri, scheme: 'file', authority: '', path: uri, query: '', fragment: '' }),
    joinPath: (base, ...segments) => {
      const path = require('path');
      const joined = path.join(base.fsPath ?? base.path ?? '', ...segments);
      return { fsPath: joined, scheme: base.scheme ?? 'file', authority: '', path: joined, query: '', fragment: '' };
    },
  },
  secrets: {
    store: async (key, value) => { secretStore[key] = value; },
    get: async (key) => secretStore[key] ?? undefined,
    delete: async (key) => { delete secretStore[key]; },
  },
  ExtensionMode: {
    Production: 1,
    Development: 2,
    Test: 3,
  },
};

module.exports = vscodeMock;
