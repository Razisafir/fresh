/**
 * runCommand.ts — Layer 2 built-in tool: run_command.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.window.showWarningMessage → prompts.confirmCommand() (IPC-based)
 *   - vscode.workspace.workspaceFolders → getAppState().workspaceRoots.roots
 *
 * SEC-7 H4 fix preserved: interpreter commands require interactive confirmation.
 * In the Electron app, this is handled via the IPC bridge to the renderer.
 */

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
import { confirmCommand } from '../../platform/prompts';
import { getAppState } from '../../platform/appState';

const MAX_OUTPUT_LENGTH = 100_000;

export const runCommandTool: ITool = {
	name: 'run_command',
	description: 'Execute a shell command and return the output. Use for installing dependencies, running builds, tests, etc. Commands are checked against a blocklist for safety. Commands that can execute arbitrary code require interactive user approval before running.',
	inputSchema: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: 'The shell command to execute.',
			},
			cwd: {
				type: 'string',
				description: 'Working directory for the command. Defaults to workspace root.',
			},
			timeout: {
				type: 'number',
				description: 'Timeout in seconds. Defaults to 30.',
				default: 30,
			},
		},
		required: ['command'],
	},
	modifiesFiles: false,
	requiresNetwork: false,
	category: 'terminal',
};

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
		const confirmed = await confirmCommand(command);
		if (!confirmed) {
			logger.info(`[run_command] User declined interpreter command: ${sanitiseForAuditLog(command)}`);
			return {
				success: false,
				output: 'User declined to run this command. Re-plan without invoking an interpreter, or ask the user to run it manually.',
				truncated: false,
			};
		}
		logger.info(`[run_command] User approved interpreter command: ${sanitiseForAuditLog(command)}`);
	}

	// Parse the command string into program + args.
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
	const workDir = cwd ?? getAppState().workspaceRoots.roots[0];

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

export function registerRunCommandTool(registry: IConstructToolRegistry): void {
	registry.registerTool(runCommandTool, executeRunCommand);
}
