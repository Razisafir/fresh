/**
 * smoke-test.cjs — Headless Xvfb smoke test for the Kovix Electron app.
 *
 * Spawns Xvfb on :99, then spawns Electron with DISPLAY=:99.
 * Captures stdout/stderr for 12 seconds and looks for required markers.
 * Exit 0 if all required markers found and no forbidden markers.
 * Exit 1 if any required marker is missing or a forbidden marker is found.
 */

const { spawn } = require('child_process');
const path = require('path');

const TIMEOUT_MS = 12_000;

const REQUIRED_MARKERS = [
  /Kovix starting up \(Electron standalone/,
  /AnthropicProvider.*Initialized/,
  /ConstructAIService.*Initialized/,
  /ToolRegistry.*Initialized with 7 built-in tools/,
  /AgentLoop.*Service created/,
  /\[Main\] Renderer loaded/,
];

const FORBIDDEN_MARKERS = [
  /TypeError|ReferenceError/,
  /Cannot find module/,
  /getAppState\(\) called before initAppState/,
  /initAgentLoop.*already initialised/,
];

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const electronPath = path.join(rootDir, 'node_modules', '.bin', 'electron');
  const mainJs = path.join(rootDir, 'dist', 'electron-main.js');

  // Try to start Xvfb (Linux only)
  let xvfb = null;
  try {
    xvfb = spawn('Xvfb', [':99', '-screen', '0', '1024x768x24'], {
      stdio: 'ignore',
      detached: true,
    });
    // Give Xvfb a moment to start
    await new Promise(r => setTimeout(r, 500));
  } catch {
    console.log('[smoke] Xvfb not available — running without virtual display.');
  }

  const env = { ...process.env, DISPLAY: ':99' };

  const child = spawn(electronPath, [mainJs], {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (data) => { output.stdout += data.toString(); });
  child.stderr.on('data', (data) => { output.stderr += data.toString(); });

  // Wait for timeout or exit
  const _exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(null);
    }, TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  // Kill Xvfb if we started it
  if (xvfb) {
    try { process.kill(xvfb.pid); } catch { /* ignore */ }
  }

  const combined = output.stdout + output.stderr;

  console.log('[smoke] --- Output ---');
  console.log(combined.slice(0, 5000));
  console.log('[smoke] --- End ---');

  // Check required markers
  let failed = false;
  for (const marker of REQUIRED_MARKERS) {
    if (!marker.test(combined)) {
      console.error(`[smoke] FAIL: Required marker not found: ${marker}`);
      failed = true;
    } else {
      console.log(`[smoke] PASS: Found required marker: ${marker}`);
    }
  }

  // Check forbidden markers
  for (const marker of FORBIDDEN_MARKERS) {
    if (marker.test(combined)) {
      console.error(`[smoke] FAIL: Forbidden marker found: ${marker}`);
      failed = true;
    } else {
      console.log(`[smoke] PASS: No forbidden marker: ${marker}`);
    }
  }

  if (failed) {
    console.error('[smoke] FAILED — see above.');
    process.exit(1);
  } else {
    console.log('[smoke] PASSED — all markers OK.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[smoke] Fatal error:', err);
  process.exit(1);
});
