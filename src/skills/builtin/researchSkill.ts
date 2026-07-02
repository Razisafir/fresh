/**
 * researchSkill.ts — Built-in skill: kovix.research.
 *
 * A higher-order capability for researching topics across the web and
 * codebase. Composes the web_fetch and search_code tools with a research
 * methodology that emphasises source verification, cross-referencing,
 * and structured knowledge synthesis.
 *
 * Allowed roles: all (no restriction).
 * Category: research.
 */

import type { ISkillManifest } from '../../types/skills';
import type { ISkillRegistry } from '../../types/skills';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Manifest for the built-in research skill.
 */
export const researchSkillManifest: ISkillManifest = {
        id: 'kovix.research',
        name: 'Research',
        version: '1.0.0',
        description: 'Research topics across the web and codebase with source verification and structured synthesis.',
        longDescription:
                'Combines web_fetch and search_code into a coherent research workflow. ' +
                'The skill guides the agent through: defining the research question, ' +
                'gathering sources from both the web and local codebase, cross-referencing ' +
                'findings, and synthesising results into a structured answer with citations. ' +
                'Available to all agent roles.',

        author: 'Kovix',
        license: 'MIT',

        tools: ['web_fetch', 'search_code'],

        systemPromptFragment: `## Research Skill Active

You have the Research skill active. When conducting research, follow this
methodology:

1. **Define the question** — clarify what you're researching and what a
   successful answer looks like. If the question is ambiguous, ask for
   clarification before proceeding.
2. **Search the codebase first** — use search_code to find relevant files,
   functions, and patterns in the local project. Local context is more
   reliable than web sources.
3. **Search the web** — use web_fetch to retrieve documentation, API
   references, blog posts, or technical articles. Prefer official
   documentation and primary sources over secondary summaries.
4. **Cross-reference** — compare findings from multiple sources. If the
   codebase and documentation disagree, flag the discrepancy and explain
   which source you trust and why.
5. **Synthesize** — combine your findings into a structured answer. Use
   headers, bullet points, and numbered lists. Cite your sources (file
   paths for code, URLs for web).
6. **Acknowledge gaps** — if you couldn't find a definitive answer, say so.
   Partial answers with clear gaps are more useful than confident guesses.

When citing code, include the file path and a brief excerpt. When citing
web sources, include the URL and a one-line summary of what it says.`,

        slashCommands: [
                {
                        name: '/research',
                        description: 'Start a structured research session on a topic.',
                        handler: 'handleResearch',
                        aliases: ['/rs'],
                },
        ],

        // No allowedRoles restriction — available to all roles.

        requiredTools: ['web_fetch', 'search_code'],

        icon: '📚',
        color: '#10B981',
        category: 'research',
        tags: ['research', 'web', 'documentation', 'knowledge'],

        memoryScope: 'session',

        configurable: [
                {
                        key: 'maxWebSources',
                        type: 'number',
                        label: 'Maximum web sources',
                        description: 'Maximum number of web pages to fetch during a research session.',
                        default: 5,
                },
                {
                        key: 'preferLocal',
                        type: 'boolean',
                        label: 'Prefer local codebase',
                        description: 'Search the codebase before fetching web sources.',
                        default: true,
                },
                {
                        key: 'citationStyle',
                        type: 'select',
                        label: 'Citation style',
                        description: 'How to format source citations in the output.',
                        default: 'inline',
                        options: [
                                { label: 'Inline', value: 'inline' },
                                { label: 'Footnotes', value: 'footnotes' },
                                { label: 'End references', value: 'references' },
                        ],
                },
        ],
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the research skill with the given skill registry.
 *
 * @param registry The skill registry to register with.
 */
export function registerResearchSkill(registry: ISkillRegistry): void {
        registry.registerSkill(researchSkillManifest, 'builtin');
}
