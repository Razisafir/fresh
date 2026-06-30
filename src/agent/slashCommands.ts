/**
 * slashCommands.ts — Slash command system for the chat input.
 *
 * When the user types `/` at the start of their message, a dropdown appears
 * with available commands. Each command has a name, description, optional
 * shortcut key, and a handler that returns an ISlashCommandResult.
 *
 * Built-in commands cover the most common agent interactions: help, clearing
 * history, switching execution modes and agent roles, managing pending
 * changes, toggling swarm mode, switching models/providers, adding context
 * files, resetting state, and reporting bugs.
 *
 * The handler receives a context snapshot (chat history, active provider/
 * model, current role/mode, pending change count) and returns a result that
 * tells the UI what action to take (send a message, suppress the input,
 * switch role/mode/provider/model, clear history, or reset entirely).
 *
 * Design notes:
 *   - AgentRole is defined locally here because it is specific to the slash
 *     command interaction surface. If a shared AgentRole type is introduced
 *     in `src/types/agent.ts` later, the local definition should be replaced
 *     with a re-export from that module.
 *   - The ExecutionMode enum is imported from `src/agent/executionMode.ts`
 *     so that `/mode` can validate and switch to a known mode.
 *   - `IChatMessage` is imported from `src/types/llm.ts` — the unified chat
 *     message type used across all providers.
 *   - Handlers are synchronous by default. Handlers that need to perform
 *     async work (e.g. /compact calling a summarisation service) return
 *     `Promise<ISlashCommandResult>`.
 */

import { ExecutionMode } from './executionMode';
import type { IChatMessage } from '../types/llm';

// ---------------------------------------------------------------------------
// AgentRole — local definition (see design notes above)
// ---------------------------------------------------------------------------

/**
 * The role the agent assumes for a given conversation turn.
 * Each role biases the system prompt and tool selection toward a focus area.
 *
 * The `/role` slash command switches between these roles at runtime.
 */
export type AgentRole =
        | 'general'
        | 'architect'
        | 'coder'
        | 'reviewer'
        | 'debugger'
        | 'ask';

/**
 * Human-readable labels for each agent role.
 */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
        general: 'General',
        architect: 'Architect',
        coder: 'Coder',
        reviewer: 'Reviewer',
        debugger: 'Debugger',
        ask: 'Ask',
};

/**
 * Valid AgentRole values (for validation in /role handler).
 */
const VALID_AGENT_ROLES: ReadonlySet<string> = new Set<string>(
        ['general', 'architect', 'coder', 'reviewer', 'debugger', 'ask'] as const,
);

/**
 * Valid ExecutionMode values (for validation in /mode handler).
 */
const VALID_EXECUTION_MODES: ReadonlyMap<string, ExecutionMode> = new Map<
        string,
        ExecutionMode
>([
        ['every', ExecutionMode.EveryMilestone],
        ['major', ExecutionMode.MajorMilestone],
        ['selective', ExecutionMode.Selective],
        ['auto', ExecutionMode.FullAuto],
]);

// ---------------------------------------------------------------------------
// ISlashCommandContext
// ---------------------------------------------------------------------------

/**
 * Context snapshot provided to every slash command handler.
 * Read-only — handlers must not mutate this object.
 */
export interface ISlashCommandContext {
        /** Current chat history (read-only snapshot). */
        readonly chatHistory: IChatMessage[];
        /** Currently active LLM provider name. */
        readonly activeProvider: string;
        /** Currently active model ID. */
        readonly activeModel: string;
        /** Current agent role. */
        readonly currentRole: AgentRole;
        /** Current execution mode. */
        readonly currentMode: ExecutionMode;
        /** Number of pending changes awaiting accept/reject. */
        readonly pendingChangeCount: number;
}

// ---------------------------------------------------------------------------
// ISlashCommandResult
// ---------------------------------------------------------------------------

/**
 * Result returned by a slash command handler.
 *
 * The `action` field determines what the UI does after the command executes:
 *   - 'send'           → send `message` as a user chat message
 *   - 'suppress'       → do nothing (the handler already handled it)
 *   - 'switch-role'    → switch to `role`
 *   - 'switch-mode'    → switch to `mode`
 *   - 'switch-provider'→ switch to `provider`
 *   - 'switch-model'   → switch to `model`
 *   - 'clear'          → clear chat history
 *   - 'reset'          → reset the entire conversation and agent state
 *
 * Only the fields relevant to the chosen action need to be set; others are
 * ignored.
 */
export interface ISlashCommandResult {
        action:
                | 'send'
                | 'suppress'
                | 'switch-role'
                | 'switch-mode'
                | 'switch-provider'
                | 'switch-model'
                | 'clear'
                | 'reset';
        /** Message to send (for 'send' action) or display (for 'suppress' action). */
        message?: string;
        /** Target role (for 'switch-role' action). */
        role?: AgentRole;
        /** Target execution mode (for 'switch-mode' action). */
        mode?: ExecutionMode;
        /** Target provider name (for 'switch-provider' action). */
        provider?: string;
        /** Target model ID (for 'switch-model' action). */
        model?: string;
}

// ---------------------------------------------------------------------------
// ISlashCommand
// ---------------------------------------------------------------------------

/**
 * Definition of a single slash command.
 *
 * Commands are matched by `name` (the part after `/`). The `usage` field
 * shows the full invocation syntax including any arguments. The optional
 * `shortcut` field is displayed in the dropdown UI but is NOT handled here —
 * it is wired by the keyboard-shortcuts system (`src/platform/keyboardShortcuts.ts`).
 *
 * The `role` and `executionMode` fields are declarative hints: if set, the
 * UI can show a badge next to the command indicating it will switch the role
 * or mode. The actual switch is performed by the handler returning the
 * appropriate ISlashCommandResult action.
 */
export interface ISlashCommand {
        /** Command name (without the leading `/`). e.g. 'help'. */
        name: string;
        /** Short description shown in the dropdown. */
        description: string;
        /** Optional keyboard shortcut (e.g. 'Ctrl+/'). Display-only. */
        shortcut?: string;
        /** Full usage string (e.g. '/mode <mode>'). */
        usage: string;
        /** Optional role this command will switch to. Declarative hint for UI. */
        role?: AgentRole;
        /** Optional execution mode this command will switch to. Declarative hint. */
        executionMode?: ExecutionMode;
        /**
         * Handler invoked when the command is executed.
         *
         * @param args The raw argument string after the command name (may be empty).
         * @param context Current context snapshot.
         * @returns The result indicating what action the UI should take.
         */
        handler: (
                args: string,
                context: ISlashCommandContext,
        ) => ISlashCommandResult | Promise<ISlashCommandResult>;
}

// ---------------------------------------------------------------------------
// Helper: format a list of commands for the /help output
// ---------------------------------------------------------------------------

function formatHelpOutput(commands: ISlashCommand[]): string {
        const lines: string[] = ['**Available commands:**\n'];
        for (const cmd of commands) {
                const shortcut = cmd.shortcut ? ` \`${cmd.shortcut}\`` : '';
                lines.push(`- \`${cmd.usage}\`${shortcut} — ${cmd.description}`);
        }
        lines.push(
                '\nType a command name for more details, e.g. `/mode` or `/role`.',
        );
        return lines.join('\n');
}

// ---------------------------------------------------------------------------
// BUILTIN_SLASH_COMMANDS
// ---------------------------------------------------------------------------

/**
 * All built-in slash commands, in the order they appear in the dropdown.
 *
 * To add a new command:
 *   1. Add an entry to this array.
 *   2. If the command has a keyboard shortcut, add a corresponding
 *      IKeyBinding in `src/platform/keyboardShortcuts.ts`.
 *   3. If the command switches role or mode, set the `role` / `executionMode`
 *      declarative fields so the UI can display a badge.
 */
export const BUILTIN_SLASH_COMMANDS: ISlashCommand[] = [
        // --- /help ---------------------------------------------------------------
        {
                name: 'help',
                description: 'Show all available commands',
                shortcut: 'Ctrl+/',
                usage: '/help',
                handler: (_args: string, _context: ISlashCommandContext) => {
                        return {
                                action: 'suppress',
                                message: formatHelpOutput(BUILTIN_SLASH_COMMANDS),
                        };
                },
        },

        // --- /clear --------------------------------------------------------------
        {
                name: 'clear',
                description: 'Clear chat history',
                usage: '/clear',
                handler: (_args: string, _context: ISlashCommandContext) => {
                        return { action: 'clear' };
                },
        },

        // --- /mode ---------------------------------------------------------------
        {
                name: 'mode',
                description: 'Switch execution mode (every, major, selective, auto)',
                usage: '/mode <mode>',
                handler: (args: string, context: ISlashCommandContext) => {
                        const trimmed = args.trim().toLowerCase();
                        if (!trimmed) {
                                const current = context.currentMode;
                                return {
                                        action: 'suppress',
                                        message:
                                                `Current mode: **${current}**\n` +
                                                `Available modes: every, major, selective, auto\n` +
                                                `Usage: \`/mode <mode>\``,
                                };
                        }

                        const targetMode = VALID_EXECUTION_MODES.get(trimmed);
                        if (!targetMode) {
                                return {
                                        action: 'suppress',
                                        message:
                                                `Unknown mode: \`${trimmed}\`\n` +
                                                `Available modes: every, major, selective, auto`,
                                };
                        }

                        return {
                                action: 'switch-mode',
                                mode: targetMode,
                                message: `Switched execution mode to **${targetMode}**`,
                        };
                },
        },

        // --- /role ---------------------------------------------------------------
        {
                name: 'role',
                description: 'Switch agent role (general, architect, coder, reviewer, debugger, ask)',
                usage: '/role <role>',
                handler: (args: string, context: ISlashCommandContext) => {
                        const trimmed = args.trim().toLowerCase();
                        if (!trimmed) {
                                return {
                                        action: 'suppress',
                                        message:
                                                `Current role: **${context.currentRole}**\n` +
                                                `Available roles: general, architect, coder, reviewer, debugger, ask\n` +
                                                `Usage: \`/role <role>\``,
                                };
                        }

                        if (!VALID_AGENT_ROLES.has(trimmed)) {
                                return {
                                        action: 'suppress',
                                        message:
                                                `Unknown role: \`${trimmed}\`\n` +
                                                `Available roles: general, architect, coder, reviewer, debugger, ask`,
                                };
                        }

                        const targetRole = trimmed as AgentRole;
                        return {
                                action: 'switch-role',
                                role: targetRole,
                                message: `Switched agent role to **${AGENT_ROLE_LABELS[targetRole]}**`,
                        };
                },
        },

        // --- /compact ------------------------------------------------------------
        {
                name: 'compact',
                description: 'Summarize conversation to reduce context',
                usage: '/compact',
                handler: (_args: string, context: ISlashCommandContext) => {
                        const msgCount = context.chatHistory.length;
                        if (msgCount === 0) {
                                return {
                                        action: 'suppress',
                                        message: 'Nothing to compact — chat history is empty.',
                                };
                        }
                        // The actual summarisation is performed by the UI layer after
                        // it receives this result. The handler just signals intent.
                        return {
                                action: 'send',
                                message:
                                        `/compact — summarizing ${msgCount} messages to reduce context window usage.`,
                        };
                },
        },

        // --- /undo ---------------------------------------------------------------
        {
                name: 'undo',
                description: 'Undo last agent action',
                usage: '/undo',
                handler: (_args: string, _context: ISlashCommandContext) => {
                        // The actual undo is performed by the UI layer calling
                        // IAgentLoop.undoLastTask(). The handler just signals intent.
                        return {
                                action: 'suppress',
                                message: 'Undoing last agent action...',
                        };
                },
        },

        // --- /diff ---------------------------------------------------------------
        {
                name: 'diff',
                description: 'Show current pending changes',
                usage: '/diff',
                handler: (_args: string, context: ISlashCommandContext) => {
                        const count = context.pendingChangeCount;
                        if (count === 0) {
                                return {
                                        action: 'suppress',
                                        message: 'No pending changes.',
                                };
                        }
                        return {
                                action: 'suppress',
                                message: `You have **${count}** pending change${count === 1 ? '' : 's'} awaiting review.`,
                        };
                },
        },

        // --- /accept-all ---------------------------------------------------------
        {
                name: 'accept-all',
                description: 'Accept all pending changes',
                usage: '/accept-all',
                handler: (_args: string, context: ISlashCommandContext) => {
                        const count = context.pendingChangeCount;
                        if (count === 0) {
                                return {
                                        action: 'suppress',
                                        message: 'No pending changes to accept.',
                                };
                        }
                        return {
                                action: 'suppress',
                                message: `Accepted **${count}** pending change${count === 1 ? '' : 's'}.`,
                        };
                },
        },

        // --- /reject-all ---------------------------------------------------------
        {
                name: 'reject-all',
                description: 'Reject all pending changes',
                usage: '/reject-all',
                handler: (_args: string, context: ISlashCommandContext) => {
                        const count = context.pendingChangeCount;
                        if (count === 0) {
                                return {
                                        action: 'suppress',
                                        message: 'No pending changes to reject.',
                                };
                        }
                        return {
                                action: 'suppress',
                                message: `Rejected **${count}** pending change${count === 1 ? '' : 's'}.`,
                        };
                },
        },

        // --- /swarm --------------------------------------------------------------
        {
                name: 'swarm',
                description: 'Toggle swarm mode on/off',
                usage: '/swarm',
                handler: (_args: string, _context: ISlashCommandContext) => {
                        // The actual toggle is handled by the UI layer. The handler
                        // sends a message so the user sees the state change.
                        return {
                                action: 'send',
                                message: '/swarm — toggling swarm mode.',
                        };
                },
        },

        // --- /model --------------------------------------------------------------
        {
                name: 'model',
                description: 'Switch active model',
                usage: '/model <model>',
                handler: (args: string, context: ISlashCommandContext) => {
                        const trimmed = args.trim();
                        if (!trimmed) {
                                return {
                                        action: 'suppress',
                                        message:
                                                `Current model: **${context.activeModel || '(default)'}**\n` +
                                                `Usage: \`/model <model-id>\``,
                                };
                        }
                        return {
                                action: 'switch-model',
                                model: trimmed,
                                message: `Switched model to **${trimmed}**`,
                        };
                },
        },

        // --- /provider -----------------------------------------------------------
        {
                name: 'provider',
                description: 'Switch provider',
                usage: '/provider <provider>',
                handler: (args: string, context: ISlashCommandContext) => {
                        const trimmed = args.trim().toLowerCase();
                        if (!trimmed) {
                                return {
                                        action: 'suppress',
                                        message:
                                                `Current provider: **${context.activeProvider}**\n` +
                                                `Usage: \`/provider <provider-name>\``,
                                };
                        }
                        return {
                                action: 'switch-provider',
                                provider: trimmed,
                                message: `Switched provider to **${trimmed}**`,
                        };
                },
        },

        // --- /context ------------------------------------------------------------
        {
                name: 'context',
                description: 'Add a file to the conversation context',
                usage: '/context <file>',
                handler: (args: string, _context: ISlashCommandContext) => {
                        const trimmed = args.trim();
                        if (!trimmed) {
                                return {
                                        action: 'suppress',
                                        message: 'Usage: `/context <file-path>` — adds a file to the conversation context.',
                                };
                        }
                        return {
                                action: 'send',
                                message: `/context ${trimmed}`,
                        };
                },
        },

        // --- /reset --------------------------------------------------------------
        {
                name: 'reset',
                description: 'Reset the entire conversation and agent state',
                usage: '/reset',
                handler: (_args: string, _context: ISlashCommandContext) => {
                        return { action: 'reset' };
                },
        },

        // --- /bug ----------------------------------------------------------------
        {
                name: 'bug',
                description: 'Report a bug (opens GitHub issue template)',
                usage: '/bug',
                handler: (_args: string, context: ISlashCommandContext) => {
                        // Build a pre-filled bug report template with current state.
                        const body = [
                                '**Bug Report**\n',
                                '**Provider:** ' + context.activeProvider,
                                '**Model:** ' + (context.activeModel || '(default)'),
                                '**Role:** ' + context.currentRole,
                                '**Mode:** ' + context.currentMode,
                                '**Pending changes:** ' + context.pendingChangeCount,
                                '**Messages in history:** ' + context.chatHistory.length,
                                '\n**Steps to reproduce:**\n',
                                '1. ',
                                '\n**Expected behavior:**\n',
                                '\n**Actual behavior:**\n',
                        ].join('\n');

                        return {
                                action: 'suppress',
                                message:
                                        `Opening bug report template...\n\n${body}\n\n` +
                                        `_Please fill in the steps to reproduce, expected behavior, and actual behavior._`,
                        };
                },
        },
];

// ---------------------------------------------------------------------------
// parseSlashCommand
// ---------------------------------------------------------------------------

/**
 * Parse a raw input string to determine if it is a slash command.
 *
 * A slash command starts with `/` at the very first character and is followed
 * by a command name (alphanumeric + hyphens + underscores). Everything after
 * the first whitespace boundary is treated as arguments.
 *
 * Returns `null` if the input does not start with `/` or if the command name
 * is empty (bare `/` with no following name).
 *
 * @param input Raw user input string.
 * @returns Parsed command name and argument string, or null.
 */
export function parseSlashCommand(
        input: string,
): { command: string; args: string } | null {
        if (!input.startsWith('/')) {
                return null;
        }

        // Bare "/" with nothing after it — show the command menu but no command.
        const rest = input.slice(1);
        if (!rest) {
                return null;
        }

        // Split on the first whitespace boundary.
        const match = rest.match(/^(\S+)\s*(.*)$/);
        if (!match) {
                // No whitespace — the entire rest is the command name.
                return { command: rest.toLowerCase(), args: '' };
        }

        return { command: match[1].toLowerCase(), args: match[2] };
}

// ---------------------------------------------------------------------------
// findMatchingCommands
// ---------------------------------------------------------------------------

/**
 * Find all slash commands whose name starts with the given partial string.
 *
 * Used by the dropdown autocomplete UI: as the user types after `/`,
 * the dropdown filters to show only matching commands.
 *
 * The match is case-insensitive and prefix-based. An empty partial string
 * returns all commands.
 *
 * @param partial Partial command name (without the leading `/`).
 * @returns Array of matching ISlashCommand entries.
 */
export function findMatchingCommands(partial: string): ISlashCommand[] {
        if (!partial) {
                return [...BUILTIN_SLASH_COMMANDS];
        }
        const lower = partial.toLowerCase();
        return BUILTIN_SLASH_COMMANDS.filter((cmd) =>
                cmd.name.startsWith(lower),
        );
}
