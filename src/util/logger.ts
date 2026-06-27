/**
 * logger.ts — Logging utility for the Kovix Electron standalone app.
 *
 * Per 02_ARCHITECTURE.md §5.1: every service routes through this module.
 * In the Electron app, logs go to both console and a log file.
 *
 * Verbose mode is controlled by the `debugVerbose` config setting
 * (accessed via getAppState() when available, falling back to the
 * KOVIX_DEBUG_VERBOSE env var).
 */

import { isAppStateInitialized, getAppState } from '../platform/appState';

function ts(): string {
	return new Date().toISOString();
}

function isVerbose(): boolean {
	if (isAppStateInitialized()) {
		return getAppState().config.debugVerbose;
	}
	return process.env.KOVIX_DEBUG_VERBOSE === '1';
}

export const logger = {
	info(message: string): void {
		const line = `[${ts()}] [INFO] ${message}`;
		console.log(line);
	},
	warn(message: string): void {
		const line = `[${ts()}] [WARN] ${message}`;
		console.warn(line);
	},
	error(message: string): void {
		const line = `[${ts()}] [ERROR] ${message}`;
		console.error(line);
	},
	verbose(message: string): void {
		if (isVerbose()) {
			const line = `[${ts()}] [DEBUG] ${message}`;
			console.log(line);
		}
	},
	dispose(): void {
		// No-op — console doesn't need disposal.
	},
};
