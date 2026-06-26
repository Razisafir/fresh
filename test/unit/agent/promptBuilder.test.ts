/**
 * Unit tests for src/agent/promptBuilder.ts (system prompt assembly).
 *
 * The system prompt is preserved verbatim from the old repo because it
 * represents hundreds of hours of prompt-engineering iteration. The
 * "Iron Law" of verification, the Karpathy four principles, and the
 * Common Failures table are all preserved exactly.
 *
 * These tests pin the structural invariants — they don't pin the exact
 * prompt text (which would be brittle). They verify:
 *   - The task is included.
 *   - The workspace path is included.
 *   - The current date is included.
 *   - planningOnly flag toggles the read-only guidance.
 *   - extraContext is appended when provided.
 *   - The "Iron Law" phrase is present (the differentiator).
 */

import { expect } from 'chai';
import { buildSystemPrompt } from '../../../src/agent/promptBuilder';

describe('promptBuilder', () => {
	describe('buildSystemPrompt()', () => {
		it('includes the task description', () => {
			const prompt = buildSystemPrompt({
				task: 'Add a login page',
				planningOnly: false,
				workspacePath: '/workspace',
			});
			expect(prompt).to.contain('Add a login page');
			expect(prompt).to.contain('Task: Add a login page');
		});

		it('includes the workspace path', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/home/user/project',
			});
			expect(prompt).to.contain('/home/user/project');
			expect(prompt).to.contain('Working directory: /home/user/project');
		});

		it('includes the current date (ISO YYYY-MM-DD)', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/workspace',
			});
			const today = new Date().toISOString().split('T')[0];
			expect(prompt).to.contain(`Current date: ${today}`);
		});

		it('includes "Iron Law" of verification (the differentiator)', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/workspace',
			});
			expect(prompt).to.contain('Iron Law');
			expect(prompt).to.contain('NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE');
		});

		it('includes the Karpathy four principles', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/workspace',
			});
			expect(prompt).to.contain('Think Before Coding');
			expect(prompt).to.contain('Simplicity First');
			expect(prompt).to.contain('Surgical Changes');
			expect(prompt).to.contain('Goal-Driven Execution');
		});

		it('includes the Common Failures table', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/workspace',
			});
			expect(prompt).to.contain('Common Failures');
			expect(prompt).to.contain('Tests pass');
			expect(prompt).to.contain('Build succeeds');
			expect(prompt).to.contain('Bug fixed');
		});

		it('includes PLANNING MODE guidance when planningOnly=true', () => {
			const prompt = buildSystemPrompt({
				task: 'explore',
				planningOnly: true,
				workspacePath: '/workspace',
			});
			expect(prompt).to.contain('PLANNING MODE');
			expect(prompt).to.contain('read_file and list_directory');
			expect(prompt).to.contain('Do NOT make any changes');
		});

		it('omits PLANNING MODE guidance when planningOnly=false', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/workspace',
			});
			expect(prompt).to.not.contain('PLANNING MODE');
		});

		it('appends extraContext when provided', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/workspace',
				extraContext: 'Remember: this project uses TypeScript strict mode.',
			});
			expect(prompt).to.contain('[Extra Context]');
			expect(prompt).to.contain('Remember: this project uses TypeScript strict mode.');
		});

		it('does NOT append extraContext section when extraContext is empty', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/workspace',
				extraContext: '',
			});
			expect(prompt).to.not.contain('[Extra Context]');
		});

		it('does NOT append extraContext section when extraContext is whitespace-only', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/workspace',
				extraContext: '   \n\t  ',
			});
			expect(prompt).to.not.contain('[Extra Context]');
		});

		it('does NOT append extraContext section when extraContext is undefined', () => {
			const prompt = buildSystemPrompt({
				task: 'do something',
				planningOnly: false,
				workspacePath: '/workspace',
			});
			expect(prompt).to.not.contain('[Extra Context]');
		});
	});
});
