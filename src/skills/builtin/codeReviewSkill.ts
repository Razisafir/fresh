/**
 * codeReviewSkill.ts — Built-in skill: kovix.code-review.
 *
 * A higher-order capability that composes the read_file and search_code
 * tools with a code review methodology. The skill injects a system prompt
 * fragment that guides the agent through structured code review, and
 * provides a "/review" slash command for quick invocation.
 *
 * Allowed roles: reviewer, coder, general.
 * Category: coding.
 */

import type { ISkillManifest } from '../../types/skills';
import type { ISkillRegistry } from '../../types/skills';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Manifest for the built-in code review skill.
 */
export const codeReviewSkillManifest: ISkillManifest = {
        id: 'kovix.code-review',
        name: 'Code Review',
        version: '1.0.0',
        description: 'Structured code review with bug detection, security analysis, and style feedback.',
        longDescription:
                'Performs a thorough code review using read_file and search_code to explore ' +
                'the codebase. Produces a prioritised list of findings across five dimensions: ' +
                'bugs, security, performance, style, and structure. Works best in Reviewer role ' +
                'but is available to Coder and General roles as well.',

        author: 'Kovix',
        license: 'MIT',

        tools: ['search_code', 'read_file'],

        systemPromptFragment: `## Code Review Skill Active

You have the Code Review skill active. When reviewing code, follow this
methodology:

1. **Scope the review** — use search_code to find all files related to the
   change (diff context, imports, callers). Don't review files in isolation.
2. **Read each file** — use read_file to examine the full file, not just
   the diff. Context matters.
3. **Check for bugs** — logic errors, off-by-one mistakes, null/undefined
   dereferences, race conditions, incorrect error handling.
4. **Check for security issues** — injection risks, missing input validation,
   hardcoded secrets, insecure defaults, SSRF risks.
5. **Check for performance** — unnecessary allocations, N+1 queries, missing
   indices, O(n²) where O(n) would suffice.
6. **Check for style** — consistency with codebase patterns, dead code,
   unused imports, misleading names.
7. **Check for structure** — overly complex functions, deep nesting, poor
   separation of concerns, missing abstractions.

Structure your review as a prioritised list:
   🔴 Critical — bugs, security vulnerabilities
   🟡 Warning — performance issues, fragile patterns
   🔵 Suggestion — style, clarity, minor improvements

Always provide actionable feedback with file paths and line references.`,

        slashCommands: [
                {
                        name: '/review',
                        description: 'Start a structured code review of the current changes or specified files.',
                        handler: 'handleReview',
                        aliases: ['/cr'],
                },
        ],

        allowedRoles: ['reviewer', 'coder', 'general'],

        requiredTools: ['search_code', 'read_file'],

        icon: '🔍',
        color: '#F97316',
        category: 'coding',
        tags: ['review', 'quality', 'security', 'bugs'],

        memoryScope: 'session',

        configurable: [
                {
                        key: 'severityThreshold',
                        type: 'select',
                        label: 'Minimum severity to report',
                        description: 'Filter out findings below this severity level.',
                        default: 'suggestion',
                        options: [
                                { label: 'All findings', value: 'suggestion' },
                                { label: 'Warnings and above', value: 'warning' },
                                { label: 'Critical only', value: 'critical' },
                        ],
                },
                {
                        key: 'includeStyleChecks',
                        type: 'boolean',
                        label: 'Include style checks',
                        description: 'Whether to include style/formatting feedback in the review.',
                        default: true,
                },
        ],
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the code review skill with the given skill registry.
 *
 * @param registry The skill registry to register with.
 */
export function registerCodeReviewSkill(registry: ISkillRegistry): void {
        registry.registerSkill(codeReviewSkillManifest, 'builtin');
}
