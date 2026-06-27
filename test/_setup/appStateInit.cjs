/**
 * appStateInit.cjs — Test setup file that initializes the app state
 * before tests run. Required by .mocharc.json.
 *
 * Creates a temporary directory for app state, calls initAppState(),
 * and sets workspace roots to process.cwd() (same as the old vscode shim).
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

// We need to set up the module resolution hook FIRST
// (the vscode-shim-register.cjs still runs and intercepts require('vscode'))
// Then we initialize the app state.

async function setup() {
  const tmpDir = path.join(os.tmpdir(), 'kovix-test-state-' + process.pid);

  // Ensure the directory exists
  fs.mkdirSync(tmpDir, { recursive: true });

  // We can't directly import TypeScript here, but we can set up the
  // environment variable that the platform modules will read.
  // The actual initAppState() call happens in test files that import
  // the TypeScript source via ts-node.

  // Set a global so that test files can find the temp dir.
  globalThis.__kovix_test_base_dir = tmpDir;
  globalThis.__kovix_test_workspace_root = process.cwd();

  // Patch the vscode shim's workspace folders to match our test root.
  // The vscode-shim-register.cjs has already loaded, so we patch the
  // already-loaded module.
  try {
    const vscodeShim = require('vscode');
    vscodeShim.workspace.workspaceFolders = [
      { uri: { fsPath: process.cwd() }, name: 'test', index: 0 },
    ];
  } catch {
    // Shim not loaded yet — that's fine, the default is process.cwd().
  }
}

setup().catch((err) => {
  console.error('[appStateInit] Setup failed:', err);
});
