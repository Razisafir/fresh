/**
 * uris.ts — Minimal URI type for the Electron standalone app.
 *
 * Replaces vscode.Uri with a simple object that has an `fsPath` property.
 * This is all the codebase actually uses — `vscode.Uri.file(path).fsPath`.
 *
 * The `toString()` method returns the fsPath, which is sufficient for
 * Map keys and comparisons.
 */

import * as path from 'path';

export interface SimpleUri {
	readonly fsPath: string;
	readonly scheme: string;
	toString(): string;
}

class UriImpl implements SimpleUri {
	constructor(public readonly fsPath: string, public readonly scheme: string = 'file') {}

	toString(): string {
		return this.fsPath;
	}
}

export const Uri = {
	file(filePath: string): SimpleUri {
		return new UriImpl(filePath, 'file');
	},
	parse(uri: string): SimpleUri {
		return new UriImpl(uri, 'file');
	},
	joinPath(base: SimpleUri, ...segments: string[]): SimpleUri {
		return new UriImpl(path.join(base.fsPath, ...segments), base.scheme);
	},
};
