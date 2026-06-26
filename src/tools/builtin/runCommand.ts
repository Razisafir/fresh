/**
 * runCommand.ts — Layer 2 built-in tool: run_command.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/tools/constructToolRegistryService.ts` (lines 246-271 run_terminal schema, 384-406 run_command schema, 1003-1110 impl)
 * Port strategy: PORT WITH TRANSLATION + REWRITE.
 *
 * 02_ARCHITECTURE.md §4.3 lists this as a v0.1 built-in tool.
 *
 * The old repo had TWO tool entries that both routed to the same impl:
 *   - `run_terminal` (with Kali WSL wrapping support)
 *   - `run_command` (alias for run_terminal with a simpler schema)
 *
 * Per 02_ARCHITECTURE.md §9 non-goals (no Kali integration in v1, per W2
 * + D-008), we DROP `run_terminal` entirely and keep only `run_command`.
 * The schema is the simpler one (command + cwd, no Kali profile, no
 * timeout — the executor caps at 5min).
 *
 * Translation notes:
 *   - `ITerminalExecutor.execute(actualCommand, workDir, timeout)` (old
 *     signature: takes a command STRING and spawns it via a shell) →
 *     `terminalExecutor.execute(program, args, options)` (new signature:
 *     takes a program + args array, spawns directly without a shell).
 *     The command string is split via `parseCommandString()` first.
 *   - The Kali WSL base64-encode-and-pipe-to-bash wrapping is DROPPED.
 *   - The interpreter-command confirmation dialog (SEC-7 H4 fix) is
 *     preserved. If the base command is in INTERPRETER_COMMANDS (node,
 *     python, npx, curl, wget, docker, ...), a modal dialog pops up
 *     asking the user to approve. If they decline, the tool returns a
 *     "User declined" error so the agent loop can re-plan.
 *   - VS Code's `IDialogService.confirm()` → `vscode.window.showWarningMessage()`
 *     with two buttons (Run once / Cancel).
 *
 * Security invariants preserved:
 *   - COMMAND_BLOCKLIST checked before spawn (defence-in-depth — the
 *     executor also checks).
 *   - SEC-7 H4 fix: interpreter commands always prompt for confirmation,
 *     even when restricted mode is off. (v0.1 has no restricted-mode
 *     toggle yet — every interpreter command prompts.)
 *   - SEC-9: env sanitisation applied at spawn time (inside the executor).
 *   - No shell: the command string is parsed client-side via
 *     `parseCommandString()` (quotes honoured, no shell expansion).
 *
 * Decisions referenced: D-001 (file-by-file audit), D-008 (security tools
 * dropped), D-011 (extension route), W2 (no Kali), SEC-3, SEC-7 H4 fix,
 * SEC-9.
 */

import * as vscode from 'vscode';
import type { ITool, ToolExecuteFn, IConstructToolRegistry } from '../../types/tools';
import {
        isBlockedCommand,
        isInterpreterCommand,
        sanitiseForAuditLog,
} from '../../terminal/commandBlocklist';
import {
        terminalExecutor,
        parseCommandString,
} from '../../terminal/terminalExecutor';
import { sanitise as sanitiseForLlm } from '../../security/promptSanitiser';
import { logger } from '../../util/logger';

const MAX_OUTPUT_LENGTH = 100_000;

/**
 * Tool definition for run_command.
 */
export const runCommandTool: ITool = {
        name: 'run_command',
        description: 'Execute a shell command and return the output. Use for installing dependencies, running builds, tests, etc. Commands are checked against a blocklist for safety. Commands that can execute arbitrary code (node, python, npx, curl, docker, ...) require interactive user approval before running.',
        inputSchema: {
                type: 'object',
                properties: {
                        command: {
                                type: 'string',
                                description: 'The shell command to execute. Quoted arguments are honoured; shell metacharacters like ; && || | $() are NOT expanded (the command is parsed and spawned directly, not via a shell).',
                        },
                        cwd: {
                                type: 'string',
                                description: 'Working directory for the command. Defaults to workspace root.',
                        },
                        timeout: {
                                type: 'number',
                                description: 'Timeout in seconds. Defaults to 30. Hard-capped at 300 (5 minutes).',
                                default: 30,
                        },
                },
                required: ['command'],
        },
        modifiesFiles: false,
        requiresNetwork: false,
        category: 'terminal',
};

/**
 * Execute function for run_command.
 */
export const executeRunCommand: ToolExecuteFn = async (input, signal) => {
        const command = input.command as string;
        if (!command) {
                return {
                        success: false,
                        output: 'Missing required parameter: command',
                        truncated: false,
                };
        }

        // Defence-in-depth: blocklist check.
        if (isBlockedCommand(command)) {
                return {
                        success: false,
                        output: `Command blocked for safety: "${command}". If this is a mistake, you can run it manually in the terminal.`,
                        truncated: false,
                };
        }

        // SEC-7 H4 fix: interpreter commands require interactive confirmation.
        if (isInterpreterCommand(command)) {
                const confirmed = await vscode.window.showWarningMessage(
                        'Approve command execution',
                        { modal: true, detail: `Command: ${command}\n\nThis command can execute arbitrary code through crafted arguments. Review carefully before approving.` },
                        'Run once',
                        'Cancel',
                );
                if (confirmed !== 'Run once') {
                        logger.info(`[run_command] User declined interpreter command: ${sanitiseForAuditLog(command)}`);
                        return {
                                success: false,
                                output: 'User declined to run this command. Re-plan without invoking an interpreter, or ask the user to run it manually.',
                                truncated: false,
                        };
                }
                logger.info(`[run_command] User approved interpreter command: ${sanitiseForAuditLog(command)}`);
        }

        // Parse the command string into program + args. This is the critical
        // security step — we spawn the program directly without a shell, so
        // no $() substitution, no | chaining, no && chaining. Quoted
        // substrings in the command are honoured.
        let program: string;
        let args: string[];
        try {
                const parsed = parseCommandString(command);
                program = parsed.program;
                args = parsed.args;
        } catch (err) {
                return {
                        success: false,
                        output: `Failed to parse command: ${err instanceof Error ? err.message : String(err)}`,
                        truncated: false,
                };
        }

        const cwd = input.cwd as string | undefined;
        const workDir = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        const timeoutSec = (input.timeout as number | undefined) ?? 30;
        const timeoutMs = Math.max(1, timeoutSec) * 1000;

        try {
                const result = await terminalExecutor.execute(program, args, {
                        cwd: workDir,
                        timeoutMs,
                        signal,
                });

                const output = (result.stdout ?? '') + (result.stderr ?? '');
                const truncated = output.length > MAX_OUTPUT_LENGTH;
                const rawOutput = truncated
                        ? output.substring(0, MAX_OUTPUT_LENGTH) + '\n... [truncated]'
                        : output;

                // SEC-6: Sanitise command output before it enters the LLM context.
                // Command output frequently contains secrets (env dumps, config
                // files printed to stdout, git remotes with embedded tokens, etc.)
                // and could contain injection attempts (file contents echoed via
                // `cat`). Wrap in delimiter + redact secrets + filter injection
                // prefixes before the agent loop prepends this to the next turn.
                const displayOutput = sanitiseForLlm(rawOutput);

                if (result.exitCode !== 0) {
                        return {
                                success: false,
                                output: displayOutput || `Command exited with code ${result.exitCode}`,
                                truncated,
                                metadata: { exitCode: result.exitCode },
                        };
                }

                return {
                        success: true,
                        output: displayOutput || '(no output)',
                        truncated,
                        metadata: { exitCode: result.exitCode },
                };
        } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                // Common case: program not found (ENOENT).
                if (msg.includes('ENOENT') || msg.includes('not found')) {
                        return {
                                success: false,
                                output: `Command not found: ${program}. Is it installed and on your PATH?`,
                                truncated: false,
                        };
                }
                return {
                        success: false,
                        output: `Failed to execute command: ${msg}`,
                        truncated: false,
                };
        }
};

/**
 * Register the run_command tool with the given registry.
 */
export function registerRunCommandTool(registry: IConstructToolRegistry): void {
        registry.registerTool(runCommandTool, executeRunCommand);
}
