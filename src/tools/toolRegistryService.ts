/**
 * toolRegistryService.ts — Layer 2 concrete implementation of
 * IConstructToolRegistry.
 *
 * Phase 0 pivot (D-015): updated JSDoc to remove VS Code references.
 * No code changes needed — the registry doesn't depend on vscode.
 * The constructor calls registerBuiltinTools(this) exactly once.
 */

import { logger } from '../util/logger';
import type {
	IConstructToolRegistry,
	ITool,
	IToolResult,
	ToolExecuteFn,
} from '../types/tools';
import { registerBuiltinTools } from './builtin';

/**
 * Concrete implementation of IConstructToolRegistry.
 *
 * Singleton — constructed once during app initialization and
 * re-exported via `getToolRegistry()` accessor. Built-in tools are
 * registered at construction time.
 */
export class ToolRegistryService implements IConstructToolRegistry {

	private readonly _tools: Map<string, { definition: ITool; executeFn: ToolExecuteFn }> = new Map();

	constructor() {
		registerBuiltinTools(this);
		logger.info(`[ToolRegistry] Initialized with ${this._tools.size} built-in tools`);
	}

	listTools(): ITool[] {
		return Array.from(this._tools.values()).map(t => t.definition);
	}

	getTool(name: string): ITool | undefined {
		return this._tools.get(name)?.definition;
	}

	async execute(
		name: string,
		input: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<IToolResult> {
		const tool = this._tools.get(name);
		if (!tool) {
			return {
				success: false,
				output: `Unknown tool: ${name}`,
				truncated: false,
			};
		}

		if (tool.definition.requiresNetwork) {
			logger.verbose(`[ToolRegistry] Tool ${name} requires network — delegating SSRF check to tool impl`);
		}

		const startTime = Date.now();
		try {
			const result = await tool.executeFn(input, signal);
			result.metadata = {
				...result.metadata,
				durationMs: Date.now() - startTime,
			};
			return result;
		} catch (error) {
			return {
				success: false,
				output: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
				truncated: false,
				metadata: { durationMs: Date.now() - startTime },
			};
		}
	}

	registerTool(tool: ITool, executeFn: ToolExecuteFn): void {
		if (this._tools.has(tool.name)) {
			logger.warn(`[ToolRegistry] Tool already registered: ${tool.name}. Overwriting.`);
		}
		this._tools.set(tool.name, { definition: tool, executeFn });
		logger.verbose(`[ToolRegistry] Registered tool: ${tool.name}`);
	}

	unregisterTool(name: string): void {
		this._tools.delete(name);
		logger.verbose(`[ToolRegistry] Unregistered tool: ${name}`);
	}
}

// ---------------------------------------------------------------------------
// Singleton + accessor
// ---------------------------------------------------------------------------

let _instance: ToolRegistryService | undefined;

/**
 * Construct the singleton tool registry. Called once during app
 * initialization. Throws if called twice.
 */
export function initToolRegistry(): ToolRegistryService {
	if (_instance) {
		throw new Error('ToolRegistryService has already been initialised. Use getToolRegistry() instead.');
	}
	_instance = new ToolRegistryService();
	return _instance;
}

/**
 * Returns the singleton tool registry instance. Available after
 * `initToolRegistry()` has been called.
 */
export function getToolRegistry(): ToolRegistryService | undefined {
	return _instance;
}
