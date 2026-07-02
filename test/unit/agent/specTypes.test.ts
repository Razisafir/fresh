/**
 * specTypes.test.ts — Unit tests for spec type definitions and validation.
 *
 * Tests the IStructuredSpec, IPreFlightConfig, and related types
 * to ensure they compile and validate correctly.
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { IStructuredSpec, ISpecRequirement, IRefinementState, IPreFlightConfig, PipelineEvent, AgentMode } from '../../../src/types/spec';

describe('IStructuredSpec', () => {
        it('creates a valid spec object', () => {
                const spec: IStructuredSpec = {
                        id: 'spec-1',
                        name: 'Test Feature',
                        summary: 'A test feature for validation',
                        rawIdea: 'I want a test feature',
                        requirements: [
                                {
                                        id: 'req-1',
                                        label: 'Core',
                                        description: 'Core functionality must work',
                                        priority: 'must',
                                        category: 'core',
                                        satisfied: false,
                                },
                                {
                                        id: 'req-2',
                                        label: 'Nice-to-have',
                                        description: 'Optional enhancement',
                                        priority: 'could',
                                        category: 'ui',
                                        satisfied: false,
                                },
                        ],
                        assumptions: ['Node.js runtime available'],
                        outOfScope: ['Mobile native app'],
                        suggestedApproach: 'Express backend with React frontend',
                        complexity: 'medium',
                        estimatedCredits: 150,
                        createdAt: Date.now(),
                        version: 1,
                };

                expect(spec.id).to.equal('spec-1');
                expect(spec.requirements).to.have.length(2);
                expect(spec.requirements[0].priority).to.equal('must');
                expect(spec.complexity).to.equal('medium');
        });

        it('supports all priority levels', () => {
                const priorities: ISpecRequirement['priority'][] = ['must', 'should', 'could'];
                expect(priorities).to.have.length(3);
        });

        it('supports all complexity levels', () => {
                const complexities: IStructuredSpec['complexity'][] = ['small', 'medium', 'large'];
                expect(complexities).to.have.length(3);
        });
});

describe('IRefinementState', () => {
        it('creates a valid state object', () => {
                const state: IRefinementState = {
                        phase: 'gathering',
                        exploredAreas: [],
                        openQuestions: ['What is the target audience?'],
                        rounds: 0,
                        spec: null,
                        approved: false,
                };

                expect(state.phase).to.equal('gathering');
                expect(state.spec).to.be.null;
        });

        it('supports all phase values', () => {
                const phases: IRefinementState['phase'][] = ['gathering', 'clarifying', 'structuring', 'finalizing', 'complete'];
                expect(phases).to.have.length(5);
        });
});

describe('IPreFlightConfig', () => {
        it('creates a valid pre-flight config', () => {
                const config: IPreFlightConfig = {
                        executionMode: 'major_milestone',
                        creditLimit: 200,
                        verifyAfterMilestone: true,
                        allowSwarm: true,
                        maxWorkers: 4,
                        selectedMilestoneIds: ['m1', 'm3'],
                };

                expect(config.executionMode).to.equal('major_milestone');
                expect(config.creditLimit).to.equal(200);
                expect(config.allowSwarm).to.be.true;
        });

        it('supports all execution modes', () => {
                const modes: IPreFlightConfig['executionMode'][] = ['every_milestone', 'major_milestone', 'selective', 'full_auto'];
                expect(modes).to.have.length(4);
        });
});

describe('AgentMode', () => {
        it('supports chat, plan, and refine modes', () => {
                const modes: AgentMode[] = ['chat', 'plan', 'refine'];
                expect(modes).to.have.length(3);
        });
});

describe('PipelineEvent', () => {
        it('supports refinement events', () => {
                const event: PipelineEvent = { type: 'refinement_started', rawIdea: 'test idea' };
                expect(event.type).to.equal('refinement_started');
        });

        it('supports spec approval events', () => {
                const spec: IStructuredSpec = {
                        id: 'spec-1',
                        name: 'Test',
                        summary: 'Test',
                        rawIdea: 'test',
                        requirements: [],
                        assumptions: [],
                        outOfScope: [],
                        suggestedApproach: '',
                        complexity: 'small',
                        estimatedCredits: 50,
                        createdAt: Date.now(),
                        version: 1,
                };
                const event: PipelineEvent = { type: 'spec_approved', spec };
                expect(event.type).to.equal('spec_approved');
        });

        it('supports execution progress events', () => {
                const event: PipelineEvent = {
                        type: 'milestone_progress',
                        completedMilestones: 2,
                        totalMilestones: 5,
                        currentMilestone: 'Setup',
                };
                expect(event.type).to.equal('milestone_progress');
        });

        it('supports swarm events', () => {
                const event: PipelineEvent = {
                        type: 'swarm_worker_update',
                        agentId: 'worker-1',
                        agentName: 'Worker 1',
                        status: 'running',
                };
                expect(event.type).to.equal('swarm_worker_update');
        });

        it('supports completion events', () => {
                const spec: IStructuredSpec = {
                        id: 'spec-1',
                        name: 'Test',
                        summary: 'Test',
                        rawIdea: 'test',
                        requirements: [],
                        assumptions: [],
                        outOfScope: [],
                        suggestedApproach: '',
                        complexity: 'small',
                        estimatedCredits: 50,
                        createdAt: Date.now(),
                        version: 1,
                };
                const event: PipelineEvent = {
                        type: 'execution_complete',
                        spec,
                        allRequirementsMet: true,
                };
                expect(event.type).to.equal('execution_complete');
        });

        it('supports v2 prompt events', () => {
                const event: PipelineEvent = {
                        type: 'v2_prompt',
                        spec: {
                                id: 'spec-1',
                                name: 'Test',
                                summary: 'Test',
                                rawIdea: 'test',
                                requirements: [
                                        { id: 'req-1', label: 'Core', description: 'Core feature', priority: 'must', category: 'core', satisfied: false },
                                ],
                                assumptions: [],
                                outOfScope: [],
                                suggestedApproach: '',
                                complexity: 'small',
                                estimatedCredits: 50,
                                createdAt: Date.now(),
                                version: 1,
                        },
                        unsatisfiedRequirements: [
                                { id: 'req-1', label: 'Core', description: 'Core feature', priority: 'must', category: 'core', satisfied: false },
                        ],
                };
                expect(event.type).to.equal('v2_prompt');
        });
});
