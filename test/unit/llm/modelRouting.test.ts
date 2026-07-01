/**
 * modelRouting.test.ts — Unit tests for modelRouting.ts (HARVEST-3).
 *
 * Validates: purpose classification, routing decisions, override logic,
 * validation, and batch routing. Pure-logic tests — no service mocks needed.
 */

import * as assert from 'assert';
import {
        MODEL_PURPOSES,
        PURPOSE_TIER_DEFAULTS,
        type IModelRoutingTable,
        type IActiveModelSnapshot,
        routeModel,
        routeAllPurposes,
        validateRoutingTable,
        DEFAULT_ROUTING_TABLE,
        classifyModelTier,
        MODEL_ROUTING_CONFIG_KEY,
} from '../../../src/llm/modelRouting';
import type { AIProviderType } from '../../../src/types/llm';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const nvidiaSnapshot: IActiveModelSnapshot = {
        activeProvider: 'nvidia-nim' as AIProviderType,
        activeModel: {
                id: 'nvidia/nemotron-3-nano-30b-a3b:free',
                displayName: 'Nemotron 3 Nano 30B',
                provider: 'nvidia-nim' as AIProviderType,
                contextWindowTokens: 4096,
                supportsTools: false,
                supportsStreaming: true,
        },
};

const anthropicSnapshot: IActiveModelSnapshot = {
        activeProvider: 'anthropic' as AIProviderType,
        activeModel: {
                id: 'claude-sonnet-4-20250514',
                displayName: 'Claude Sonnet 4',
                provider: 'anthropic' as AIProviderType,
                contextWindowTokens: 200_000,
                supportsTools: true,
                supportsStreaming: true,
        },
};

const noModelSnapshot: IActiveModelSnapshot = {
        activeProvider: 'anthropic' as AIProviderType,
        activeModel: undefined,
};

// ---------------------------------------------------------------------------
// ModelPurpose enum
// ---------------------------------------------------------------------------

describe('modelRouting', () => {
        describe('MODEL_PURPOSES', () => {
                it('contains all 6 purposes', () => {
                        assert.strictEqual(MODEL_PURPOSES.length, 6);
                        assert.ok(MODEL_PURPOSES.includes('autocomplete'));
                        assert.ok(MODEL_PURPOSES.includes('inline-edit'));
                        assert.ok(MODEL_PURPOSES.includes('agent-plan'));
                        assert.ok(MODEL_PURPOSES.includes('agent-execute'));
                        assert.ok(MODEL_PURPOSES.includes('chat'));
                        assert.ok(MODEL_PURPOSES.includes('embedding'));
                });
        });

        describe('PURPOSE_TIER_DEFAULTS', () => {
                it('maps each purpose to a tier', () => {
                        for (const purpose of MODEL_PURPOSES) {
                                assert.ok(purpose in PURPOSE_TIER_DEFAULTS, `Missing tier for purpose: ${purpose}`);
                        }
                });

                it('maps agent-plan to capable', () => {
                        assert.strictEqual(PURPOSE_TIER_DEFAULTS['agent-plan'], 'capable');
                });

                it('maps autocomplete to lightweight', () => {
                        assert.strictEqual(PURPOSE_TIER_DEFAULTS['autocomplete'], 'lightweight');
                });

                it('maps embedding to embedding', () => {
                        assert.strictEqual(PURPOSE_TIER_DEFAULTS['embedding'], 'embedding');
                });
        });

        // ---------------------------------------------------------------------------
        // classifyModelTier
        // ---------------------------------------------------------------------------

        describe('classifyModelTier()', () => {
                it('classifies free models as lightweight', () => {
                        assert.strictEqual(
                                classifyModelTier({ contextWindow: 128_000, supportsTools: true, costTier: 'free' }),
                                'lightweight',
                        );
                });

                it('classifies low-cost models as lightweight', () => {
                        assert.strictEqual(
                                classifyModelTier({ contextWindow: 32_000, supportsTools: false, costTier: 'low' }),
                                'lightweight',
                        );
                });

                it('classifies small-context models as lightweight', () => {
                        assert.strictEqual(
                                classifyModelTier({ contextWindow: 4_000, supportsTools: false, costTier: 'medium' }),
                                'lightweight',
                        );
                });

                it('classifies tool-capable large-context models as capable', () => {
                        assert.strictEqual(
                                classifyModelTier({ contextWindow: 200_000, supportsTools: true, costTier: 'medium' }),
                                'capable',
                        );
                });

                it('classifies expensive tool-capable models as capable', () => {
                        assert.strictEqual(
                                classifyModelTier({ contextWindow: 32_000, supportsTools: true, costTier: 'high' }),
                                'capable',
                        );
                });

                it('classifies non-tool medium models as standard', () => {
                        assert.strictEqual(
                                classifyModelTier({ contextWindow: 32_000, supportsTools: false, costTier: 'medium' }),
                                'standard',
                        );
                });
        });

        // ---------------------------------------------------------------------------
        // routeModel — no overrides (default behaviour)
        // ---------------------------------------------------------------------------

        describe('routeModel() — no overrides', () => {
                it('routes to active provider/model when no override exists', () => {
                        const result = routeModel('chat', DEFAULT_ROUTING_TABLE, nvidiaSnapshot);
                        assert.strictEqual(result.provider, 'nvidia-nim');
                        assert.strictEqual(result.modelId, 'nvidia/nemotron-3-nano-30b-a3b:free');
                        assert.strictEqual(result.overrideApplied, false);
                        assert.ok(result.reason.includes('No override'));
                });

                it('routes agent-plan to active model (even if not capable)', () => {
                        const result = routeModel('agent-plan', DEFAULT_ROUTING_TABLE, nvidiaSnapshot);
                        assert.strictEqual(result.modelId, 'nvidia/nemotron-3-nano-30b-a3b:free');
                        assert.strictEqual(result.overrideApplied, false);
                });

                it('returns empty modelId when no active model', () => {
                        const result = routeModel('chat', DEFAULT_ROUTING_TABLE, noModelSnapshot);
                        assert.strictEqual(result.modelId, '');
                        assert.ok(result.reason.includes('no active model'));
                });
        });

        // ---------------------------------------------------------------------------
        // routeModel — with overrides
        // ---------------------------------------------------------------------------

        describe('routeModel() — with overrides', () => {
                const table: IModelRoutingTable = {
                        'agent-plan': { provider: 'anthropic' as AIProviderType, modelId: 'claude-sonnet-4-20250514' },
                        'agent-execute': { modelId: 'nvidia/nemotron-3-nano-30b-a3b:free' },
                        chat: { provider: 'nvidia-nim' as AIProviderType },
                };

                it('uses full override (provider + model)', () => {
                        const result = routeModel('agent-plan', table, nvidiaSnapshot);
                        assert.strictEqual(result.provider, 'anthropic');
                        assert.strictEqual(result.modelId, 'claude-sonnet-4-20250514');
                        assert.strictEqual(result.overrideApplied, true);
                        assert.ok(result.reason.includes('Routing table override'));
                });

                it('uses model-only override (provider from active)', () => {
                        const result = routeModel('agent-execute', table, anthropicSnapshot);
                        assert.strictEqual(result.provider, 'anthropic'); // falls back to active
                        assert.strictEqual(result.modelId, 'nvidia/nemotron-3-nano-30b-a3b:free'); // from override
                        assert.strictEqual(result.overrideApplied, true);
                });

                it('uses provider-only override (model from active)', () => {
                        const result = routeModel('chat', table, anthropicSnapshot);
                        assert.strictEqual(result.provider, 'nvidia-nim'); // from override
                        assert.strictEqual(result.modelId, 'claude-sonnet-4-20250514'); // from active
                        assert.strictEqual(result.overrideApplied, true);
                });

                it('falls through for purposes without overrides', () => {
                        const result = routeModel('autocomplete', table, nvidiaSnapshot);
                        assert.strictEqual(result.provider, 'nvidia-nim');
                        assert.strictEqual(result.modelId, 'nvidia/nemotron-3-nano-30b-a3b:free');
                        assert.strictEqual(result.overrideApplied, false);
                });
        });

        // ---------------------------------------------------------------------------
        // routeAllPurposes
        // ---------------------------------------------------------------------------

        describe('routeAllPurposes()', () => {
                it('returns a result for every purpose', () => {
                        const results = routeAllPurposes(DEFAULT_ROUTING_TABLE, nvidiaSnapshot);
                        for (const purpose of MODEL_PURPOSES) {
                                assert.ok(purpose in results, `Missing result for purpose: ${purpose}`);
                                assert.strictEqual(results[purpose].purpose, purpose);
                        }
                });
        });

        // ---------------------------------------------------------------------------
        // validateRoutingTable
        // ---------------------------------------------------------------------------

        describe('validateRoutingTable()', () => {
                it('returns no issues for empty table', () => {
                        const issues = validateRoutingTable(DEFAULT_ROUTING_TABLE);
                        assert.deepStrictEqual(issues, []);
                });

                it('flags provider without modelId', () => {
                        const table: IModelRoutingTable = {
                                chat: { provider: 'anthropic' as AIProviderType },
                        };
                        const issues = validateRoutingTable(table);
                        assert.strictEqual(issues.length, 1);
                        assert.ok(issues[0].includes('no modelId'));
                });

                it('flags embedding purpose pointing to LLM provider', () => {
                        const table: IModelRoutingTable = {
                                embedding: { provider: 'anthropic' as AIProviderType, modelId: 'claude-3-haiku' },
                        };
                        const issues = validateRoutingTable(table);
                        assert.strictEqual(issues.length, 1);
                        assert.ok(issues[0].includes('embedding'));
                        assert.ok(issues[0].includes('LLM provider'));
                });

                it('returns no issues for valid override', () => {
                        const table: IModelRoutingTable = {
                                'agent-plan': { provider: 'anthropic' as AIProviderType, modelId: 'claude-sonnet-4-20250514' },
                        };
                        const issues = validateRoutingTable(table);
                        assert.deepStrictEqual(issues, []);
                });
        });

        // ---------------------------------------------------------------------------
        // Honest assessment: single-provider scenario
        // ---------------------------------------------------------------------------

        describe('Honest assessment — single provider (current user setup)', () => {
                it('all purposes route to same model when no overrides exist', () => {
                        const results = routeAllPurposes(DEFAULT_ROUTING_TABLE, nvidiaSnapshot);
                        const uniqueModels = new Set(Object.values(results).map(r => r.modelId));
                        assert.strictEqual(uniqueModels.size, 1, 'All purposes should route to the same model when no overrides exist');
                });

                it('override enables different model for planning even with single provider', () => {
                        const table: IModelRoutingTable = {
                                'agent-plan': { modelId: 'nvidia/llama-3.1-nemotron-70b:free' },
                        };
                        const planResult = routeModel('agent-plan', table, nvidiaSnapshot);
                        const chatResult = routeModel('chat', table, nvidiaSnapshot);
                        assert.notStrictEqual(planResult.modelId, chatResult.modelId);
                });
        });

        // ---------------------------------------------------------------------------
        // Config key exported
        // ---------------------------------------------------------------------------

        describe('MODEL_ROUTING_CONFIG_KEY', () => {
                it('is a non-empty string', () => {
                        assert.ok(typeof MODEL_ROUTING_CONFIG_KEY === 'string');
                        assert.ok(MODEL_ROUTING_CONFIG_KEY.length > 0);
                });
        });
});
