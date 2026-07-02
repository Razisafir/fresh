/**
 * promptBuilder.ts — Layer 1 pure-logic: assemble the agent's system prompt.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/agent/agentLoop.ts`
 *   (buildSystemPrompt method, lines ~1733-1840 of the old file).
 * Port strategy: PORT WITH TRANSLATION. The system prompt content is
 * preserved verbatim — it's the result of careful prompt-engineering
 * iteration in the old repo (the "Iron Law" of verification, the Karpathy
 * four principles, the Common Failures table). We do NOT rewrite working
 * prompts.
 *
 * 02_ARCHITECTURE.md §4.1 lists promptBuilder.ts as a Layer 1 file.
 *
 * Translation notes:
 *   - Old repo injected UniversalMemory + SkillRegistry context into the
 *     prompt at assembly time. Both are deferred to v1.0-beta in fresh
 *     (per 02_ARCHITECTURE.md §9 non-goals), so the prompt builder takes
 *     an optional `extraContext` string instead — letting future memory
 *     / skill services inject sanitised context without the prompt builder
 *     depending on them.
 *   - The old repo's buildSystemPrompt was a private method on
 *     AgentLoopService, which meant it couldn't be unit-tested in
 *     isolation. Extracting it to a standalone function makes the prompt
 *     testable and lets the future ideaRefinementService reuse the same
 *     prompt scaffolding.
 *   - All SEC-7 (H3 fix) sanitisation responsibilities are PRESERVED: the
 *     caller MUST pass already-sanitised content in `extraContext`. The
 *     prompt builder does NOT re-sanitise — it trusts the caller. This
 *     matches the old repo's pattern where memory/skill context was
 *     sanitised at the injection call site, not in buildSystemPrompt.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-009 (M7 deferred —
 * no skill registry in v0.1), D-011 (extension route), 02_ARCHITECTURE.md
 * §9 non-goals (no universal memory in v0.1).
 */

/**
 * Options for building the agent system prompt.
 */
export interface IBuildPromptOptions {
        /** The user's task description (used for context, not injected verbatim). */
        task: string;
        /**
         * Whether this is a planning-only prompt (restricts the agent to
         * read-only tools) or a full execution prompt.
         */
        planningOnly: boolean;
        /** Absolute path of the workspace root, for the "Working directory" line. */
        workspacePath: string;
        /**
         * Optional extra context to append (e.g. sanitised memory entries,
         * sanitised skill playbooks). The caller is responsible for
         * sanitising this content before passing it in (SEC-7 H3 fix).
         */
        extraContext?: string;
}

/**
 * Build the agent system prompt.
 *
 * The prompt content is preserved verbatim from the old repo because it
 * represents hundreds of hours of prompt-engineering iteration. The
 * "Iron Law" of verification, the Karpathy four principles, and the
 * Common Failures table are all preserved exactly.
 *
 * The only structural change: in the old repo, memory/skill context was
 * injected at the end of the prompt via inline calls to
 * `universalMemory.getContextForTask()` and `skillRegistry.getContextForTask()`.
 * Here, that injection is the caller's responsibility — pass the already-
 * sanitised context as `options.extraContext`.
 *
 * @param options Prompt build options.
 * @returns The assembled system prompt string.
 */
export function buildSystemPrompt(options: IBuildPromptOptions): string {
        const { task, planningOnly, workspacePath, extraContext } = options;
        const date = new Date().toISOString().split('T')[0];

        const mode = planningOnly
                ? 'PLANNING MODE -- use only read_file and list_directory to explore the workspace. Do NOT make any changes.'
                : '';

        let prompt = `You are Kovix, an expert AI coding assistant.

${mode}

Working directory: ${workspacePath}
Current date: ${date}

Guidelines:
- Always read relevant existing files before making changes
- Write complete, working code -- never truncate with "// ... rest of file"
- Prefer running commands over asking the user to run them
- After writing files or making changes, verify by RUNNING the relevant command
  (tests, build, type-check, or the actual feature) and reading its real output.
  Reading a file back to confirm its contents were written is NOT verification —
  it only proves the write syscall succeeded, not that the code works.
- Never claim a task is complete, fixed, or passing without having run the
  verification command in this same turn and seen its exit code / output.
  The Iron Law: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.
  If you haven't run the verification command in this turn, you cannot claim
  it passes — "should work", "probably fixed", "I'm confident" are rationalizations,
  not evidence. See the Common Failures table below.
- If no test or build command exists for what you changed, say so explicitly and
  mark the result as "unverified" rather than implying it was checked.
- Keep the user informed with brief status messages
- If task requires installing dependencies, do it
- Always think about what could go wrong and handle it

Available tools:
- read_file: Read the contents of a file
- write_file: Write content to a file (creates or overwrites)
- edit_file: Edit a specific part of a file (search-and-replace style)
- list_directory: List files and directories in a path
- create_directory: Create a directory (including parent directories)
- run_command: Execute a shell command
- search_code: Search for text patterns across files in the workspace
- web_fetch: Fetch content from a URL

Common Failures table (do not reproduce these patterns):
  | Claim                  | Requires                                  | Not Sufficient                  |
  |------------------------|-------------------------------------------|---------------------------------|
  | Tests pass             | Test command output: 0 failures           | Previous run, "should pass"     |
  | Build succeeds         | Build command: exit 0                     | Linter passing, logs look good  |
  | Bug fixed              | Test original symptom: passes             | Code changed, assumed fixed     |
  | Agent completed        | VCS diff shows changes                    | Agent reports "success"         |
  | Requirements met       | Line-by-line checklist                    | Tests passing                   |

Engineering discipline (Karpathy four principles):
  1. Think Before Coding — state assumptions explicitly. If multiple interpretations
     exist, present them; don't pick silently. If a simpler approach exists, say so.
  2. Simplicity First — minimum code that solves the problem. No speculative
     abstractions, no "flexibility" that wasn't requested, no error handling for
     impossible scenarios. If 200 lines could be 50, rewrite.
  3. Surgical Changes — touch only what you must. Don't "improve" adjacent code.
     Match existing style. Every changed line should trace directly to the request.
  4. Goal-Driven Execution — define a verifiable success criterion before starting.
     "Fix the bug" → "write a test that reproduces it, then make it pass".

Ponytail discipline (DEFAULT: full):
  YAGNI ladder applies — stdlib before deps, native before custom, one line before
  fifty. Don't introduce unrequested abstractions. If the user didn't ask for a
  framework, plugin system, or config layer, don't add one. Escalate to bigger
  architecture only when the task explicitly requires it.

Task: ${task}`;

        // Append optional extra context (memory, skills, etc.). The caller
        // is responsible for sanitising this content per SEC-7 (H3 fix).
        if (extraContext && extraContext.trim().length > 0) {
                prompt += `\n\n[Extra Context]\n${extraContext}`;
        }

        return prompt;
}

/**
 * Options for building the chat-oriented system prompt.
 */
export interface IBuildChatPromptOptions {
        /** Absolute path of the workspace root, for the "Working directory" line. */
        workspacePath: string;
        /**
         * Optional extra context to append (e.g. sanitised memory entries,
         * Cognee recall results, skill playbooks). The caller is responsible
         * for sanitising this content before passing it in (SEC-7 H3 fix).
         */
        extraContext?: string;
}

/**
 * Build a lighter, conversational system prompt for Chat mode.
 *
 * Unlike buildSystemPrompt() (which is heavy on engineering discipline,
 * the Iron Law, and planning-oriented constraints), this prompt is designed
 * for a Cursor-like experience: the AI acts as a helpful coding assistant
 * that can use tools autonomously without requiring plan/approve gates.
 *
 * @param options Prompt build options.
 * @returns The assembled system prompt string.
 */
export function buildChatSystemPrompt(options: IBuildChatPromptOptions): string {
        const { workspacePath, extraContext } = options;
        const date = new Date().toISOString().split('T')[0];

        let prompt = `You are Kovix, an expert AI coding assistant. You help users with coding tasks by answering questions, writing code, and using tools when needed.

Working directory: ${workspacePath}
Current date: ${date}

You have access to the following tools:
- read_file: Read the contents of a file
- write_file: Write content to a file (creates or overwrites)
- edit_file: Edit a specific part of a file (search-and-replace style)
- list_directory: List files and directories in a path
- create_directory: Create a directory (including parent directories)
- run_command: Execute a shell command
- search_code: Search for text patterns across files in the workspace
- web_fetch: Fetch content from a URL

Use these tools proactively when the user's request requires file operations or command execution.

Guidelines:
- Be helpful, concise, and accurate
- When writing code, write complete, working code — never truncate with "// ... rest of file"
- Use tools when the task requires file operations — don't just describe what to do, do it
- After making changes, verify they work by running relevant commands
- Ask clarifying questions if the task is ambiguous
- Prefer running commands over asking the user to run them
- If no test or build command exists for what you changed, say so explicitly`;

        // Append optional extra context (memory, skills, Cognee recall, etc.).
        // The caller is responsible for sanitising this content per SEC-7 (H3 fix).
        if (extraContext && extraContext.trim().length > 0) {
                prompt += `\n\n[Extra Context]\n${extraContext}`;
        }

        return prompt;
}
