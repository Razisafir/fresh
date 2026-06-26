/**
 * vscode-shim-register.cjs — Module resolution hook for the `vscode` mock.
 *
 * Hooks `Module._resolveFilename` so that any `require('vscode')` or
 * `import * as vscode from 'vscode'` resolves to ./vscode-shim.cjs
 * instead of searching node_modules. This means:
 *   - No need for a manually-created node_modules/vscode/ directory
 *   - Survives `npm install` / `npm ci` (which would prune such a dir)
 *   - Works on any developer's machine without setup
 *
 * Required by .mocharc.json BEFORE ts-node/register, so that test files
 * (which `import * as vscode from 'vscode'`) can resolve the mock even
 * when they're compiled by ts-node on the fly.
 *
 * The hook is installed once and stays for the lifetime of the process.
 * It only intercepts the literal module name 'vscode' — relative paths
 * and other modules are unaffected.
 */

const Module = require('module');
const path = require('path');
const shimPath = path.join(__dirname, 'vscode-shim.cjs');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') {
    return shimPath;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

// Load the shim once to make absolutely sure it's valid JS.
require(shimPath);
