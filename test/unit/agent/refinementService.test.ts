/**
 * refinementService.test.ts — Unit tests for the Refinement Service.
 *
 * Tests the spec parsing, prompt building, and refinement flow
 * using a mock AI service.
 */

import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import {
        buildRefinementPrompt,
        parseSpecFromResponse,
        isSpecReadyForApproval,
        RefinementService,
} from '../../../src/agent/refinementService';
import type { IConstructAIService, IChatMessage, IToolDefinition, IChatOptions, AIStreamEvent } from '../../../src/types/llm';

// ---------------------------------------------------------------------------
// Mock AI Service
// ---------------------------------------------------------------------------

function createMockAIService(responses: string[]): IConstructAIService {
        let callIndex = 0;

        return {
                activeProvider: undefined,
                activeProviderType: undefined,
                async *chat(_messages: IChatMessage[], _tools: IToolDefinition[], _options?: IChatOptions): AsyncIterable<AIStreamEvent> {
                        const response = responses[callIndex++] ?? 'No more mock responses';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildRefinementPrompt', () => {
        it('includes workspace path and round number', () => {
                const prompt = buildRefinementPrompt({
                        workspacePath: '/home/user/project',
                        round: 3,
                });
                expect(prompt).to.include('/home/user/project');
                expect(prompt).to.include('Round 3');
        });

        it('includes existing spec when provided', () => {
                const prompt = buildRefinementPrompt({
                        workspacePath: '/home/user/project',
                        round: 2,
                        existingSpec: {
                                id: 'spec-1',
                                name: 'Test Feature',
                                summary: 'A test feature',
                                rawIdea: 'test',
                                requirements: [
                                        { id: 'req-1', label: 'Core', description: 'Core functionality', priority: 'must', category: 'core', satisfied: false },
                                ],
                                assumptions: ['Node.js runtime'],
                                outOfScope: ['Mobile app'],
                                suggestedApproach: 'Use Express',
                                complexity: 'medium',
                                estimatedCredits: 150,
                                createdAt: Date.now(),
                                version: 1,
                        },
                });
                expect(prompt).to.include('Test Feature');
                expect(prompt).to.include('Core functionality');
        });

        it('includes REFINE mode rules', () => {
                const prompt = buildRefinementPrompt({
                        workspacePath: '/test',
                        round: 1,
                });
                expect(prompt).to.include('REFINE mode');
                expect(prompt).to.include('ASK QUESTIONS');
        });
});

describe('parseSpecFromResponse', () => {
        it('parses a complete spec block', () => {
                const response = `Let me help you refine this idea.

---SPEC---
Name: Todo App
Summary: A simple todo application with CRUD operations
Requirements:
  [MUST] [core] Create-Todo: Users can create new todos
  [MUST] [core] Delete-Todo: Users can delete todos
  [SHOULD] [ui] Filter-Todos: Users can filter todos by status
  [COULD] [perf] Caching: Cache todo list for offline access
Assumptions: Single user; Local storage
Out of scope: Multi-user sync; Mobile native app
Suggested approach: Build with Express backend and React frontend
Complexity: medium
---END SPEC---`;

                const spec = parseSpecFromResponse(response, 'I want a todo app');

                expect(spec).to.not.be.null;
                expect(spec!.name).to.equal('Todo App');
                expect(spec!.summary).to.include('CRUD operations');
                expect(spec!.requirements).to.have.length(4);
                expect(spec!.requirements[0].priority).to.equal('must');
                expect(spec!.requirements[0].label).to.equal('Create-Todo');
                expect(spec!.requirements[2].priority).to.equal('should');
                expect(spec!.requirements[3].category).to.equal('perf');
                expect(spec!.assumptions).to.have.length(2);
                expect(spec!.outOfScope).to.have.length(2);
                expect(spec!.complexity).to.equal('medium');
        });

        it('returns null when no spec block found', () => {
                const spec = parseSpecFromResponse('Just a regular response without spec', 'idea');
                expect(spec).to.be.null;
        });

        it('increments version from previous spec', () => {
                const previousSpec = {
                        id: 'spec-1',
                        name: 'Test',
                        summary: 'Test',
                        rawIdea: 'test',
                        requirements: [],
                        assumptions: [],
                        outOfScope: [],
                        suggestedApproach: '',
                        complexity: 'small' as const,
                        estimatedCredits: 50,
                        createdAt: Date.now(),
                        version: 3,
                };

                const response = `---SPEC---
Name: Test v2
Summary: Updated test
Requirements:
Assumptions: none
Out of scope: none
Suggested approach: none
Complexity: small
---END SPEC---`;

                const spec = parseSpecFromResponse(response, 'test', previousSpec);
                expect(spec!.version).to.equal(4);
                expect(spec!.id).to.equal('spec-1'); // Preserves ID
        });

        it('estimates credits based on complexity', () => {
                const smallSpec = parseSpecFromResponse(
                        `---SPEC---\nName: T\nSummary: S\nRequirements:\nAssumptions:\nOut of scope:\nSuggested approach:\nComplexity: small\n---END SPEC---`,
                        'test',
                );
                expect(smallSpec!.estimatedCredits).to.equal(50);

                const largeSpec = parseSpecFromResponse(
                        `---SPEC---\nName: T\nSummary: S\nRequirements:\nAssumptions:\nOut of scope:\nSuggested approach:\nComplexity: large\n---END SPEC---`,
                        'test',
                );
                expect(largeSpec!.estimatedCredits).to.equal(300);
        });
});

describe('isSpecReadyForApproval', () => {
        it('returns true when SPEC READY FOR APPROVAL is present', () => {
                expect(isSpecReadyForApproval('Here is the spec. SPEC READY FOR APPROVAL')).to.be.true;
        });

        it('returns true for case-insensitive match', () => {
                expect(isSpecReadyForApproval('spec ready for approval')).to.be.true;
        });

        it('returns false when not ready', () => {
                expect(isSpecReadyForApproval('Still refining...')).to.be.false;
        });
});

describe('RefinementService', () => {
        let service: RefinementService;
        let mockAI: IConstructAIService;
        const events: any[] = [];

        beforeEach(() => {
                events.length = 0;
                mockAI = createMockAIService([
                        `Let me ask about your idea.
---SPEC---
Name: Test Idea
Summary: A test
Requirements:
  [MUST] [core] Core-Feature: The main feature
Assumptions: Node.js
Out of scope: Mobile
Suggested approach: Express + React
Complexity: small
---END SPEC---`,
                        `Updated spec based on your feedback.
---SPEC---
Name: Test Idea v2
Summary: A better test
Requirements:
  [MUST] [core] Core-Feature: The main feature
  [SHOULD] [ui] Nice-UI: A nice interface
Assumptions: Node.js; TypeScript
Out of scope: Mobile
Suggested approach: Express + React with TypeScript
Complexity: medium
---END SPEC---

SPEC READY FOR APPROVAL`,
                ]);
                service = new RefinementService({
                        aiService: mockAI,
                        workspacePath: '/test/workspace',
                });
                service.onEvent((e: any) => events.push(e));
        });

        it('starts refinement and emits events', async () => {
                const response = await service.startRefinement('I want a test feature');

                expect(response).to.include('Test Idea');
                expect(service.state.phase).to.equal('clarifying');
                expect(service.getSpec()).to.not.be.null;
                expect(service.getSpec()!.name).to.equal('Test Idea');

                // Check events
                expect(events.some(e => e.type === 'refinement_started')).to.be.true;
                expect(events.some(e => e.type === 'spec_updated')).to.be.true;
                expect(events.some(e => e.type === 'refinement_round')).to.be.true;
        });

        it('continues refinement and updates spec', async () => {
                await service.startRefinement('I want a test feature');
                const response = await service.continueRefinement('I also want a nice UI');

                expect(response).to.include('SPEC READY FOR APPROVAL');
                expect(service.state.phase).to.equal('finalizing');
                expect(service.getSpec()!.requirements).to.have.length(2);
        });

        it('approves spec and completes', async () => {
                await service.startRefinement('I want a test feature');
                await service.continueRefinement('Also add UI');
                const spec = service.approveSpec();

                expect(spec.name).to.include('Test Idea');
                expect(service.state.approved).to.be.true;
                expect(service.state.phase).to.equal('complete');
                expect(service.isComplete).to.be.true;
                expect(events.some(e => e.type === 'spec_approved')).to.be.true;
        });

        it('rejects spec and allows re-refinement', async () => {
                await service.startRefinement('I want a test feature');
                service.rejectSpec('Need more detail on the core feature');

                expect(service.state.approved).to.be.false;
                expect(service.state.phase).to.equal('clarifying');
        });

        it('throws when approving without spec', () => {
                expect(() => service.approveSpec()).to.throw('No spec to approve');
        });

        it('throws when continuing after approval', async () => {
                await service.startRefinement('test');
                await service.continueRefinement('more');
                service.approveSpec();

                try {
                        await service.continueRefinement('should fail');
                        expect.fail('Should have thrown');
                } catch (err) {
                        expect((err as Error).message).to.include('already approved');
                }
        });

        it('resets state correctly', async () => {
                await service.startRefinement('test');
                service.reset();

                expect(service.state.phase).to.equal('gathering');
                expect(service.getSpec()).to.be.null;
                expect(service.state.rounds).to.equal(0);
        });

        it('setSpec sets the spec directly', () => {
                const spec = {
                        id: 'spec-test',
                        name: 'Direct Spec',
                        summary: 'Set directly',
                        rawIdea: 'test',
                        requirements: [],
                        assumptions: [],
                        outOfScope: [],
                        suggestedApproach: '',
                        complexity: 'small' as const,
                        estimatedCredits: 50,
                        createdAt: Date.now(),
                        version: 1,
                };
                service.setSpec(spec);
                expect(service.getSpec()).to.equal(spec);
                expect(service.state.phase).to.equal('clarifying');
        });
});
