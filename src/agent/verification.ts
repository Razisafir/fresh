/**
 * verification.ts — Layer 2: harness-controlled verification of agent work.
 *
 * Phase 0 pivot (D-015): replaced vscode imports with platform equivalents.
 *   - vscode.workspace.workspaceFolders → getAppState().workspaceRoots.roots
 *   - vscode.Uri.joinPath → platformFs.joinPath
 *   - vscode.workspace.fs.readFile → platformFs.readFileText
 *   - vscode.workspace.fs.stat → platformFs.exists
 */

import * as path from 'path';
import { logger } from '../util/logger';
import { terminalExecutor } from '../terminal/terminalExecutor';
import { parseCommandString } from '../terminal/terminalExecutor';
import * as platformFs from '../platform/fs';
import { getAppState } from '../platform/appState';

export interface IDetectedVerificationCommand {
	readonly command: string | null;
	readonly reason: string;
}

export interface IVerificationResult {
	readonly passed: boolean;
	readonly output: string;
	readonly unverified: boolean;
	readonly command: string | null;
}

export async function detectVerificationCommand(): Promise<IDetectedVerificationCommand> {
	const root = getAppState().workspaceRoots.roots[0];
	if (!root) {
		return { command: null, reason: 'no workspace folder open' };
	}

	// Try package.json scripts first.
	try {
		const pkgPath = path.join(root, 'package.json');
		const pkg = JSON.parse(await platformFs.readFileText(pkgPath)) as {
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
		// No package.json or invalid JSON — fall through.
	}

	// Fallback: tsc --noEmit if tsconfig.json exists.
	try {
		const tsconfigPath = path.join(root, 'tsconfig.json');
		const exists = await platformFs.exists(tsconfigPath);
		if (exists) {
			return {
				command: 'npx tsc --noEmit',
				reason: 'tsconfig.json present (no package.json scripts)',
			};
		}
	} catch {
		// No tsconfig either.
	}

	return {
		command: null,
		reason: 'no package.json scripts and no tsconfig.json — workspace has no automated check',
	};
}

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

	const { program, args } = parseCommandString(detected.command);

	const cwd = getAppState().workspaceRoots.roots[0];

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
