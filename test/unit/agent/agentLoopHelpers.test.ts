/**
 * Unit tests for src/agent/agentLoopHelpers.ts (pure helpers extracted from agent loop).
 *
 * These helpers were extracted from the old repo's 1,946-line agentLoop.ts
 * to make them unit-testable. They cover:
 *
 *   - mapToolToActionType: tool name → CreditActionType for billing.
 *   - checkCostGate: emergency-mode + low-credits-recommendation logic.
 *   - applyCommandSanity: hallucinated-success detector. Phase 4 fix
 *     includes Warning in the suspicious filter (previously only
 *     Critical/Fail triggered).
 *   - consumeCreditsForToolCall: failed calls don't consume credits;
 *     successful calls consume exactly 1.
 */

import { expect } from 'chai';
import {
	mapToolToActionType,
	checkCostGate,
	applyCommandSanity,
	consumeCreditsForToolCall,
	CreditActionType,
	ICreditSystem,
	ICostGovernor,
	IExecutionSanityService,
	ILogger,
	SanitySeverity,
} from '../../../src/agent/agentLoopHelpers';

// --- Test stubs -------------------------------------------------------------

const stubLogger: ILogger = {
	info(_msg: string) { /* swallow */ },
	warn(_msg: string) { /* swallow */ },
};

const capturedLogs: string[] = [];
const capturingLogger: ILogger = {
	info(msg: string) { capturedLogs.push(`[INFO] ${msg}`); },
	warn(msg: string) { capturedLogs.push(`[WARN] ${msg}`); },
};

function makeCostGovernor(opts: { emergency?: boolean; autoSwitch?: boolean; cheaperModel?: string }): ICostGovernor {
	return {
		isEmergencyMode: () => !!opts.emergency,
		shouldAutoSwitchModel: () => !!opts.autoSwitch,
		getCheaperModel: (_current: string) => opts.cheaperModel,
	};
}

function makeCreditSystem(opts: { remaining?: number; consumeResult?: boolean; throwOnConsume?: boolean }): ICreditSystem & { consumeCalls: Array<{ amount: number; actionType: CreditActionType }> } {
	const calls: Array<{ amount: number; actionType: CreditActionType }> = [];
	const sys: ICreditSystem & { consumeCalls: typeof calls } = {
		getCreditsRemaining: () => opts.remaining ?? 0,
		consumeCredits(amount, actionType) {
			calls.push({ amount, actionType });
			if (opts.throwOnConsume) {
				throw new Error('consumeCredits mock threw');
			}
			return opts.consumeResult ?? true;
		},
		consumeCalls: calls,
	};
	return sys;
}

function makeSanityService(results: Array<{ severity: SanitySeverity; checkName: string; message: string; suggestedAction?: string }>): IExecutionSanityService {
	return {
		validateCommandResult: () => results,
	};
}

// --- Tests ------------------------------------------------------------------

describe('agentLoopHelpers', () => {
	beforeEach(() => {
		capturedLogs.length = 0;
	});

	describe('mapToolToActionType()', () => {
		it('maps write_file → file_edit', () => {
			expect(mapToolToActionType('write_file')).to.equal('file_edit');
		});

		it('maps edit_file → file_edit', () => {
			expect(mapToolToActionType('edit_file')).to.equal('file_edit');
		});

		it('maps run_command → terminal_command', () => {
			expect(mapToolToActionType('run_command')).to.equal('terminal_command');
		});

		it('maps web_search → browser_action', () => {
			expect(mapToolToActionType('web_search')).to.equal('browser_action');
		});

		it('maps search_codebase → tool_call', () => {
			expect(mapToolToActionType('search_codebase')).to.equal('tool_call');
		});

		it('maps unknown tools (including MCP serverName__toolName) → tool_call', () => {
			expect(mapToolToActionType('filesystem__read_file')).to.equal('tool_call');
			expect(mapToolToActionType('arbitrary_unknown_tool')).to.equal('tool_call');
		});
	});

	describe('checkCostGate()', () => {
		it('allows when cost governor is not in emergency mode', () => {
			const gov = makeCostGovernor({ emergency: false });
			const credits = makeCreditSystem({ remaining: 100 });
			const result = checkCostGate(gov, credits, stubLogger);
			expect(result.allowed).to.be.true;
			expect(result.reason).to.equal('');
		});

		it('blocks when cost governor is in emergency mode', () => {
			const gov = makeCostGovernor({ emergency: true });
			const credits = makeCreditSystem({ remaining: 5 });
			const result = checkCostGate(gov, credits, stubLogger);
			expect(result.allowed).to.be.false;
			expect(result.reason).to.contain('5 credits');
			expect(result.reason).to.contain('emergency stop');
		});

		it('logs a recommendation when shouldAutoSwitchModel is true and a cheaper model exists', () => {
			const gov = makeCostGovernor({ autoSwitch: true, cheaperModel: 'claude-haiku' });
			const credits = makeCreditSystem({ remaining: 50 });
			checkCostGate(gov, credits, capturingLogger);
			expect(capturedLogs.some(l => l.includes('claude-haiku'))).to.be.true;
		});

		it('does not log a recommendation when no cheaper model is available', () => {
			const gov = makeCostGovernor({ autoSwitch: true, cheaperModel: undefined });
			const credits = makeCreditSystem({ remaining: 50 });
			checkCostGate(gov, credits, capturingLogger);
			expect(capturedLogs.some(l => l.includes('Consider switching'))).to.be.false;
		});

		it('does not log a recommendation when shouldAutoSwitchModel is false', () => {
			const gov = makeCostGovernor({ autoSwitch: false, cheaperModel: 'claude-haiku' });
			const credits = makeCreditSystem({ remaining: 50 });
			checkCostGate(gov, credits, capturingLogger);
			expect(capturedLogs.some(l => l.includes('Consider switching'))).to.be.false;
		});
	});

	describe('applyCommandSanity() — Phase 4 fix (Warning now triggers suspicious)', () => {
		it('returns original output when no findings', () => {
			const sanity = makeSanityService([]);
			const result = applyCommandSanity(sanity, stubLogger, 'ls', 0, 'file.ts\nother.ts', '');
			expect(result.suspicious).to.be.false;
			expect(result.output).to.equal('file.ts\nother.ts');
		});

		it('marks suspicious when Warning finding is present (Phase 4 fix)', () => {
			const sanity = makeSanityService([
				{ severity: SanitySeverity.Warning, checkName: 'empty-output', message: 'Exit 0 but no stdout' },
			]);
			const result = applyCommandSanity(sanity, stubLogger, 'ls', 0, '', '');
			expect(result.suspicious).to.be.true;
			expect(result.output).to.contain('Execution Sanity Findings');
			expect(result.output).to.contain('empty-output');
			expect(result.output).to.contain('Re-plan based on the actual output');
		});

		it('marks suspicious when Critical finding is present', () => {
			const sanity = makeSanityService([
				{ severity: SanitySeverity.Critical, checkName: 'segfault', message: 'Process dumped core' },
			]);
			const result = applyCommandSanity(sanity, stubLogger, 'node bad.js', 139, '', 'Segmentation fault');
			expect(result.suspicious).to.be.true;
			expect(result.output).to.contain('segfault');
		});

		it('marks suspicious when Fail finding is present', () => {
			const sanity = makeSanityService([
				{ severity: SanitySeverity.Fail, checkName: 'nonzero-exit', message: 'Exit code 1' },
			]);
			const result = applyCommandSanity(sanity, stubLogger, 'npm test', 1, '', 'FAIL src/test.ts');
			expect(result.suspicious).to.be.true;
		});

		it('appends ALL findings to the output (Phase 4: maximum signal to the LLM)', () => {
			const sanity = makeSanityService([
				{ severity: SanitySeverity.Warning, checkName: 'warn-1', message: 'a warning' },
				{ severity: SanitySeverity.Critical, checkName: 'crit-1', message: 'a critical', suggestedAction: 're-plan' },
			]);
			const result = applyCommandSanity(sanity, stubLogger, 'cmd', 0, 'out', 'err');
			expect(result.output).to.contain('warn-1');
			expect(result.output).to.contain('crit-1');
			expect(result.output).to.contain('re-plan');
		});

		it('logs a warning when sanity findings are suspicious', () => {
			const sanity = makeSanityService([
				{ severity: SanitySeverity.Critical, checkName: 'crit', message: 'critical issue' },
			]);
			applyCommandSanity(sanity, capturingLogger, 'cmd', 1, '', '');
			expect(capturedLogs.some(l => l.includes('Suspicious command output'))).to.be.true;
		});

		it('catches exceptions from validateCommandResult and falls through (never blocks tool execution)', () => {
			const sanity: IExecutionSanityService = {
				validateCommandResult: () => { throw new Error('sanity service crashed'); },
			};
			const result = applyCommandSanity(sanity, capturingLogger, 'cmd', 0, 'out', 'err');
			expect(result.suspicious).to.be.false;
			expect(result.output).to.equal('out\nerr');
			expect(capturedLogs.some(l => l.includes('validateCommandResult threw'))).to.be.true;
		});
	});

	describe('consumeCreditsForToolCall()', () => {
		it('does NOT consume credits when success=false', () => {
			const credits = makeCreditSystem({ consumeResult: true });
			const result = consumeCreditsForToolCall(credits, stubLogger, 'write_file', false, 'session-1');
			expect(result).to.be.false;
			expect(credits.consumeCalls).to.have.lengthOf(0);
		});

		it('consumes 1 credit on successful write_file call', () => {
			const credits = makeCreditSystem({ consumeResult: true });
			const result = consumeCreditsForToolCall(credits, stubLogger, 'write_file', true, 'session-1');
			expect(result).to.be.true;
			expect(credits.consumeCalls).to.have.lengthOf(1);
			expect(credits.consumeCalls[0].amount).to.equal(1);
			expect(credits.consumeCalls[0].actionType).to.equal('file_edit');
		});

		it('consumes 1 credit on successful run_command call (actionType: terminal_command)', () => {
			const credits = makeCreditSystem({ consumeResult: true });
			consumeCreditsForToolCall(credits, stubLogger, 'run_command', true, 'session-1');
			expect(credits.consumeCalls[0].actionType).to.equal('terminal_command');
		});

		it('returns false + logs warning when consumeCredits returns false (insufficient credits)', () => {
			const credits = makeCreditSystem({ consumeResult: false });
			const result = consumeCreditsForToolCall(credits, capturingLogger, 'write_file', true, 'session-1');
			expect(result).to.be.false;
			expect(capturedLogs.some(l => l.includes('consumeCredits returned false'))).to.be.true;
		});

		it('returns false + logs warning when consumeCredits throws (fire-and-forget)', () => {
			const credits = makeCreditSystem({ throwOnConsume: true });
			const result = consumeCreditsForToolCall(credits, capturingLogger, 'write_file', true, 'session-1');
			expect(result).to.be.false;
			expect(capturedLogs.some(l => l.includes('consumeCredits threw'))).to.be.true;
		});
	});
});
