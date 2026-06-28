/**
 * Tests for modelRouting.ts — model routing by purpose.
 */
import { expect } from 'chai';
import {
        routeModel,
        getRoutingPriority,
        getDefaultRoutes,
        isPurposeSupported,
        type IModelRoute,
} from '../../../src/llm/modelRouting';

describe('modelRouting', () => {
        describe('routeModel()', () => {
                it('returns a model for agent_plan + anthropic', () => {
                        const model = routeModel('agent_plan', 'anthropic');
                        expect(model).to.equal('claude-sonnet-4-20250514');
                });

                it('returns a model for autocomplete + anthropic (should be haiku)', () => {
                        const model = routeModel('autocomplete', 'anthropic');
                        expect(model).to.equal('claude-haiku-4-20250514');
                });

                it('returns a model for agent_execute + nvidia-nim', () => {
                        const model = routeModel('agent_execute', 'nvidia-nim');
                        expect(model).to.include('llama-3.1-405b');
                });

                it('returns a model for autocomplete + nvidia-nim (should be 8b)', () => {
                        const model = routeModel('autocomplete', 'nvidia-nim');
                        expect(model).to.include('llama-3.1-8b');
                });

                it('returns a model for agent_plan + openrouter', () => {
                        const model = routeModel('agent_plan', 'openrouter');
                        expect(model).to.equal('anthropic/claude-sonnet-4');
                });

                it('returns a model for autocomplete + openrouter (should be haiku)', () => {
                        const model = routeModel('autocomplete', 'openrouter');
                        expect(model).to.equal('anthropic/claude-haiku-4');
                });

                it('returns undefined for embedding + anthropic (not supported)', () => {
                        const model = routeModel('embedding', 'anthropic');
                        expect(model).to.be.undefined;
                });

                it('returns a model for embedding + nvidia-nim', () => {
                        const model = routeModel('embedding', 'nvidia-nim');
                        expect(model).to.equal('nomic-embed-text');
                });

                it('returns undefined for unknown provider', () => {
                        const model = routeModel('chat', 'unknown-provider');
                        expect(model).to.be.undefined;
                });

                it('respects custom routes over defaults', () => {
                        const customRoutes: IModelRoute[] = [
                                {
                                        purpose: 'chat',
                                        provider: 'anthropic',
                                        model: 'claude-opus-4-20250514',
                                        priority: 'quality',
                                },
                        ];
                        const model = routeModel('chat', 'anthropic', customRoutes);
                        expect(model).to.equal('claude-opus-4-20250514');
                });

                it('falls back to defaults when custom route does not match', () => {
                        const customRoutes: IModelRoute[] = [
                                {
                                        purpose: 'chat',
                                        provider: 'other-provider',
                                        model: 'custom-model',
                                        priority: 'cost',
                                },
                        ];
                        const model = routeModel('chat', 'anthropic', customRoutes);
                        expect(model).to.equal('claude-sonnet-4-20250514');
                });

                it('supports the refinement purpose (Idea Refinement Mode)', () => {
                        const model = routeModel('refinement', 'anthropic');
                        expect(model).to.be.a('string');
                        expect(model).to.include('claude');
                });
        });

        describe('getRoutingPriority()', () => {
                it('returns speed for autocomplete', () => {
                        expect(getRoutingPriority('autocomplete')).to.equal('speed');
                });

                it('returns speed for inline_edit', () => {
                        expect(getRoutingPriority('inline_edit')).to.equal('speed');
                });

                it('returns quality for agent_plan', () => {
                        expect(getRoutingPriority('agent_plan')).to.equal('quality');
                });

                it('returns quality for agent_execute', () => {
                        expect(getRoutingPriority('agent_execute')).to.equal('quality');
                });

                it('returns quality for verification', () => {
                        expect(getRoutingPriority('verification')).to.equal('quality');
                });

                it('returns cost for chat', () => {
                        expect(getRoutingPriority('chat')).to.equal('cost');
                });

                it('returns cost for embedding', () => {
                        expect(getRoutingPriority('embedding')).to.equal('cost');
                });
        });

        describe('getDefaultRoutes()', () => {
                it('returns a non-empty array', () => {
                        const routes = getDefaultRoutes();
                        expect(routes.length).to.be.greaterThan(0);
                });

                it('includes routes for all three providers', () => {
                        const routes = getDefaultRoutes();
                        const providers = new Set(routes.map(r => r.provider));
                        expect(providers.has('anthropic')).to.be.true;
                        expect(providers.has('nvidia-nim')).to.be.true;
                        expect(providers.has('openrouter')).to.be.true;
                });
        });

        describe('isPurposeSupported()', () => {
                it('returns true for supported combinations', () => {
                        expect(isPurposeSupported('chat', 'anthropic')).to.be.true;
                        expect(isPurposeSupported('agent_plan', 'openrouter')).to.be.true;
                });

                it('returns false for unsupported combinations', () => {
                        expect(isPurposeSupported('embedding', 'anthropic')).to.be.false;
                        expect(isPurposeSupported('embedding', 'openrouter')).to.be.false;
                });
        });
});
