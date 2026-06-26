/**
 * verification.ts — Layer 2: harness-controlled verification of agent work.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/agent/agentLoop.ts`
 *   (detectVerificationCommand + runVerification methods, lines ~1680-1726
 *   and ~975-1015 of the old file).
 * Port strategy: PORT WITH TRANSLATION + EXTRACT. The old repo had this
 * logic inlined in the 1,946-line AgentLoopService; we extract it to its
 * own file for testability per 02_ARCHITECTURE.md §4.1.
 *
 * 02_ARCHITECTURE.md §4.1 lists verification.ts as a Layer 2 file.
 *
 * What this module does (preserved from old repo):
 *   - detectVerificationCommand(): inspects the workspace for package.json
 *     scripts (test → build → typecheck) or tsconfig.json, returns the
 *     best command to run as a verification check.
 *   - runVerification(): executes that command via the terminal executor,
 *     parses exit code + output, returns { passed, output, unverified }.
 *
 * Why this matters (the Verifying state in the state machine):
 *   The agent can claim "tests pass" all it wants — the harness re-runs
 *   the verification command independently and only advances the
 *   milestone if exit code is 0. This is the "Verify" in
 *   Plan→Approve→Execute→Verify. Without it, the agent can self-report
 *   its way past failures (the "Iron Law" violation in the old repo).
 *
 * Translation notes:
 *   - IFileService.readFile → vscode.workspace.fs.readFile (returns
 *     Uint8Array, decode via Buffer.toString()).
 *   - URI.file(path) → vscode.Uri.file(path).
 *   - IWorkspaceContextService.getWorkspace().folders[0] →
 *     vscode.workspace.workspaceFolders?.[0].
 *   - terminalExecutor.execute(program, args, options) signature is used
 *     directly (not the old repo's execute(command, cwd, timeoutMs) —
 *     we already ported terminalExecutor with the safer signature in
 *     Round 2B per SEC-7 C3 fix).
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension
 * route), SEC-7 C3 fix (no shell, parseCommandString + direct spawn).
 */

import * as vscode from 'vscode';
import { logger } from '../util/logger';
import { terminalExecutor } from '../terminal/terminalExecutor';
import { parseCommandString } from '../terminal/terminalExecutor';

/**
 * Result of detecting the verification command for a workspace.
 */
export interface IDetectedVerificationCommand {
        /** The command to run, or null if no verification command exists. */
        readonly command: string | null;
        /** Human-readable reason for the choice (for logging / UI display). */
        readonly reason: string;
}

/**
 * Result of running a verification check.
 */
export interface IVerificationResult {
        /** Whether the verification check passed (exit code 0). */
        readonly passed: boolean;
        /** Combined stdout + stderr + exit code line. */
        readonly output: string;
        /**
         * True if no verification command exists for the workspace.
         * Distinct from passed=false (which means a command ran and failed).
         * The UI surfaces unverified results with a warning-toned badge.
         */
        readonly unverified: boolean;
        /** The command that was run (or null if unverified). */
        readonly command: string | null;
}

/**
 * Detect the best verification command for the current workspace.
 *
 * Strategy (preserved from old repo):
 *   1. If package.json exists and has scripts.test (not the
 *      "No tests specified" placeholder), use `npm test`.
 *   2. Else if package.json has scripts.build, use `npm run build`.
 *   3. Else if package.json has scripts.typecheck, use `npm run typecheck`.
 *   4. Else if tsconfig.json exists, use `npx tsc --noEmit`.
 *   5. Else return { command: null, reason: 'no automated check' }.
 *
 * @returns The detected command + reason.
 */
export async function detectVerificationCommand(): Promise<IDetectedVerificationCommand> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
                return { command: null, reason: 'no workspace folder open' };
        }

        // Try package.json scripts first.
        try {
                const pkgUri = vscode.Uri.joinPath(folder.uri, 'package.json');
                const stat = await vscode.workspace.fs.readFile(pkgUri);
                const pkg = JSON.parse(Buffer.from(stat).toString('utf8')) as {
                        scripts?: Record<string, string>;
                };
                if (pkg.scripts?.test && !pkg.scripts.test.includes('No tests specified')) {
                        return { command: 'npm test', reason: 'package.json scripts.test' };
                }
                if (pkg.scripts?.build) {
                        return { command: 'npm run build', reason: 'package.json scripts.build' };
                }
                if (pkg.scripts?.typecheck) {
                        return { command: 'npm run typecheck', reason: 'package.json scripts.typecheck' };
                }
        } catch {
                // No package.json or invalid JSON — fall through to tsconfig check.
        }

        // Fallback: tsc --noEmit if tsconfig.json exists.
        try {
                const tsconfigUri = vscode.Uri.joinPath(folder.uri, 'tsconfig.json');
                await vscode.workspace.fs.stat(tsconfigUri);
                return {
                        command: 'npx tsc --noEmit',
                        reason: 'tsconfig.json present (no package.json scripts)',
                };
        } catch {
                // No tsconfig either.
        }

        return {
                command: null,
                reason: 'no package.json scripts and no tsconfig.json — workspace has no automated check',
        };
}

/**
 * Run the verification command for the current workspace.
 *
 * If no command exists (detectVerificationCommand returned null), returns
 * `{ passed: true, unverified: true }` — the milestone advances but the
 * UI surfaces a warning badge. This matches the old repo's "unverified"
 * semantics: not a failure, but not a clean pass either.
 *
 * If a command exists, runs it via the terminal executor (60s timeout,
 * SEC-9 env sanitisation, COMMAND_BLOCKLIST check). Returns
 * `{ passed: exitCode === 0, output }`.
 *
 * @param signal Optional AbortSignal for cancellation.
 * @returns The verification result.
 */
export async function runVerification(signal?: AbortSignal): Promise<IVerificationResult> {
        const detected = await detectVerificationCommand();

        if (!detected.command) {
                logger.info(`[Verification] No verification command available: ${detected.reason}`);
                return {
                        passed: true,
                        output: 'unverified:no-command — workspace has no automated check',
                        unverified: true,
                        command: null,
                };
        }

        logger.info(`[Verification] Running: ${detected.command} (reason: ${detected.reason})`);

        // Parse the command string into program + args (SEC-7 C3 fix: no shell).
        const { program, args } = parseCommandString(detected.command);

        const folder = vscode.workspace.workspaceFolders?.[0];
        const cwd = folder?.uri.fsPath;

        const result = await terminalExecutor.execute(program, args, {
                cwd,
                timeoutMs: 60_000,
                signal,
        });

        let output = '';
        if (result.stdout) {
                output += result.stdout;
        }
        if (result.stderr) {
                output += (output ? '\n' : '') + result.stderr;
        }
        output += `\nExit code: ${result.exitCode}`;

        const passed = result.exitCode === 0;
        logger.info(`[Verification] Result: ${passed ? 'PASS' : 'FAIL'} (exit ${result.exitCode})`);

        return {
                passed,
                output,
                unverified: false,
                command: detected.command,
        };
}
