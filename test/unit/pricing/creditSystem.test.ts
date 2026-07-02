/**
 * Tests for the pricing module (Cost Governor + Credit System).
 */
import { expect } from 'chai';
import {
        CreditSystemService,
        CostGovernorService,
        type ICostGovernor,
} from '../../../src/pricing/creditSystem';
import {
        type ICreditBudget,
        BudgetExceededError,
} from '../../../src/pricing/pricingTypes';

/** Helper: create a consistent budget for testing. */
function testBudget(overrides: Partial<ICreditBudget> = {}): ICreditBudget {
        return {
                maxCreditsPerTask: 1000,
                warningThresholdPercent: 20,
                emergencyStopThreshold: 10,
                enabled: true,
                ...overrides,
        };
}

describe('pricing module', () => {
        describe('CreditSystemService', () => {
                it('starts with full credits remaining', () => {
                        const svc = new CreditSystemService(testBudget({ maxCreditsPerTask: 100 }));
                        expect(svc.getCreditsRemaining()).to.equal(100);
                });

                it('consumes credits and tracks usage', () => {
                        const svc = new CreditSystemService(testBudget({ maxCreditsPerTask: 100 }));
                        const result = svc.consumeCredits(1, 'tool_call', { description: 'Test call' });
                        expect(result).to.be.true;
                        expect(svc.getCreditsUsed()).to.equal(1);
                        expect(svc.getCreditsRemaining()).to.equal(99);
                });

                it('returns false when insufficient credits (canAfford)', () => {
                        const svc = new CreditSystemService(testBudget({ maxCreditsPerTask: 100, emergencyStopThreshold: 5 }));
                        // Consume 90 credits (leaves 10, well above emergency threshold)
                        for (let i = 0; i < 90; i++) {
                                svc.consumeCredits(1, 'tool_call');
                        }
                        // Can afford small amounts but not more than remaining
                        expect(svc.canAfford(10)).to.be.true;
                        expect(svc.canAfford(11)).to.be.false;
                });

                it('throws BudgetExceededError at emergency stop threshold', () => {
                        const svc = new CreditSystemService(testBudget({ maxCreditsPerTask: 20, emergencyStopThreshold: 5 }));
                        // Consume 14 credits (leaves 6, above threshold of 5)
                        for (let i = 0; i < 14; i++) {
                                svc.consumeCredits(1, 'tool_call');
                        }
                        // Next consumption brings remaining to 5 which is <= threshold → throws
                        expect(() => svc.consumeCredits(1, 'llm_call')).to.throw(BudgetExceededError);
                });

                it('canAfford() returns true when credits are sufficient', () => {
                        const svc = new CreditSystemService(testBudget({ maxCreditsPerTask: 100 }));
                        expect(svc.canAfford(50)).to.be.true;
                        expect(svc.canAfford(100)).to.be.true;
                        expect(svc.canAfford(101)).to.be.false;
                });

                it('tracks usage history', () => {
                        const svc = new CreditSystemService(testBudget({ maxCreditsPerTask: 100 }));
                        svc.consumeCredits(1, 'file_edit', { description: 'Edit file' });
                        svc.consumeCredits(1, 'terminal_command', { description: 'Run command' });
                        const history = svc.getUsageHistory();
                        expect(history.length).to.equal(2);
                        expect(history[0].actionType).to.equal('file_edit');
                        expect(history[1].actionType).to.equal('terminal_command');
                });

                it('limits usage history with limit parameter', () => {
                        const svc = new CreditSystemService(testBudget({ maxCreditsPerTask: 100 }));
                        for (let i = 0; i < 10; i++) {
                                svc.consumeCredits(1, 'tool_call');
                        }
                        const history = svc.getUsageHistory(3);
                        expect(history.length).to.equal(3);
                });

                it('resets session credits', () => {
                        const svc = new CreditSystemService(testBudget({ maxCreditsPerTask: 100 }));
                        svc.consumeCredits(50, 'tool_call');
                        expect(svc.getCreditsUsed()).to.equal(50);
                        svc.resetSession();
                        expect(svc.getCreditsUsed()).to.equal(0);
                        expect(svc.getCreditsRemaining()).to.equal(100);
                });

                it('allows all consumption when budget is disabled', () => {
                        const svc = new CreditSystemService(testBudget({ enabled: false }));
                        for (let i = 0; i < 1000; i++) {
                                const result = svc.consumeCredits(1, 'tool_call');
                                expect(result).to.be.true;
                        }
                });
        });

        describe('CostGovernorService', () => {
                function makeGovernor(maxCredits: number, used: number): ICostGovernor {
                        const budget = testBudget({ maxCreditsPerTask: maxCredits, emergencyStopThreshold: Math.max(1, Math.floor(maxCredits * 0.1)) });
                        const svc = new CreditSystemService(budget);
                        try {
                                for (let i = 0; i < used; i++) {
                                        svc.consumeCredits(1, 'tool_call');
                                }
                        } catch (e) {
                                if (!(e instanceof BudgetExceededError)) throw e;
                        }
                        return new CostGovernorService(svc);
                }

                it('is not in emergency mode when credits are high', () => {
                        const gov = makeGovernor(100, 5);
                        expect(gov.isEmergencyMode()).to.be.false;
                });

                it('enters emergency mode when credits drop below threshold', () => {
                        const gov = makeGovernor(100, 92); // 8 remaining, threshold is 10
                        expect(gov.isEmergencyMode()).to.be.true;
                });

                it('recommends auto-switch when credits are below 20%', () => {
                        const gov = makeGovernor(100, 85); // 15 remaining = 15%
                        expect(gov.shouldAutoSwitchModel()).to.be.true;
                });

                it('does not recommend auto-switch when credits are above 20%', () => {
                        const gov = makeGovernor(100, 70); // 30 remaining = 30%
                        expect(gov.shouldAutoSwitchModel()).to.be.false;
                });

                it('suggests cheaper model for known premium models', () => {
                        const gov = makeGovernor(100, 0);
                        expect(gov.getCheaperModel('claude-sonnet-4-20250514')).to.equal('claude-haiku-4-20250514');
                        expect(gov.getCheaperModel('anthropic/claude-sonnet-4')).to.equal('anthropic/claude-haiku-4');
                });

                it('returns undefined for models without a cheaper alternative', () => {
                        const gov = makeGovernor(100, 0);
                        expect(gov.getCheaperModel('claude-haiku-4-20250514')).to.be.undefined;
                });

                it('allows all actions when not in emergency mode', () => {
                        const gov = makeGovernor(100, 5);
                        expect(gov.isActionAllowed('llm_call')).to.be.true;
                        expect(gov.isActionAllowed('file_edit')).to.be.true;
                });

                it('blocks LLM calls in emergency mode but allows other actions', () => {
                        const gov = makeGovernor(100, 92); // emergency mode
                        expect(gov.isActionAllowed('llm_call')).to.be.false;
                        expect(gov.isActionAllowed('file_edit')).to.be.true;
                });
        });

        describe('BudgetExceededError', () => {
                it('contains credits remaining and budget info', () => {
                        const budget = testBudget({ maxCreditsPerTask: 100 });
                        const err = new BudgetExceededError(8, budget);
                        expect(err.name).to.equal('BudgetExceededError');
                        expect(err.creditsRemaining).to.equal(8);
                        expect(err.budget).to.equal(budget);
                        expect(err.message).to.include('8 credits remaining');
                        expect(err.message).to.include('Emergency stop threshold is 10');
                });

                it('can be caught specifically with instanceof', () => {
                        const budget = testBudget({ maxCreditsPerTask: 100 });
                        const err = new BudgetExceededError(5, budget);
                        expect(err).to.be.instanceOf(BudgetExceededError);
                        expect(err).to.be.instanceOf(Error);
                });
        });
});
