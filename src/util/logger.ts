/**
 * logger.ts — single output channel wrapper for the Kovix extension.
 *
 * Per 02_ARCHITECTURE.md §5.1: every service routes through this module.
 * The output channel is created lazily on first use so it doesn't appear
 * in the OUTPUT panel until the extension actually logs something.
 *
 * Verbose mode is controlled by the `kovix.debug.verbose` setting.
 */

import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
	if (!_channel) {
		_channel = vscode.window.createOutputChannel('Kovix');
	}
	return _channel;
}

function ts(): string {
	return new Date().toISOString();
}

function isVerbose(): boolean {
	return vscode.workspace.getConfiguration('kovix').get<boolean>('debug.verbose', false);
}

export const logger = {
	info(message: string): void {
		channel().appendLine(`[${ts()}] [INFO] ${message}`);
	},
	warn(message: string): void {
		channel().appendLine(`[${ts()}] [WARN] ${message}`);
	},
	error(message: string): void {
		channel().appendLine(`[${ts()}] [ERROR] ${message}`);
		channel().show(true);
	},
	verbose(message: string): void {
		if (isVerbose()) {
			channel().appendLine(`[${ts()}] [DEBUG] ${message}`);
		}
	},
	dispose(): void {
		_channel?.dispose();
		_channel = undefined;
	},
};
