/**
 * Tests for modelRouting.ts — model routing by purpose.
 *
 * Tests the actual API: routeModel(purpose, routingTable, snapshot),
 * classifyModelTier, routeAllPurposes, validateRoutingTable.
 */
import { expect } from 'chai';
import {
        routeModel,
        routeAllPurposes,
        validateRoutingTable,
        classifyModelTier,
        DEFAULT_ROUTING_TABLE,
        MODEL_PURPOSES,
        type IModelRoutingTable,
        type IActiveModelSnapshot,
        type IModelCharacteristics,
} from '../../../src/llm/modelRouting';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultSnapshot: IActiveModelSnapshot = {
        activeProvider: 'anthropic',
        activeModel: { id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', provider: 'anthropic', contextWindowTokens: 200000, supportsTools: true, supportsStreaming: true },
};

const emptySnapshot: IActiveModelSnapshot = {
        activeProvider: 'anthropic',
        activeModel: undefined,
};

// ---------------------------------------------------------------------------
// routeModel()
// ---------------------------------------------------------------------------

describe('modelRouting — routeModel()', () => {
        it('falls through to active model when no override exists', () => {
                const result = routeModel('chat', DEFAULT_ROUTING_TABLE, defaultSnapshot);
                expect(result.provider).to.equal('anthropic');
                expect(result.modelId).to.equal('claude-sonnet-4-20250514');
                expect(result.overrideApplied).to.be.false;
        });

        it('applies routing table override when present', () => {
                const table: IModelRoutingTable = {
                        'agent-plan': { provider: 'openai', modelId: 'gpt-4o' },
                };
                const result = routeModel('agent-plan', table, defaultSnapshot);
                expect(result.provider).to.equal('openai');
                expect(result.modelId).to.equal('gpt-4o');
                expect(result.overrideApplied).to.be.true;
        });

        it('overrides provider but uses active model when modelId not specified', () => {
                const table: IModelRoutingTable = {
                        chat: { provider: 'ollama' },
                };
                const result = routeModel('chat', table, defaultSnapshot);
                expect(result.provider).to.equal('ollama');
                expect(result.modelId).to.equal('claude-sonnet-4-20250514'); // from active snapshot
                expect(result.overrideApplied).to.be.true;
        });

        it('overrides modelId but uses active provider when provider not specified', () => {
                const table: IModelRoutingTable = {
                        autocomplete: { modelId: 'claude-haiku-4-20250514' },
                };
                const result = routeModel('autocomplete', table, defaultSnapshot);
                expect(result.provider).to.equal('anthropic');
                expect(result.modelId).to.equal('claude-haiku-4-20250514');
                expect(result.overrideApplied).to.be.true;
        });

        it('returns empty modelId when no active model and no override', () => {
                const result = routeModel('chat', DEFAULT_ROUTING_TABLE, emptySnapshot);
                expect(result.modelId).to.equal('');
                expect(result.overrideApplied).to.be.false;
        });

        it('returns a reason string for every routing decision', () => {
                const result1 = routeModel('chat', DEFAULT_ROUTING_TABLE, defaultSnapshot);
                expect(result1.reason).to.be.a('string').and.not.empty;

                const table: IModelRoutingTable = { chat: { provider: 'ollama', modelId: 'llama3' } };
                const result2 = routeModel('chat', table, defaultSnapshot);
                expect(result2.reason).to.be.a('string').and.not.empty;
        });

        it('routes all MODEL_PURPOSES without error', () => {
                for (const purpose of MODEL_PURPOSES) {
                        const result = routeModel(purpose, DEFAULT_ROUTING_TABLE, defaultSnapshot);
                        expect(result.purpose).to.equal(purpose);
                        expect(result.provider).to.be.a('string');
                }
        });
});

// ---------------------------------------------------------------------------
// routeAllPurposes()
// ---------------------------------------------------------------------------

describe('modelRouting — routeAllPurposes()', () => {
        it('returns a result for every ModelPurpose', () => {
                const results = routeAllPurposes(DEFAULT_ROUTING_TABLE, defaultSnapshot);
                for (const purpose of MODEL_PURPOSES) {
                        expect(results[purpose]).to.exist;
                        expect(results[purpose].purpose).to.equal(purpose);
                }
        });
});

// ---------------------------------------------------------------------------
// validateRoutingTable()
// ---------------------------------------------------------------------------

describe('modelRouting — validateRoutingTable()', () => {
        it('returns empty array for the default (empty) table', () => {
                const issues = validateRoutingTable(DEFAULT_ROUTING_TABLE);
                expect(issues).to.have.length(0);
        });

        it('flags provider without modelId', () => {
                const table: IModelRoutingTable = {
                        chat: { provider: 'openai' },
                };
                const issues = validateRoutingTable(table);
                expect(issues.length).to.be.greaterThan(0);
                expect(issues.some(i => i.includes('no modelId'))).to.be.true;
        });

        it('flags embedding purpose pointing to an LLM provider', () => {
                const table: IModelRoutingTable = {
                        embedding: { provider: 'openai', modelId: 'text-embedding-3-small' },
                };
                const issues = validateRoutingTable(table);
                expect(issues.length).to.be.greaterThan(0);
                expect(issues.some(i => i.includes('embedding'))).to.be.true;
        });

        it('accepts valid overrides without issues', () => {
                const table: IModelRoutingTable = {
                        'agent-plan': { provider: 'openai', modelId: 'gpt-4o' },
                        'agent-execute': { provider: 'ollama', modelId: 'llama3' },
                };
                const issues = validateRoutingTable(table);
                expect(issues).to.have.length(0);
        });
});

// ---------------------------------------------------------------------------
// classifyModelTier()
// ---------------------------------------------------------------------------

describe('modelRouting — classifyModelTier()', () => {
        it('classifies free models as lightweight', () => {
                const chars: IModelCharacteristics = { contextWindow: 128000, supportsTools: true, costTier: 'free' };
                expect(classifyModelTier(chars)).to.equal('lightweight');
        });

        it('classifies low-cost models as lightweight', () => {
                const chars: IModelCharacteristics = { contextWindow: 128000, supportsTools: true, costTier: 'low' };
                expect(classifyModelTier(chars)).to.equal('lightweight');
        });

        it('classifies small-context models as lightweight', () => {
                const chars: IModelCharacteristics = { contextWindow: 8000, supportsTools: false, costTier: 'medium' };
                expect(classifyModelTier(chars)).to.equal('lightweight');
        });

        it('classifies tool-supporting large-context models as capable', () => {
                const chars: IModelCharacteristics = { contextWindow: 200000, supportsTools: true, costTier: 'medium' };
                expect(classifyModelTier(chars)).to.equal('capable');
        });

        it('classifies tool-supporting high-cost models as capable', () => {
                const chars: IModelCharacteristics = { contextWindow: 32000, supportsTools: true, costTier: 'high' };
                expect(classifyModelTier(chars)).to.equal('capable');
        });

        it('classifies non-tool medium models without huge context as standard', () => {
                const chars: IModelCharacteristics = { contextWindow: 32000, supportsTools: false, costTier: 'medium' };
                expect(classifyModelTier(chars)).to.equal('standard');
        });
});
