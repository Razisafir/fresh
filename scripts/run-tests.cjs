#!/usr/bin/env node
/**
 * run-tests.cjs — version-aware mocha wrapper.
 *
 * WHY THIS EXISTS:
 *   Node 22.6+ ships a native TypeScript "strip-only" mode that preempts
 *   ts-node/register for .ts files. On Node 24 this mode is on by default
 *   and breaks our test suite (parameter properties →
 *   ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). The fix is
 *   `NODE_OPTIONS=--no-experimental-strip-types`.
 *
 *   BUT: Node < 22.6 doesn't know that flag at all and rejects it with
 *   exit code 9 ("--no-experimental-strip-types is not allowed in
 *   NODE_OPTIONS"). So the flag can't be hardcoded into the npm script.
 *
 *   This wrapper detects the running Node version and only sets the flag
 *   when it's both (a) needed and (b) accepted — i.e. Node >= 22.6.
 *   On older Node, ts-node works fine without any flag.
 *
 * USAGE:
 *   node scripts/run-tests.cjs [-- mocha args...]
 *   node scripts/run-tests.cjs 'test/unit/...test.ts'
 *
 *   Everything after the script name is forwarded to mocha as-is.
 */

const { spawnSync } = require('child_process');

const [major, minor] = process.versions.node.split('.').map(Number);
const supportsFlag = (major > 22) || (major === 22 && minor >= 6);

// Forward any extra args (test path filters, mocha flags, etc.)
const mochaArgs = process.argv.slice(2);

const env = { ...process.env };
if (supportsFlag) {
  // Append to any pre-existing NODE_OPTIONS rather than clobbering it.
  env.NODE_OPTIONS = [env.NODE_OPTIONS, '--no-experimental-strip-types']
    .filter(Boolean)
    .join(' ');
}

// Use tsconfig.test.json for ts-node so the vscode shim type declarations resolve.
env.TS_NODE_PROJECT = 'tsconfig.test.json';

// Use shell:true so `mocha` resolves via PATH on all platforms
// (Windows doesn't find bare binaries without the .cmd extension).
const result = spawnSync('mocha', ['--config', '.mocharc.json', ...mochaArgs], {
  env,
  stdio: 'inherit',
  shell: true,
});

// Propagate mocha's exit status. On signal termination, exit 1.
process.exit(result.status ?? 1);
