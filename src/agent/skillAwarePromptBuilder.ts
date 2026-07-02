/**
 * skillAwarePromptBuilder.ts — Builds the "Active Skills" section of the
 * system prompt.
 *
 * A helper module that:
 *   - Builds the "Active Skills" section of the system prompt
 *   - Formats each skill's system prompt fragment with context about what
 *     tools are available
 *   - Adds a "Skill Tools Available" subsection listing tools from active
 *     skills
 *   - Handles the case where no skills are active (returns empty string)
 *
 * This module does NOT depend on singletons directly — it takes the active
 * skills and available tool names as parameters, making it testable in
 * isolation.
 */

import type { ISkill } from '../types/skills';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for building the skill-aware system prompt section.
 */
export interface IBuildSkillPromptOptions {
	/** Active skills to include in the prompt. */
	activeSkills: ISkill[];
	/**
	 * All tool names currently registered in the tool registry.
	 * Used to build the "Skill Tools Available" subsection.
	 */
	availableToolNames: string[];
	/**
	 * The current agent role (e.g. "general", "coder").
	 * Used to filter skills by allowedRoles.
	 */
	role: string;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Build the "Active Skills" section of the system prompt.
 *
 * Returns a formatted string that includes:
 *   1. A "## Active Skills" header
 *   2. For each skill: name, description, and system prompt fragment
 *   3. A "Skill Tools Available" subsection listing the tools from active
 *      skills that are actually registered in the tool registry
 *
 * Returns an empty string if no skills are active or no skills match the
 * current role.
 *
 * @param options Build options with active skills, tool names, and role.
 * @returns Formatted skill prompt section, or empty string.
 */
export function buildSkillPromptSection(options: IBuildSkillPromptOptions): string {
	const { activeSkills, availableToolNames, role } = options;

	// Filter skills by role
	const roleSkills = activeSkills.filter(skill => {
		const allowed = skill.manifest.allowedRoles;
		if (!allowed || allowed.length === 0) return true;
		return allowed.includes(role);
	});

	if (roleSkills.length === 0) {
		return '';
	}

	const availableToolSet = new Set(availableToolNames);
	const lines: string[] = [];

	// Header
	lines.push('## Active Skills');
	lines.push('');

	// Per-skill section: name, description, system prompt fragment
	for (const skill of roleSkills) {
		lines.push(`### ${skill.manifest.name} (${skill.manifest.id})`);
		lines.push('');
		lines.push(skill.manifest.description);
		lines.push('');

		if (skill.manifest.systemPromptFragment) {
			lines.push(skill.manifest.systemPromptFragment);
			lines.push('');
		}
	}

	// "Skill Tools Available" subsection
	const skillToolNames: string[] = [];
	for (const skill of roleSkills) {
		for (const toolName of skill.manifest.tools) {
			if (availableToolSet.has(toolName) && !skillToolNames.includes(toolName)) {
				skillToolNames.push(toolName);
			}
		}
	}

	if (skillToolNames.length > 0) {
		lines.push('### Skill Tools Available');
		lines.push('');
		lines.push('The following tools are provided by active skills:');
		lines.push('');
		for (const toolName of skillToolNames) {
			// Find which skill provides this tool for attribution
			const owner = roleSkills.find(s => s.manifest.tools.includes(toolName));
			const attribution = owner ? ` (from ${owner.manifest.name})` : '';
			lines.push(`- \`${toolName}\`${attribution}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * Format Cognee recall results into a prompt-embeddable string.
 *
 * Returns an empty string if the results array is empty.
 *
 * @param results Cognee recall results.
 * @returns Formatted recall context, or empty string.
 */
export function formatCogneeRecallContext(results: Array<{ content: string; score: number; datasets: string[] }>): string {
	if (results.length === 0) {
		return '';
	}

	const lines: string[] = [];
	lines.push('## Knowledge Graph Recall');
	lines.push('');
	lines.push('The following knowledge was retrieved from the Cognee knowledge graph:');
	lines.push('');

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const score = r.score.toFixed(2);
		const ds = r.datasets.join(', ');
		lines.push(`[${i + 1}] (relevance: ${score}, datasets: ${ds})`);
		lines.push(r.content);
		lines.push('');
	}

	return lines.join('\n');
}
