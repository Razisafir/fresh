/**
 * prompts.ts — Platform prompts for the Electron standalone app.
 *
 * Replaces vscode.window.showInformationMessage / showWarningMessage /
 * showErrorMessage with logging-based equivalents. In the Electron app,
 * interactive prompts (like command approval) are handled via IPC to
 * the renderer process.
 *
 * The confirmCommand() function returns a Promise<boolean> that is
 * resolved by the IPC bridge when the user clicks Approve/Cancel in
 * the renderer.
 */

import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Prompt functions
// ---------------------------------------------------------------------------

/** Map of pending confirmation requests (command → resolve function). */
const _pendingConfirmations = new Map<string, (approved: boolean) => void>();

/**
 * Request user confirmation for a command.
 *
 * In the Electron app, this sends a prompt:confirmCommand IPC message
 * to the renderer and returns a Promise that resolves when the user
 * responds. The IPC bridge calls resolveCommandConfirmation() to
 * resolve the promise.
 *
 * @param command The command string to confirm.
 * @returns true if approved, false if rejected.
 */
export function confirmCommand(command: string): Promise<boolean> {
	return new Promise((resolve) => {
		_pendingConfirmations.set(command, resolve);
		// The IPC bridge will call resolveCommandConfirmation() when the user responds.
		// electron/main.ts listens for the renderer's response and calls us back.
		logger.info(`[Prompts] Awaiting confirmation for command: ${command}`);
	});
}

/**
 * Resolve a pending command confirmation. Called by electron/main.ts
 * when the renderer responds to the prompt.
 *
 * @param command The command that was confirmed/rejected.
 * @param approved Whether the user approved the command.
 */
export function resolveCommandConfirmation(command: string, approved: boolean): void {
	const resolve = _pendingConfirmations.get(command);
	if (resolve) {
		_pendingConfirmations.delete(command);
		resolve(approved);
	}
}

/**
 * Check if there is a pending confirmation for a command.
 * Used by the IPC bridge to know if a response is expected.
 */
export function hasPendingConfirmation(command: string): boolean {
	return _pendingConfirmations.has(command);
}

/**
 * Show an informational message. In the Electron app, this logs to the
 * output channel and sends an info event to the renderer.
 */
export function showInfo(message: string): void {
	logger.info(`[UI] ${message}`);
}

/**
 * Show a warning message.
 */
export function showWarning(message: string): void {
	logger.warn(`[UI] ${message}`);
}

/**
 * Show an error message.
 */
export function showError(message: string): void {
	logger.error(`[UI] ${message}`);
}
