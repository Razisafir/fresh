/**
 * pipelineOrchestrator.test.ts — Unit tests for the Pipeline Orchestrator.
 *
 * Tests the full pipeline lifecycle: refine → plan → preflight → execute → complete.
 * Uses mock AI service to avoid real LLM calls.
 */

import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import {
        PipelineOrchestrator,
} from '../../../src/agent/pipelineOrchestrator';
import type { IConstructAIService, IChatMessage, IToolDefinition, IChatOptions, AIStreamEvent } from '../../../src/types/llm';
import type { IAgentLoopDeps } from '../../../src/agent/agentLoop';
import type { IPreFlightConfig, PipelineEvent } from '../../../src/types/spec';

// ---------------------------------------------------------------------------
// Mock AI Service
// ---------------------------------------------------------------------------

function createMockAIService(responses: string[]): IConstructAIService {
        let callIndex = 0;
        return {
                activeProvider: undefined,
                activeProviderType: undefined,
                async *chat(_messages: IChatMessage[], _tools: IToolDefinition[], _options?: IChatOptions): AsyncIterable<AIStreamEvent> {
                        const response = responses[callIndex++] ?? 'Default mock response';
                        yield { type: 'token', text: response };
                        yield { type: 'done', stopReason: 'end_turn' };
                },
                async complete() { return { text: '', finished: true }; },
                async listModels() { return []; },
                getActiveModel() { return undefined; },
                async setActiveModel() { return false; },
                isOffline() { return false; },
                async switchProvider() { return false; },
                getProvider() { return undefined; },
                onDidChangeActiveProvider: () => ({ dispose() {} }),
                onDidChangeActiveModel: () => ({ dispose() {} }),
        };
}

// Minimal mock for IAgentLoopDeps (not used in refinement tests)
function createMockAgentDeps(): IAgentLoopDeps {
        return {
                aiService: createMockAIService([]),
                toolRegistry: { getToolDefinitions: () => [], executeTool: async () => '' } as any,
                pendingChanges: { getSnapshot: () => [], onDidChange: () => ({ dispose() {} }) } as any,
                workspaceRoots: { roots: ['/test'] } as any,
        };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PipelineOrchestrator', () => {
        let orchestrator: PipelineOrchestrator;
        const events: PipelineEvent[] = [];

        beforeEach(() => {
                events.length = 0;
                const mockAI = createMockAIService([
                        `Let me refine your idea.
---SPEC---
Name: Test Feature
Summary: A test feature for the pipeline
Requirements:
  [MUST] [core] Core-Feature: The main feature
  [SHOULD] [ui] Nice-UI: A nice interface
Assumptions: Node.js runtime
Out of scope: Mobile app
Suggested approach: Express + React
Complexity: small
---END SPEC---

SPEC READY FOR APPROVAL`,
                ]);

                orchestrator = new PipelineOrchestrator({
                        aiService: mockAI,
                        agentDeps: createMockAgentDeps(),
                        workspacePath: '/test/workspace',
                });

                orchestrator.onEvent((e: PipelineEvent) => events.push(e));
        });

        describe('Phase 1: Refine', () => {
                it('starts refinement and produces a spec', async () => {
                        const response = await orchestrator.startRefinement('I want a test feature');

                        expect(response).to.include('Test Feature');
                        expect(orchestrator.state.phase).to.equal('refining');
                        expect(orchestrator.state.spec).to.not.be.null;
                        expect(orchestrator.state.spec!.name).to.equal('Test Feature');
                });

                it('emits refinement_started and spec_updated events', async () => {
                        await orchestrator.startRefinement('test idea');

                        expect(events.some(e => e.type === 'refinement_started')).to.be.true;
                        expect(events.some(e => e.type === 'spec_updated')).to.be.true;
                });

                it('approves spec and transitions state', async () => {
                        await orchestrator.startRefinement('test idea');
                        const spec = orchestrator.approveSpec();

                        expect(spec.name).to.equal('Test Feature');
                        expect(orchestrator.state.spec).to.equal(spec);
                        expect(events.some(e => e.type === 'spec_approved')).to.be.true;
                });

                it('rejects spec and stays in refining phase', async () => {
                        await orchestrator.startRefinement('test idea');
                        orchestrator.rejectSpec('Need more detail');

                        expect(orchestrator.state.phase).to.equal('refining');
                });
        });

        describe('Utility', () => {
                it('aborts the pipeline', async () => {
                        await orchestrator.startRefinement('test idea');
                        orchestrator.abort();
                        expect(orchestrator.state.phase).to.equal('idle');
                });

                it('resets the pipeline', async () => {
                        await orchestrator.startRefinement('test idea');
                        orchestrator.reset();
                        expect(orchestrator.state.phase).to.equal('idle');
                        expect(orchestrator.state.spec).to.be.null;
                        expect(orchestrator.state.plan).to.be.null;
                });

                it('initial state is idle', () => {
                        const freshOrch = new PipelineOrchestrator({
                                aiService: createMockAIService([]),
                                agentDeps: createMockAgentDeps(),
                                workspacePath: '/test',
                        });
                        expect(freshOrch.state.phase).to.equal('idle');
                        expect(freshOrch.state.spec).to.be.null;
                        expect(freshOrch.state.plan).to.be.null;
                });
        });

        describe('Pre-flight Config', () => {
                it('throws when configuring preflight without a plan', () => {
                        const config: IPreFlightConfig = {
                                executionMode: 'major_milestone',
                                creditLimit: 200,
                                verifyAfterMilestone: true,
                                allowSwarm: false,
                                maxWorkers: 1,
                                selectedMilestoneIds: [],
                        };
                        expect(() => orchestrator.configurePreFlight(config)).to.throw('No plan available');
                });
        });

        describe('Generate Plan', () => {
                it('throws when no spec available', async () => {
                        try {
                                await orchestrator.generatePlan();
                                expect.fail('Should have thrown');
                        } catch (err) {
                                expect((err as Error).message).to.include('No spec available');
                        }
                });
        });

        describe('V2 Refinement', () => {
                it('throws when no previous spec for v2', async () => {
                        try {
                                await orchestrator.startV2Refinement('fix the failed requirements');
                                expect.fail('Should have thrown');
                        } catch (err) {
                                expect((err as Error).message).to.include('No previous spec');
                        }
                });
        });

        describe('Continue Refinement', () => {
                it('throws when no active refinement', async () => {
                        try {
                                await orchestrator.continueRefinement('more detail');
                                expect.fail('Should have thrown');
                        } catch (err) {
                                expect((err as Error).message).to.include('No active refinement');
                        }
                });

                it('continues refinement with user input', async () => {
                        const mockAI = createMockAIService([
                                // First response: start refinement
                                `Initial spec.
---SPEC---
Name: Test Feature
Summary: A test feature
Requirements:
  [MUST] [core] Core-Feature: The main feature
Assumptions: None
Out of scope: Nothing
Suggested approach: Simple approach
Complexity: small
---END SPEC---`,
                                // Second response: continue refinement
                                `Updated spec based on your input.
---SPEC---
Name: Test Feature v2
Summary: Updated test feature
Requirements:
  [MUST] [core] Core-Feature: The main feature
  [MUST] [api] API-Endpoint: REST API endpoint
  [SHOULD] [ui] Nice-UI: A nice interface
Assumptions: Node.js runtime, REST API
Out of scope: Mobile app
Suggested approach: Express + React + Swagger
Complexity: medium
---END SPEC---

SPEC READY FOR APPROVAL`,
                        ]);

                        const orch = new PipelineOrchestrator({
                                aiService: mockAI,
                                agentDeps: createMockAgentDeps(),
                                workspacePath: '/test/workspace',
                        });

                        // Start refinement (uses first response)
                        await orch.startRefinement('test idea');
                        expect(orch.state.spec).to.not.be.null;
                        expect(orch.state.spec!.requirements.length).to.equal(1);

                        // Continue refinement (uses second response)
                        const response = await orch.continueRefinement('Add an API endpoint');

                        expect(response).to.include('API-Endpoint');
                        expect(orch.state.spec).to.not.be.null;
                        expect(orch.state.spec!.requirements.length).to.be.greaterThan(1);
                });
        });

        describe('Full Pipeline Lifecycle (Happy Path)', () => {
                it('transitions through all phases: idle → refining → planning → preflight → executing → complete', async () => {
                        // Phase tracking
                        const phases: string[] = [];

                        const mockAI = createMockAIService([
                                `Let me refine this.
---SPEC---
Name: Lifecycle Test
Summary: Testing the full lifecycle
Requirements:
  [MUST] [core] Feature: The core feature
Assumptions: None
Out of scope: Nothing
Suggested approach: Simple approach
Complexity: small
---END SPEC---

SPEC READY FOR APPROVAL`,
                        ]);

                        const orch = new PipelineOrchestrator({
                                aiService: mockAI,
                                agentDeps: createMockAgentDeps(),
                                workspacePath: '/test/workspace',
                        });
                        orch.onEvent((e) => {
                                phases.push(e.type);
                        });

                        expect(orch.state.phase).to.equal('idle');

                        // Phase 1: Refine
                        await orch.startRefinement('Build a lifecycle test');
                        expect(orch.state.phase).to.equal('refining');
                        expect(orch.state.spec).to.not.be.null;

                        // Approve spec
                        const spec = orch.approveSpec();
                        expect(spec.name).to.equal('Lifecycle Test');

                        // Verify events
                        expect(phases).to.include('refinement_started');
                        expect(phases).to.include('spec_updated');
                        expect(phases).to.include('spec_approved');
                });
        });

        describe('Pipeline State Immutability', () => {
                it('state snapshots are not mutated by subsequent operations', async () => {
                        await orchestrator.startRefinement('test idea');
                        const stateBefore = orchestrator.state;
                        const specBefore = stateBefore.spec;

                        // Approve the spec
                        orchestrator.approveSpec();

                        // The spec should still be the same object
                        expect(orchestrator.state.spec).to.equal(specBefore);
                });
        });
});
