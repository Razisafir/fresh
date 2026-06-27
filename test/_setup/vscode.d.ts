/**
 * vscode.d.ts — Type declarations for the vscode shim used by tests.
 *
 * Tests import from 'vscode' but get the shim from test/_setup/vscode-shim.cjs
 * via the require hook. This declaration file provides the type surface
 * so tsc --noEmit doesn't complain about missing module declarations.
 */

declare module 'vscode' {
	export class EventEmitter<T> {
		get event(): (listener: (e: T) => any) => { dispose(): void };
		fire(data: T): void;
		dispose(): void;
	}

	export class Disposable {
		constructor(fn?: () => void);
		dispose(): void;
	}

	export interface Uri {
		readonly fsPath: string;
		readonly scheme: string;
		toString(): string;
	}

	export const Uri: {
		file(path: string): Uri;
		parse(uri: string): Uri;
		joinPath(base: Uri, ...segments: string[]): Uri;
	};

	export interface WorkspaceFolder {
		readonly uri: Uri;
		readonly name: string;
		readonly index: number;
	}

	export interface FileStat {
		readonly type: FileType;
		readonly size: number;
		readonly mtime: number;
		readonly ctime: number;
	}

	export enum FileType {
		Unknown = 0,
		File = 1,
		Directory = 2,
		SymbolicLink = 64,
	}

	export interface SecretStorage {
		get(key: string): Thenable<string | undefined>;
		store(key: string, value: string): Thenable<void>;
		delete(key: string): Thenable<void>;
	}

	export namespace workspace {
		const workspaceFolders: readonly WorkspaceFolder[] | undefined;
		const fs: {
			readFile(uri: Uri): Thenable<Uint8Array>;
			writeFile(uri: Uri, content: Uint8Array): Thenable<void>;
			stat(uri: Uri): Thenable<FileStat>;
			readDirectory(uri: Uri): Thenable<[string, FileType][]>;
			createDirectory(uri: Uri): Thenable<void>;
			delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Thenable<void>;
		};
		function getConfiguration(section?: string): {
			get<T>(key: string, defaultValue?: T): T;
			update(key: string, value: any, target?: any): Thenable<void>;
		};
		function openTextDocument(options?: any): Thenable<any>;
	}

	export namespace window {
		function showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
		function showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
		function showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
		function createOutputChannel(name: string): any;
		function showInputBox(options?: any): Thenable<string | undefined>;
		function showQuickPick(items: any[], options?: any): Thenable<any>;
		function showTextDocument(document: any, options?: any): Thenable<any>;
		function withProgress(options: any, task: any): Thenable<any>;
		function registerWebviewViewProvider(viewId: string, provider: any): Disposable;
		const onDidChangeActiveColorTheme: any;
	}

	export namespace commands {
		function registerCommand(command: string, callback: (...args: any[]) => any): Disposable;
		function executeCommand(command: string, ...args: any[]): Thenable<any>;
	}

	export const secrets: SecretStorage;

	export enum ExtensionMode {
		Production = 1,
		Development = 2,
		Test = 3,
	}

	export type Event<T> = (listener: (e: T) => any) => { dispose(): void };
}
