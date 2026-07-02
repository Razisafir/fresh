/**
 * agentRoles.ts — Layer 1 pure-logic: agent role enum + configs.
 *
 * New file (not ported). Agent roles change the agent's behavior and system
 * prompt to specialise for different workflows — architecture, coding,
 * review, debugging, or pure Q&A.
 *
 * Follows the same pattern as `executionMode.ts` (Layer 1, pure constants +
 * types, zero runtime deps). The role's system prompt fragment is prepended
 * to the main system prompt assembled by `promptBuilder.ts`.
 *
 * Role → tool filtering:
 *   - General, Architect, Coder, Debugger: full tool access.
 *   - Reviewer: read-only tools only (modifiesFiles === false), plus a
 *     name-based allowlist for safety — even if a tool is mistakenly
 *     registered without `modifiesFiles`, the Reviewer won't pick it up
 *     unless it's in the read-only set.
 *   - Ask: no tools at all. Pure conversational Q&A.
 *
 * Role → default execution mode:
 *   - General     → MajorMilestone   (balanced control)
 *   - Architect   → EveryMilestone   (careful, review-oriented)
 *   - Coder       → FullAuto         (direct action, minimal friction)
 *   - Reviewer    → EveryMilestone   (review every step)
 *   - Debugger    → Selective        (debug → fix → verify cycles)
 *   - Ask         → FullAuto         (no execution, just conversation)
 *
 * Decisions referenced: D-001 (file-by-file audit).
 */

import type { IToolDefinition } from '../types/llm';
import { ExecutionMode } from './executionMode';

// ---------------------------------------------------------------------------
// AgentRole enum
// ---------------------------------------------------------------------------

/**
 * Agent role modes. Each role specialises the agent's behavior, system
 * prompt, available tools, and default execution mode.
 */
export enum AgentRole {
        /** Default mode. Balanced capabilities for any task. */
        General = 'general',
        /** System design, architecture decisions, and planning. */
        Architect = 'architect',
        /** Writing and editing code with precision. */
        Coder = 'coder',
        /** Read-only code review. */
        Reviewer = 'reviewer',
        /** Diagnosing and fixing bugs. */
        Debugger = 'debugger',
        /** Conversational Q&A, no tool usage. */
        Ask = 'ask',
}

// ---------------------------------------------------------------------------
// IAgentRoleConfig interface
// ---------------------------------------------------------------------------

/**
 * Configuration for an agent role.
 */
export interface IAgentRoleConfig {
        /** The agent role. */
        readonly role: AgentRole;
        /** Display label. */
        readonly label: string;
        /** Short description. */
        readonly description: string;
        /** Icon (Unicode). */
        readonly icon: string;
        /** Color token for UI theming (Tailwind class or CSS variable). */
        readonly color: string;
        /** System prompt fragment prepended to the main system prompt. */
        readonly systemPromptFragment: string;
        /** Tool names allowed for this role. `null` means all tools. */
        readonly allowedToolNames: readonly string[] | null;
        /** Default execution mode for this role. */
        readonly defaultExecutionMode: ExecutionMode;
}

// ---------------------------------------------------------------------------
// Read-only tool allowlist
// ---------------------------------------------------------------------------

/**
 * Tool names that are safe for the Reviewer role — all are read-only.
 *
 * These are the 4 built-in tools from v0.1 that do not modify files
 * (per the tool registry spec in `src/types/tools.ts`):
 *   - read_file
 *   - list_directory
 *   - search_code
 *   - web_fetch
 */
const READ_ONLY_TOOL_NAMES: readonly string[] = [
        'read_file',
        'list_directory',
        'search_code',
        'web_fetch',
] as const;

// ---------------------------------------------------------------------------
// System prompt fragments
// ---------------------------------------------------------------------------

/**
 * System prompt fragment for the General role.
 *
 * Emphasises versatility — the agent should handle any task competently
 * without over-specialising in any one direction.
 */
const GENERAL_PROMPT = `You are operating in General mode — the default, versatile mode. You are
equally capable of planning, coding, reviewing, and debugging. Prioritise
being helpful and thorough across all task types. When a task clearly falls
into a specialist domain (e.g. pure code review, deep debugging), consider
suggesting the user switch to that specialist role, but do not refuse the
task — handle it competently yourself.`;

/**
 * System prompt fragment for the Architect role.
 *
 * Emphasises thinking about trade-offs, scalability, and maintainability.
 * Prefers read-only exploration before suggesting changes.
 */
const ARCHITECT_PROMPT = `You are operating in Architect mode. Your primary focus is system design,
architecture decisions, and planning. Before suggesting any changes:

1. EXPLORE FIRST — read relevant files, understand the existing architecture,
   and map dependencies before proposing changes. Do not jump to solutions.
2. THINK IN TRADE-OFFS — every architecture decision has pros and cons.
   Present them explicitly. "There is no such thing as a free lunch."
3. SCALABILITY & MAINTAINABILITY — evaluate whether proposed changes will
   hold up as the codebase grows. Flag technical debt.
4. MINIMAL CHANGES — prefer the smallest change that achieves the goal.
   Avoid speculative abstractions or "future-proofing" that isn't needed yet.
5. DOCUMENT REASONING — when you propose an architecture change, explain
   WHY, not just WHAT. Future readers need the rationale.

You have full tool access, but you should prefer read-only exploration
(read_file, list_directory, search_codebase) over writing files. Only write
files when the user explicitly asks you to implement an architecture change.`;

/**
 * System prompt fragment for the Coder role.
 *
 * Emphasises precision, minimal diffs, and following existing patterns.
 * Prefers direct action over discussion.
 */
const CODER_PROMPT = `You are operating in Coder mode. Your primary focus is writing and editing
code with precision and speed. Guidelines:

1. ACT, DON'T DISCUSS — when the task is clear, write the code. Don't spend
   turns explaining what you're going to do; just do it. Brief status updates
   are fine.
2. MINIMAL DIFFS — change only what's necessary. Do not reformat adjacent
   code, add unrelated improvements, or "clean up" unless asked.
3. FOLLOW EXISTING PATTERNS — match the codebase's existing style, naming
   conventions, and patterns. Consistency over personal preference.
4. PRECISION — write complete, working code. No truncation, no placeholder
   comments like "// ... rest of file". Every line you write should compile
   and run.
5. VERIFY — after writing or editing code, run the relevant verification
   command (tests, type-check, build) and report the actual output.

You have full tool access and default to FullAuto execution. Write code
confidently, but always verify it works.`;

/**
 * System prompt fragment for the Reviewer role.
 *
 * Emphasises finding bugs, security issues, performance problems, and style
 * violations. Will NOT write files — only read and comment.
 */
const REVIEWER_PROMPT = `You are operating in Reviewer mode. Your primary focus is code review. You
are READ-ONLY — you must NOT write, edit, or create any files. You can only
read files and provide feedback. Guidelines:

1. BUGS — look for logic errors, off-by-one mistakes, null/undefined
   dereferences, race conditions, and incorrect error handling.
2. SECURITY — flag potential vulnerabilities: injection risks, missing
   input validation, hardcoded secrets, insecure defaults, and SSRF risks.
3. PERFORMANCE — identify unnecessary allocations, N+1 queries, missing
   indices, excessive re-renders, and O(n²) where O(n) would suffice.
4. STYLE — check for consistency with the codebase's existing patterns,
   naming conventions, and formatting. Flag dead code and unused imports.
5. STRUCTURE — comment on overly complex functions, deep nesting, poor
   separation of concerns, and missing or misleading abstractions.

Structure your review as a prioritised list:
   🔴 Critical — bugs, security vulnerabilities
   🟡 Warning — performance issues, fragile patterns
   🔵 Suggestion — style, clarity, minor improvements

You only have access to read-only tools. If the user asks you to make
changes, explain what should change but do NOT write the files yourself.
Suggest they switch to Coder mode to implement the fixes.`;

/**
 * System prompt fragment for the Debugger role.
 *
 * Emphasises systematic debugging: reproduce → isolate → fix → verify.
 * Prefers running commands and reading logs.
 */
const DEBUGGER_PROMPT = `You are operating in Debugger mode. Your primary focus is diagnosing and
fixing bugs. Follow the systematic debugging methodology:

1. REPRODUCE — first, confirm you can reproduce the bug. Run the relevant
   command or test and capture the actual error output. Never assume you
   understand the bug from the description alone.
2. ISOLATE — narrow down the root cause. Read the relevant code, add
   strategic logging if needed, and run targeted commands. Form a hypothesis
   and test it.
3. FIX — make the minimal change that fixes the root cause. Do not refactor
   surrounding code or fix unrelated issues. The fix should be surgical.
4. VERIFY — run the original failing test/command to confirm the fix works.
   Then check for regressions by running the broader test suite if available.

You have full tool access. Prefer running commands and reading logs over
reading source code — runtime evidence is more reliable than reading code
and guessing. If the bug cannot be reproduced, say so explicitly rather than
speculating.`;

/**
 * System prompt fragment for the Ask role.
 *
 * Emphasises being a knowledgeable assistant. Pure text responses only.
 */
const ASK_PROMPT = `You are operating in Ask mode — conversational Q&A. You are a
knowledgeable coding assistant. You do NOT have access to any tools — you
cannot read files, write files, run commands, or search codebases. You can
only respond with text.

Guidelines:
1. Be concise and accurate. If you don't know something, say so.
2. Provide code examples in fenced blocks when helpful, but note that you
   cannot verify them against the user's codebase.
3. If the user's question requires reading their code or running commands,
   explain that and suggest switching to General, Coder, or Debugger mode.
4. Focus on giving clear, well-structured answers. Use headers, bullet
   points, and numbered lists to organise complex responses.`;

// ---------------------------------------------------------------------------
// AGENT_ROLE_CONFIGS
// ---------------------------------------------------------------------------

/**
 * Configurations for each agent role.
 *
 * Icons are Unicode escape sequences, following the same convention as
 * `executionMode.ts`:
 *   - General:   🤖 (U+1F916)
 *   - Architect: 🏗️ (U+1F3D7)
 *   - Coder:     💻 (U+1F4BB)
 *   - Reviewer:  🔍 (U+1F50D)
 *   - Debugger:  🐛 (U+1F41B)
 *   - Ask:       💬 (U+1F4AC)
 *
 * Colors are Tailwind text-color classes for UI rendering.
 */
export const AGENT_ROLE_CONFIGS: Record<AgentRole, IAgentRoleConfig> = {
        [AgentRole.General]: {
                role: AgentRole.General,
                label: 'General',
                description: 'Default mode. Balanced capabilities for any task.',
                icon: '\u{1F916}', // 🤖
                color: 'text-foreground',
                systemPromptFragment: GENERAL_PROMPT,
                allowedToolNames: null, // all tools
                defaultExecutionMode: ExecutionMode.MajorMilestone,
        },
        [AgentRole.Architect]: {
                role: AgentRole.Architect,
                label: 'Architect',
                description: 'System design, architecture decisions, and planning.',
                icon: '\u{1F3D7}', // 🏗️
                color: 'text-amber-600',
                systemPromptFragment: ARCHITECT_PROMPT,
                allowedToolNames: null, // all tools
                defaultExecutionMode: ExecutionMode.EveryMilestone,
        },
        [AgentRole.Coder]: {
                role: AgentRole.Coder,
                label: 'Coder',
                description: 'Writing and editing code with precision.',
                icon: '\u{1F4BB}', // 💻
                color: 'text-emerald-600',
                systemPromptFragment: CODER_PROMPT,
                allowedToolNames: null, // all tools
                defaultExecutionMode: ExecutionMode.FullAuto,
        },
        [AgentRole.Reviewer]: {
                role: AgentRole.Reviewer,
                label: 'Reviewer',
                description: 'Read-only code review. No file modifications.',
                icon: '\u{1F50D}', // 🔍
                color: 'text-orange-600',
                systemPromptFragment: REVIEWER_PROMPT,
                allowedToolNames: READ_ONLY_TOOL_NAMES,
                defaultExecutionMode: ExecutionMode.EveryMilestone,
        },
        [AgentRole.Debugger]: {
                role: AgentRole.Debugger,
                label: 'Debugger',
                description: 'Diagnosing and fixing bugs systematically.',
                icon: '\u{1F41B}', // 🐛
                color: 'text-red-500',
                systemPromptFragment: DEBUGGER_PROMPT,
                allowedToolNames: null, // all tools
                defaultExecutionMode: ExecutionMode.Selective,
        },
        [AgentRole.Ask]: {
                role: AgentRole.Ask,
                label: 'Ask',
                description: 'Conversational Q&A. No tool usage.',
                icon: '\u{1F4AC}', // 💬
                color: 'text-violet-600',
                systemPromptFragment: ASK_PROMPT,
                allowedToolNames: [], // no tools
                defaultExecutionMode: ExecutionMode.FullAuto,
        },
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Get the system prompt fragment for a given agent role.
 *
 * This fragment should be prepended to the main system prompt assembled by
 * `promptBuilder.ts`. The role fragment goes first so it sets the tone
 * before the general Kovix guidelines.
 *
 * @param role The agent role.
 * @returns The system prompt fragment string.
 */
export function getSystemPromptForRole(role: AgentRole): string {
        return AGENT_ROLE_CONFIGS[role].systemPromptFragment;
}

/**
 * Filter the available tools for a given agent role.
 *
 * - Roles with `allowedToolNames: null` (General, Architect, Coder, Debugger)
 *   receive all tools — no filtering applied.
 * - Reviewer receives only read-only tools (matched by name against the
 *   `READ_ONLY_TOOL_NAMES` allowlist).
 * - Ask receives no tools (empty array).
 *
 * @param role The agent role.
 * @param allTools All available tools in LLM-facing definition format.
 * @returns The filtered tool list for this role.
 */
export function getToolsForRole(
        role: AgentRole,
        allTools: IToolDefinition[],
): IToolDefinition[] {
        const config = AGENT_ROLE_CONFIGS[role];

        // null means all tools are allowed
        if (config.allowedToolNames === null) {
                return allTools;
        }

        // Empty array means no tools (Ask mode)
        if (config.allowedToolNames.length === 0) {
                return [];
        }

        // Filter by allowed tool names (Reviewer mode)
        const allowedSet = new Set(config.allowedToolNames);
        return allTools.filter(tool => allowedSet.has(tool.name));
}

/**
 * Get the default execution mode for a given agent role.
 *
 * Each role has a natural default that matches its workflow:
 *   - General     → MajorMilestone   (balanced control)
 *   - Architect   → EveryMilestone   (careful, review-oriented)
 *   - Coder       → FullAuto         (direct action, minimal friction)
 *   - Reviewer    → EveryMilestone   (review every step)
 *   - Debugger    → Selective        (debug → fix → verify cycles)
 *   - Ask         → FullAuto         (no execution, just conversation)
 *
 * @param role The agent role.
 * @returns The default execution mode for this role.
 */
export function getDefaultExecutionMode(role: AgentRole): ExecutionMode {
        return AGENT_ROLE_CONFIGS[role].defaultExecutionMode;
}
