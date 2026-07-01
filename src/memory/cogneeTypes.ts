/**
 * cogneeTypes.ts — TypeScript types for the Cognee knowledge-graph integration.
 *
 * Cognee (https://github.com/topoteretes/cognee) is a Python-based knowledge
 * graph memory platform. This module defines the TypeScript interfaces and
 * types used by cogneeIntegration.ts and cogneeTools.ts.
 *
 * Cognee is surfaced as a managed MCP server subprocess. The key Cognee APIs
 * we wrap are: remember, cognify, recall, search, forget, improve, prune,
 * and visualize_graph.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the Cognee integration, read from IAppConfig.
 *
 * These fields are expected on the IAppConfig object (added via module
 * augmentation in cogneeIntegration.ts). All fields are optional with
 * sensible defaults — the integration degrades gracefully when absent.
 */
export interface ICogneeConfig {
	/** Whether the Cognee knowledge-graph integration is enabled (default: false). */
	cogneeEnabled?: boolean;
	/** Path to the Python interpreter that has cognee installed (default: 'python3'). */
	cogneePythonPath?: string;
	/** Graph database backend (default: 'kuzu' — local, no external deps). */
	cogneeGraphDb?: 'kuzu' | 'neo4j';
	/** Embedding provider for Cognee's internal pipeline (default: 'ollama'). */
	cogneeEmbedProvider?: 'ollama' | 'openai';
}

// ---------------------------------------------------------------------------
// Search types (mirrors Cognee's SearchType enum)
// ---------------------------------------------------------------------------

/**
 * Cognee search strategies, matching the Python SearchType enum.
 *
 *   - GRAPH_COMPLETION: Traverse the graph and use LLM to complete the answer
 *   - CHUNKS:           Return relevant text chunks from the knowledge graph
 *   - INSIGHTS:         Return extracted insights / entities / relationships
 *   - SUMMARIES:        Return summarised knowledge for the query
 */
export enum CogneeSearchType {
	GRAPH_COMPLETION = 'GRAPH_COMPLETION',
	CHUNKS = 'CHUNKS',
	INSIGHTS = 'INSIGHTS',
	SUMMARIES = 'SUMMARIES',
}

// ---------------------------------------------------------------------------
// Service state
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of the Cognee service.
 *
 *   - 'starting':    Process is being spawned, initialisation in progress
 *   - 'available':   Cognee MCP server is connected and responding
 *   - 'degraded':    Cognee is reachable but recent calls failed (retrying)
 *   - 'unavailable': Cognee process is down or unreachable; fallback active
 *   - 'disabled':    Cognee integration is disabled in configuration
 */
export type CogneeServiceState =
	| 'starting'
	| 'available'
	| 'degraded'
	| 'unavailable'
	| 'disabled';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Result from a Cognee `recall` operation.
 *
 * Cognee recall combines knowledge-graph retrieval with session cache,
 * returning structured results with provenance.
 */
export interface ICogneeRecallResult {
	/** The recalled text / knowledge content. */
	content: string;
	/** Source dataset(s) the result was drawn from. */
	datasets: string[];
	/** Relevance score (0–1, higher = more relevant). */
	score: number;
	/** Unique ID of the source node in the knowledge graph. */
	nodeId?: string;
	/** Timestamp when the source data was ingested. */
	ingestedAt?: string;
}

/**
 * Result from a Cognee `search` operation.
 *
 * Search results vary by search type — CHUNKS returns raw text,
 * INSIGHTS returns structured entities/relations, GRAPH_COMPLETION
 * returns LLM-generated answers, and SUMMARIES returns condensed knowledge.
 */
export interface ICogneeSearchResult {
	/** The search result content (format depends on CogneeSearchType). */
	content: string;
	/** The search strategy that produced this result. */
	searchType: CogneeSearchType;
	/** Source dataset(s). */
	datasets: string[];
	/** Relevance score (0–1). */
	score: number;
	/** Additional metadata from Cognee (varies by search type). */
	metadata?: Record<string, unknown>;
}

/**
 * Graph visualization data from Cognee's `visualize_graph` API.
 *
 * Returns nodes and edges suitable for rendering a knowledge graph.
 */
export interface ICogneeGraphViz {
	/** Graph nodes (entities, concepts). */
	nodes: Array<{
		/** Unique node identifier. */
		id: string;
		/** Human-readable label. */
		label: string;
		/** Node type (e.g. 'Entity', 'Concept', 'Document'). */
		type: string;
		/** Optional properties attached to the node. */
		properties?: Record<string, unknown>;
	}>;
	/** Graph edges (relationships between nodes). */
	edges: Array<{
		/** Source node ID. */
		source: string;
		/** Target node ID. */
		target: string;
		/** Relationship type / label. */
		relationship: string;
		/** Optional properties attached to the edge. */
		properties?: Record<string, unknown>;
	}>;
	/** Dataset this visualization belongs to. */
	dataset: string;
}

/**
 * A memory entry in the Cognee knowledge graph, with full provenance.
 *
 * Unlike IMemoryMatch (which is a flat similarity match), this includes
 * graph-aware metadata: which dataset, which node, and relationships.
 */
export interface ICogneeMemoryEntry {
	/** Unique identifier in the knowledge graph. */
	id: string;
	/** The text / knowledge content. */
	content: string;
	/** Dataset this entry belongs to. */
	dataset: string;
	/** When the data was ingested (ISO 8601). */
	ingestedAt: string;
	/** Whether the data has been cognified (processed into the graph). */
	cognified: boolean;
	/** Node type in the knowledge graph (e.g. 'Chunk', 'Entity', 'Insight'). */
	nodeType?: string;
	/** Related node IDs in the knowledge graph. */
	relatedNodeIds?: string[];
	/** Optional user-provided metadata from the original `remember` call. */
	metadata?: Record<string, unknown>;
}
