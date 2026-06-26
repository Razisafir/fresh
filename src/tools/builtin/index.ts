/**
 * builtin/index.ts — barrel + registerBuiltinTools() for the 7 v0.1 tools.
 *
 * Each built-in tool lives in its own file under `src/tools/builtin/` and
 * exports:
 *   - `<toolName>Tool: ITool` — the tool definition (name, description, schema, ...)
 *   - `execute<ToolName>: ToolExecuteFn` — the execute function
 *   - `register<ToolName>Tool(registry: IConstructToolRegistry): void` —
 *     convenience wrapper for `registry.registerTool(def, fn)`
 *
 * The registry calls `registerBuiltinTools(this)` in its constructor. All
 * 7 tools are registered unconditionally — there's no opt-in/opt-out in
 * v0.1. (MCP tools will be registered dynamically in v1.0 when the MCP
 * stack lands, see `src/mcp/`.)
 *
 * 02_ARCHITECTURE.md §4.3 lists the v0.1 tool set: read_file, write_file,
 * list_directory, edit_file, run_command, search_code, web_fetch.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-008 (security tools
 * dropped), D-011 (extension route), 02_ARCHITECTURE.md §4.3.
 */

import type { IConstructToolRegistry } from '../../types/tools';
import { registerReadFileTool } from './readFile';
import { registerWriteFileTool } from './writeFile';
import { registerListDirectoryTool } from './listDirectory';
import { registerEditFileTool } from './editFile';
import { registerRunCommandTool } from './runCommand';
import { registerSearchCodeTool } from './searchCode';
import { registerWebFetchTool } from './webFetch';

/**
 * Register all 7 v0.1 built-in tools with the given registry.
 *
 * Called by `ToolRegistryService` constructor. Idempotent — calling twice
 * will overwrite the previous registration (with a warning log from the
 * registry).
 *
 * Order matters only for log readability — the registry uses a Map, so
 * lookup is O(1) regardless of registration order.
 */
export function registerBuiltinTools(registry: IConstructToolRegistry): void {
	// File tools (4) — most-used, register first.
	registerReadFileTool(registry);
	registerWriteFileTool(registry);
	registerListDirectoryTool(registry);
	registerEditFileTool(registry);

	// Terminal + search (2) — secondary.
	registerRunCommandTool(registry);
	registerSearchCodeTool(registry);

	// Network (1) — least-used, register last.
	registerWebFetchTool(registry);
}

// Re-export individual tool definitions + executors for unit tests.
export {
	readFileTool,
	executeReadFile,
} from './readFile';
export {
	writeFileTool,
	executeWriteFile,
} from './writeFile';
export {
	listDirectoryTool,
	executeListDirectory,
} from './listDirectory';
export {
	editFileTool,
	executeEditFile,
} from './editFile';
export {
	runCommandTool,
	executeRunCommand,
} from './runCommand';
export {
	searchCodeTool,
	executeSearchCode,
} from './searchCode';
export {
	webFetchTool,
	executeWebFetch,
} from './webFetch';
