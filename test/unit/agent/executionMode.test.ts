/**
 * Unit tests for src/agent/executionMode.ts (execution mode enum + configs).
 *
 * These tests pin the enum values (they're persisted in user settings, so
 * changing them would silently break existing users' configs) and the
 * display configs (the UI picks these up for the mode picker).
 */

import { expect } from 'chai';
import {
	ExecutionMode,
	DEFAULT_EXECUTION_MODE_CONFIGS,
	IExecutionModeConfig,
} from '../../../src/agent/executionMode';

describe('executionMode', () => {
	describe('ExecutionMode enum values', () => {
		it('EveryMilestone = "every_milestone"', () => {
			expect(ExecutionMode.EveryMilestone).to.equal('every_milestone');
		});

		it('MajorMilestone = "major_milestone"', () => {
			expect(ExecutionMode.MajorMilestone).to.equal('major_milestone');
		});

		it('Selective = "selective"', () => {
			expect(ExecutionMode.Selective).to.equal('selective');
		});

		it('FullAuto = "full_auto"', () => {
			expect(ExecutionMode.FullAuto).to.equal('full_auto');
		});
	});

	describe('DEFAULT_EXECUTION_MODE_CONFIGS', () => {
		it('has a config for every enum value', () => {
			for (const mode of Object.values(ExecutionMode)) {
				expect(DEFAULT_EXECUTION_MODE_CONFIGS[mode as ExecutionMode]).to.exist;
			}
		});

		it('EveryMilestone config: pausesAtMilestones=true, showsMilestonePicker=false', () => {
			const cfg = DEFAULT_EXECUTION_MODE_CONFIGS[ExecutionMode.EveryMilestone];
			expect(cfg.pausesAtMilestones).to.be.true;
			expect(cfg.showsMilestonePicker).to.be.false;
			expect(cfg.label).to.equal('Every Milestone');
		});

		it('MajorMilestone config: pausesAtMilestones=true, showsMilestonePicker=false', () => {
			const cfg = DEFAULT_EXECUTION_MODE_CONFIGS[ExecutionMode.MajorMilestone];
			expect(cfg.pausesAtMilestones).to.be.true;
			expect(cfg.showsMilestonePicker).to.be.false;
			expect(cfg.label).to.equal('Major Milestones');
		});

		it('Selective config: pausesAtMilestones=true, showsMilestonePicker=true', () => {
			const cfg = DEFAULT_EXECUTION_MODE_CONFIGS[ExecutionMode.Selective];
			expect(cfg.pausesAtMilestones).to.be.true;
			expect(cfg.showsMilestonePicker).to.be.true;
		});

		it('FullAuto config: pausesAtMilestones=false, showsMilestonePicker=false', () => {
			const cfg = DEFAULT_EXECUTION_MODE_CONFIGS[ExecutionMode.FullAuto];
			expect(cfg.pausesAtMilestones).to.be.false;
			expect(cfg.showsMilestonePicker).to.be.false;
		});

		it('every config has a non-empty label, description, icon, and mode self-reference', () => {
			for (const mode of Object.values(ExecutionMode)) {
				const cfg: IExecutionModeConfig = DEFAULT_EXECUTION_MODE_CONFIGS[mode as ExecutionMode];
				expect(cfg.label).to.be.a('string').and.not.empty;
				expect(cfg.description).to.be.a('string').and.not.empty;
				expect(cfg.icon).to.be.a('string').and.not.empty;
				expect(cfg.mode).to.equal(mode as ExecutionMode);
			}
		});
	});
});
