/**
 * cogneeTools.ts — Register Cognee knowledge-graph tools into the ToolRegistry.
 *
 * Provides registerCogneeTools() and unregisterCogneeTools() for adding and
 * removing Cognee tools from the agent's tool registry. Tools are only
 * registered when the Cognee service is available.
 *
 * Each tool wraps a CogneeService method and provides proper ITool
 * definitions with input schemas for the agent loop.
 *
 * Tools registered:
 *   - cognee_remember  — Ingest data into the knowledge graph
 *   - cognee_cognify   — Process ingested data into structured knowledge
 *   - cognee_recall    — Retrieve from the knowledge graph + session cache
 *   - cognee_search    — Search with a specific strategy
 *   - cognee_forget    — Remove a dataset and its knowledge
 *   - cognee_improve   — Provide feedback to improve memory quality
 */

import type { IConstructToolRegistry, ITool, ToolExecuteFn, IToolResult } from '../types/tools';
import { getCogneeService } from './cogneeIntegration';
import { CogneeSearchType } from './cogneeTypes';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const COGNEE_TOOL_CATEGORY = 'mcp' as const;

const COGNEE_REMEMBER_TOOL: ITool = {
	name: 'cognee_remember',
	description:
		'Ingest data into the Cognee knowledge graph. Data is stored in the specified dataset ' +
		'and can later be processed with cognee_cognify to build structured knowledge. ' +
		'Falls back to simple memory storage if Cognee is unavailable.',
	inputSchema: {
		type: 'object',
		properties: {
			data: {
				type: 'string',
				description: 'The text data to ingest into the knowledge graph.',
			},
			dataset: {
				type: 'string',
				description: 'Target dataset name (default: "default").',
				default: 'default',
			},
		},
		required: ['data'],
	},
	modifiesFiles: false,
	requiresNetwork: false,
	category: COGNEE_TOOL_CATEGORY,
};

const COGNEE_COGNIFY_TOOL: ITool = {
	name: 'cognee_cognify',
	description:
		'Process ingested data into structured knowledge in the Cognee knowledge graph. ' +
		'This extracts entities, relationships, and insights from raw data that has been ' +
		'previously ingested via cognee_remember. This is a potentially long-running operation.',
	inputSchema: {
		type: 'object',
		properties: {
			dataset: {
				type: 'string',
				description: 'Dataset to cognify / process into the knowledge graph (default: "default").',
				default: 'default',
			},
		},
		required: [],
	},
	modifiesFiles: false,
	requiresNetwork: false,
	category: COGNEE_TOOL_CATEGORY,
};

const COGNEE_RECALL_TOOL: ITool = {
	name: 'cognee_recall',
	description:
		'Retrieve from the Cognee knowledge graph and session cache. Returns relevant ' +
		'knowledge based on the query, combining graph traversal with semantic similarity. ' +
		'Falls back to simple memory retrieval if Cognee is unavailable.',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'The search query to retrieve relevant knowledge.',
			},
			datasets: {
				type: 'array',
				description: 'Optional list of datasets to search (searches all if omitted).',
				items: {
					type: 'string',
					description: 'Dataset name.',
				},
			},
			top_k: {
				type: 'number',
				description: 'Maximum number of results to return (default: 5).',
				default: 5,
			},
		},
		required: ['query'],
	},
	modifiesFiles: false,
	requiresNetwork: false,
	category: COGNEE_TOOL_CATEGORY,
};

const COGNEE_SEARCH_TOOL: ITool = {
	name: 'cognee_search',
	description:
		'Search the Cognee knowledge graph with a specific strategy. ' +
		'GRAPH_COMPLETION: traverse graph + LLM answer. CHUNKS: return relevant text chunks. ' +
		'INSIGHTS: return extracted entities and relationships. SUMMARIES: return condensed knowledge.',
	inputSchema: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'The search query.',
			},
			search_type: {
				type: 'string',
				description:
					'Search strategy: GRAPH_COMPLETION (LLM-generated answer from graph), ' +
					'CHUNKS (relevant text chunks), INSIGHTS (entities and relationships), ' +
					'SUMMARIES (condensed knowledge).',
				enum: ['GRAPH_COMPLETION', 'CHUNKS', 'INSIGHTS', 'SUMMARIES'],
				default: 'CHUNKS',
			},
			datasets: {
				type: 'array',
				description: 'Optional list of datasets to search.',
				items: {
					type: 'string',
					description: 'Dataset name.',
				},
			},
		},
		required: ['query'],
	},
	modifiesFiles: false,
	requiresNetwork: false,
	category: COGNEE_TOOL_CATEGORY,
};

const COGNEE_FORGET_TOOL: ITool = {
	name: 'cognee_forget',
	description:
		'Delete a dataset and all its knowledge from the Cognee knowledge graph. ' +
		'This removes all ingested data, entities, and relationships for the specified dataset. ' +
		'This action is irreversible.',
	inputSchema: {
		type: 'object',
		properties: {
			dataset: {
				type: 'string',
				description: 'The dataset to delete from the knowledge graph.',
			},
		},
		required: ['dataset'],
	},
	modifiesFiles: false,
	requiresNetwork: false,
	category: COGNEE_TOOL_CATEGORY,
};

const COGNEE_IMPROVE_TOOL: ITool = {
	name: 'cognee_improve',
	description:
		'Provide feedback to improve Cognee memory quality. Use this when recall results ' +
		'are inaccurate or incomplete to help the system learn from corrections.',
	inputSchema: {
		type: 'object',
		properties: {
			feedback: {
				type: 'string',
				description: 'Free-text feedback on recall quality (e.g. "Result was irrelevant because...").',
			},
			session_id: {
				type: 'string',
				description: 'Optional session ID to scope the feedback to a specific conversation.',
			},
		},
		required: ['feedback'],
	},
	modifiesFiles: false,
	requiresNetwork: false,
	category: COGNEE_TOOL_CATEGORY,
};

// ---------------------------------------------------------------------------
// Tool execute functions
// ---------------------------------------------------------------------------

const COGNEE_TOOL_NAMES = [
	'cognee_remember',
	'cognee_cognify',
	'cognee_recall',
	'cognee_search',
	'cognee_forget',
	'cognee_improve',
] as const;

type CogneeToolName = typeof COGNEE_TOOL_NAMES[number];

const TOOL_MAP: Record<CogneeToolName, ITool> = {
	cognee_remember: COGNEE_REMEMBER_TOOL,
	cognee_cognify: COGNEE_COGNIFY_TOOL,
	cognee_recall: COGNEE_RECALL_TOOL,
	cognee_search: COGNEE_SEARCH_TOOL,
	cognee_forget: COGNEE_FORGET_TOOL,
	cognee_improve: COGNEE_IMPROVE_TOOL,
};

/**
 * Create the execute function for a Cognee tool.
 */
function createExecuteFn(toolName: CogneeToolName): ToolExecuteFn {
	return async (input: Record<string, unknown>, _signal?: AbortSignal): Promise<IToolResult> => {
		const startTime = Date.now();
		const svc = getCogneeService();

		try {
			let output: string;

			switch (toolName) {
				case 'cognee_remember': {
					const data = String(input.data ?? '');
					const dataset = String(input.dataset ?? 'default');
					await svc.remember(data, dataset);
					output = `Data ingested into Cognee dataset "${dataset}" (${data.length} characters).`;
					break;
				}

				case 'cognee_cognify': {
					const dataset = String(input.dataset ?? 'default');
					await svc.cognify(dataset);
					output = `Dataset "${dataset}" has been cognified — data processed into structured knowledge.`;
					break;
				}

				case 'cognee_recall': {
					const query = String(input.query ?? '');
					const datasets = Array.isArray(input.datasets) ? input.datasets as string[] : undefined;
					const topK = typeof input.top_k === 'number' ? input.top_k : 5;
					const results = await svc.recall(query, datasets, topK);
					if (results.length === 0) {
						output = 'No results found in Cognee knowledge graph.';
					} else {
						output = results
							.map((r, i) => {
								const score = r.score.toFixed(2);
								const ds = r.datasets.join(', ');
								return `[${i + 1}] (score: ${score}, datasets: ${ds})\n${r.content}`;
							})
							.join('\n\n---\n\n');
					}
					break;
				}

				case 'cognee_search': {
					const query = String(input.query ?? '');
					const searchTypeStr = String(input.search_type ?? 'CHUNKS');
					const datasets = Array.isArray(input.datasets) ? input.datasets as string[] : undefined;
					const searchType = parseSearchType(searchTypeStr);
					const results = await svc.search(query, searchType, datasets);
					if (results.length === 0) {
						output = `No results found in Cognee knowledge graph (search type: ${searchType}).`;
					} else {
						output = results
							.map((r, i) => {
								const score = r.score.toFixed(2);
								const ds = r.datasets.join(', ');
								return `[${i + 1}] (type: ${r.searchType}, score: ${score}, datasets: ${ds})\n${r.content}`;
							})
							.join('\n\n---\n\n');
					}
					break;
				}

				case 'cognee_forget': {
					const dataset = String(input.dataset ?? '');
					await svc.forget(dataset);
					output = `Dataset "${dataset}" and all its knowledge have been removed from the Cognee knowledge graph.`;
					break;
				}

				case 'cognee_improve': {
					const feedback = String(input.feedback ?? '');
					const sessionId = typeof input.session_id === 'string' ? input.session_id : undefined;
					await svc.improve(feedback, sessionId);
					output = 'Feedback submitted to improve Cognee memory quality.';
					break;
				}

				default: {
					output = `Unknown Cognee tool: ${toolName}`;
				}
			}

			const durationMs = Date.now() - startTime;
			return {
				success: true,
				output,
				truncated: false,
				metadata: { durationMs, tool: toolName },
			};
		} catch (err) {
			const durationMs = Date.now() - startTime;
			return {
				success: false,
				output: `Cognee tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
				truncated: false,
				metadata: { durationMs, tool: toolName },
			};
		}
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Tracked tool names that were registered, so unregisterCogneeTools()
 * knows what to remove.
 */
let registeredToolNames: string[] = [];

/**
 * Register all Cognee tools into the given tool registry.
 * Only registers if the Cognee service is available.
 *
 * @param registry The tool registry to register tools into.
 */
export function registerCogneeTools(registry: IConstructToolRegistry): void {
	const svc = getCogneeService();

	if (!svc.isAvailable()) {
		logger.info('[Cognee] Tools not registered — Cognee service is not available.');
		return;
	}

	// Unregister any previously registered Cognee tools to avoid duplicates.
	unregisterCogneeTools(registry);

	for (const toolName of COGNEE_TOOL_NAMES) {
		const tool = TOOL_MAP[toolName];
		const executeFn = createExecuteFn(toolName);
		registry.registerTool(tool, executeFn);
		registeredToolNames.push(toolName);
		logger.verbose(`[Cognee] Registered tool: ${toolName}`);
	}

	logger.info(`[Cognee] Registered ${registeredToolNames.length} tools.`);
}

/**
 * Unregister all Cognee tools from the given tool registry.
 *
 * @param registry The tool registry to unregister tools from.
 */
export function unregisterCogneeTools(registry: IConstructToolRegistry): void {
	for (const toolName of registeredToolNames) {
		try {
			registry.unregisterTool(toolName);
		} catch (err) {
			logger.verbose(`[Cognee] Failed to unregister tool ${toolName}: ${err}`);
		}
	}
	registeredToolNames = [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSearchType(value: string): CogneeSearchType {
	switch (value.toUpperCase()) {
		case 'GRAPH_COMPLETION':
			return CogneeSearchType.GRAPH_COMPLETION;
		case 'CHUNKS':
			return CogneeSearchType.CHUNKS;
		case 'INSIGHTS':
			return CogneeSearchType.INSIGHTS;
		case 'SUMMARIES':
			return CogneeSearchType.SUMMARIES;
		default:
			return CogneeSearchType.CHUNKS;
	}
}
