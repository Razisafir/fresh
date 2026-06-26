/**
 * workspaceGuard.ts — Layer 1 pure-logic: SEC-4 path traversal defence.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/security/workspaceGuard.ts` (88L)
 * Port strategy: PORT WITH TRANSLATION. Pure logic, but the old repo imported
 * VS Code's internal `IWorkspaceContextService` and the browser-safe `path`
 * utility. We replace both:
 *   - `IWorkspaceContextService` → simple `IWorkspaceRootsProvider` interface
 *     that returns readonly string[] of workspace folder paths. The real
 *     implementation in `src/services.ts` (Layer 4) will adapt `vscode.workspace.workspaceFolders`.
 *   - VS Code's browser-safe `path` → Node's stock `path` module. In the
 *     extension host (Node 18+) this is always available; the old repo's
 *     custom path utility existed only because VS Code's renderer process
 *     cannot use Node's path module directly.
 *
 * 02_ARCHITECTURE.md §4.6 lists this as a Layer 1 port-verbatim file (the
 * translation is mechanical — same logic, different import sources).
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route).
 */

import * as path from 'path';

/**
 * Minimal interface for obtaining workspace folder paths.
 *
 * This replaces the old repo's `IWorkspaceContextService` import. The
 * concrete implementation (Layer 4, in `src/services.ts`) wraps
 * `vscode.workspace.workspaceFolders` and exposes just the folder paths
 * as readonly strings. Layer 1 doesn't depend on `vscode` so we declare
 * the shape we need here.
 */
export interface IWorkspaceRootsProvider {
        /** Returns the absolute fs paths of all open workspace folders. */
        getWorkspaceRoots(): readonly string[];
}

/**
 * Assert that a path is within the workspace boundary.
 * Throws an error if the resolved absolute path escapes the workspace root.
 * Used for IPC input validation to prevent path traversal attacks.
 *
 * FIX (preserved from old repo): Previous implementation only checked for
 * '..' in the path string, which allowed absolute paths like /etc/passwd
 * to pass through. Now properly resolves and compares against workspace root.
 *
 * @param filePath The path to validate (absolute or relative to workspace root).
 * @param workspaceRoot Either:
 *   - a string (single workspace root), or
 *   - an `IWorkspaceRootsProvider` (multi-root workspace), or
 *   - undefined (no workspace context — only relative paths allowed).
 * @throws Error if the path escapes the workspace, traverses with '..', or
 *   is absolute when no workspace root is provided.
 */
export function assertWithinWorkspace(
        filePath: string,
        workspaceRoot?: string | IWorkspaceRootsProvider,
): void {
        // Reject path traversal attempts (e.g., ../../../etc/passwd)
        const normalized = path.normalize(filePath);
        if (normalized.includes('..')) {
                throw new Error(`Path traversal not allowed: "${filePath}"`);
        }

        // If a workspace root is provided, enforce boundary
        if (workspaceRoot) {
                let roots: string[];
                if (typeof workspaceRoot === 'string') {
                        roots = [path.resolve(workspaceRoot)];
                } else {
                        // IWorkspaceRootsProvider — get all workspace folder paths
                        const folderPaths = workspaceRoot.getWorkspaceRoots();
                        if (folderPaths.length === 0) {
                                // No workspace open — only allow relative paths
                                if (path.isAbsolute(filePath)) {
                                        throw new Error(`No workspace open. Absolute paths are not allowed: "${filePath}"`);
                                }
                                return;
                        }
                        roots = folderPaths.map(p => path.resolve(p));
                }

                // Single-root fast path (preserved from old repo)
                if (roots.length === 1) {
                        const root = roots[0];
                        // Resolve relative paths against the workspace root (not CWD)
                        const resolved = path.isAbsolute(filePath)
                                ? path.resolve(filePath)
                                : path.resolve(root, filePath);
                        if (!resolved.startsWith(root + path.sep) && resolved !== root) {
                                throw new Error(`Security: path "${resolved}" is outside workspace "${root}"`);
                        }
                        return;
                }

                // Multi-root: path is valid if it's inside ANY of the workspace roots.
                // This is a behavior expansion vs the old repo (which only checked
                // the first folder), but the old repo's `getWorkspace().folders[0]`
                // was itself a latent bug — a multi-root workspace would have
                // rejected valid paths in the second root. Documented in the audit
                // entry; no D-XXX needed because this is a bug fix bundled with
                // the port.
                for (const root of roots) {
                        const resolved = path.isAbsolute(filePath)
                                ? path.resolve(filePath)
                                : path.resolve(root, filePath);
                        if (resolved === root || resolved.startsWith(root + path.sep)) {
                                return;
                        }
                }
                throw new Error(`Security: path "${filePath}" is outside all workspace roots [${roots.join(', ')}]`);
        } else {
                // No workspace root provided — reject absolute paths as a safety measure
                if (path.isAbsolute(filePath)) {
                        throw new Error(`Absolute paths require a workspace context: "${filePath}"`);
                }
        }
}

/**
 * Validate that a tool name is in the allowed set.
 * Used for IPC input validation to prevent arbitrary tool execution.
 *
 * Round 2C test-audit fix: the old list referenced dropped tool names
 * (`create_directory`, `search_files`, `search_codebase`, `web_search`).
 * Updated to match the v0.1 built-in tool set per 02_ARCHITECTURE.md §4.3.
 */
export function validateToolName(name: string): boolean {
        const ALLOWED_TOOLS = new Set([
                // v0.1 built-in tools (per 02_ARCHITECTURE.md §4.3)
                'read_file', 'write_file', 'edit_file', 'list_directory',
                'run_command', 'search_code', 'web_fetch',
        ]);
        return ALLOWED_TOOLS.has(name);
}

/**
 * Validate that an MCP method name is in the allowed set.
 */
export function validateMcpMethod(method: string): boolean {
        const ALLOWED_METHODS = new Set([
                'initialize', 'tools/list', 'tools/call',
                'resources/list', 'resources/read',
        ]);
        return ALLOWED_METHODS.has(method);
}
