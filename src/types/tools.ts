/**
 * tools.ts — Layer 1 type definitions for the tool execution layer.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/tools/constructToolRegistry.ts` (158L)
 * Port strategy: VERBATIM (interface + types only). The old file also exported
 * `IConstructToolRegistry` (the registry interface) and a back-compat re-export
 * of `assertWithinWorkspace`. We keep the registry interface here (Layer 1) —
 * the concrete implementation lives in `src/tools/toolRegistryService.ts`
 * (Layer 2, ported in a later Phase 3 round).
 *
 * 02_ARCHITECTURE.md §4.3 lists this as a Layer 1 port-verbatim file.
 *
 * Translation notes:
 *   - `createDecorator<IConstructToolRegistry>(...)` removed (no DI container).
 *   - `_serviceBrand: undefined` field removed from interface (VS Code DI marker).
 *   - Back-compat re-export of `assertWithinWorkspace` is DROPPED — call sites
 *     in fresh import directly from `src/security/workspaceGuard.ts`.
 *   - Kali WSL detection methods (`isKaliWSLAvailable`, `getTerminalProfile`,
 *     `setTerminalProfile`) are DROPPED per 02_ARCHITECTURE.md §9 non-goals
 *     (no Kali integration in v1, per W2). The Kali-specific tooling in the
 *     old repo was scoped to security tools which are themselves dropped (D-008).
 *   - The `IToolDefinition` type is renamed `ITool` here to disambiguate from
 *     the LLM-facing `IToolDefinition` in `src/types/llm.ts`. The two shapes
 *     are different: `ITool` is the registry-side definition (richer), and
 *     `IToolDefinition` is the minimal LLM-facing schema. The agent loop
 *     translates `ITool` → `IToolDefinition` when building LLM requests.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-008 (security tools
 * dropped), D-011 (extension route).
 */

// ---------------------------------------------------------------------------
// Tool parameter schema (from constructToolRegistry.ts)
// ---------------------------------------------------------------------------

/**
 * Schema definition for a tool's input parameters.
 * Uses a simplified JSON Schema format compatible with zod validation.
 */
export interface IToolParameterSchema {
	type: 'string' | 'number' | 'boolean' | 'object' | 'array';
	description: string;
	properties?: Record<string, IToolParameterSchema>;
	items?: IToolParameterSchema;
	required?: string[];
	enum?: string[];
	default?: unknown;
}

// ---------------------------------------------------------------------------
// Tool definition (renamed from IToolDefinition in old repo)
// ---------------------------------------------------------------------------

/**
 * Definition of a tool that can be executed by the agent.
 * Each tool has a name, description, input schema, and an execute function
 * (registered separately via `IConstructToolRegistry.registerTool`).
 *
 * This is the RICHER, registry-side tool definition. The LLM-facing
 * minimal definition lives in `src/types/llm.ts` as `IToolDefinition`.
 * The agent loop translates ITool → IToolDefinition when building LLM
 * requests.
 *
 * The `category` field uses a union that includes `'security'` and
 * `'design'` for backwards compatibility with old-repo tool definitions,
 * but per D-008 no v1 tool will use the `'security'` category. The union
 * is preserved so the type doesn't drift if a v1.1+ tool ever needs it.
 */
export interface ITool {
	/** Unique name for this tool (e.g., 'read_file', 'run_command'). */
	name: string;
	/** Human-readable description of what the tool does. */
	description: string;
	/** JSON Schema for the tool's input parameters. */
	inputSchema: {
		type: 'object';
		properties: Record<string, IToolParameterSchema>;
		required?: string[];
	};
	/** Whether this tool modifies files (requires user approval in some autonomy modes). */
	modifiesFiles: boolean;
	/** Whether this tool requires network access. */
	requiresNetwork: boolean;
	/** Category for UI grouping. */
	category: 'file' | 'terminal' | 'search' | 'network' | 'system' | 'security' | 'design' | 'behavior' | 'mcp';
}

// ---------------------------------------------------------------------------
// Tool result (from constructToolRegistry.ts)
// ---------------------------------------------------------------------------

/**
 * Result of executing a tool.
 */
export interface IToolResult {
	/** Whether the execution was successful. */
	success: boolean;
	/** The output text (or error message if not successful). */
	output: string;
	/** Whether the output is truncated due to size limits. */
	truncated: boolean;
	/** Additional metadata about the execution. */
	metadata?: {
		/** Duration of execution in milliseconds. */
		durationMs?: number;
		/** Number of bytes read/written. */
		bytesProcessed?: number;
		/** Exit code for terminal commands. */
		exitCode?: number;
		/** Name of the tool that was executed (for MCP/agent-reach tools). */
		tool?: string;
		/** Whether the underlying MCP server was configured at execution time. */
		configured?: boolean;
		/** Mode the tool was run in (e.g. ponytail 'strict' | 'minimal' | 'review', 'git', 'file', 'kali'). */
		mode?: string;
		/** Severity level for findings (e.g. 'critical', 'high', 'low'). */
		severity?: string;
	};
}

// ---------------------------------------------------------------------------
// Tool execute function type (new in fresh, was inline in old repo)
// ---------------------------------------------------------------------------

/**
 * Function that executes a single tool call.
 *
 * Extracted from the old repo's `IConstructToolRegistry.registerTool`
 * signature so the type can be referenced from `src/tools/builtin/*.ts`
 * without referencing the registry interface.
 *
 * @param input Tool input parameters (validated against ITool.inputSchema).
 * @param signal Optional AbortSignal for cancellation.
 * @returns The execution result.
 */
export type ToolExecuteFn = (
	input: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<IToolResult>;

// ---------------------------------------------------------------------------
// IConstructToolRegistry interface (from constructToolRegistry.ts)
// ---------------------------------------------------------------------------

/**
 * IConstructToolRegistry — registry and executor for agent tools.
 *
 * Manages the lifecycle of tools available to the agent, including:
 * - Built-in tools (read_file, write_file, run_command, search_codebase,
 *   web_fetch, edit_file, list_directory) — 7 tools per v0.1 spec.
 * - MCP tools (dynamically loaded from MCP servers, dispatched as
 *   `serverName__toolName`).
 *
 * All tool execution goes through this registry, ensuring:
 * - File-modifying tools respect the configured autonomy mode.
 * - Terminal commands are checked against a blocklist.
 * - Network access is gated by the SSRF guard (`urlGuard.ts`).
 * - Tool results are properly formatted for the agent.
 *
 * The concrete implementation lives in `src/tools/toolRegistryService.ts`
 * (Layer 2, ported in a later Phase 3 round).
 */
export interface IConstructToolRegistry {
	/**
	 * List all registered tools.
	 */
	listTools(): ITool[];

	/**
	 * Get a tool definition by name.
	 */
	getTool(name: string): ITool | undefined;

	/**
	 * Execute a tool by name.
	 *
	 * IMPORTANT: If the tool modifies files, the implementation MUST route
	 * through the pending-changes service (`src/diff/pendingChangesService.ts`)
	 * so the user can review the diff before it lands on disk. The agent loop
	 * must never auto-apply file changes silently.
	 *
	 * @param name Tool name.
	 * @param input Tool input parameters.
	 * @param signal Optional AbortSignal for cancellation.
	 * @returns The execution result.
	 */
	execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult>;

	/**
	 * Register a new tool.
	 *
	 * @param tool The tool definition.
	 * @param executeFn The function to execute when the tool is called.
	 */
	registerTool(tool: ITool, executeFn: ToolExecuteFn): void;

	/**
	 * Unregister a tool by name.
	 */
	unregisterTool(name: string): void;
}
