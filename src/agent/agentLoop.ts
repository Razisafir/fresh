/**
 * agentLoop.ts — Layer 2 concrete implementation of IAgentLoop.
 *
 * Ported from: `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/agent/agentLoop.ts` (1,946L)
 * Port strategy: PORT WITH TRANSLATION + MAJOR SIMPLIFICATION. The old
 * repo's AgentLoopService had 22 injected dependencies (DI via
 * @IDecorator), an inline 200-line executeTool switch, and pulled in
 * MCP / DiffApplier / ConstructMemory / SnapshotManager / FileWatcher /
 * AgentErrorRecovery / CostGovernor / CreditSystem / ExecutionSanity /
 * MCPServerManager / UniversalMemory / SkillRegistry. Most of those are
 * deferred to v1.0-beta in fresh (per 02_ARCHITECTURE.md §9 non-goals).
 *
 * 02_ARCHITECTURE.md §4.1 lists agentLoop.ts as a Layer 2 port-with-
 * translation file. The simplifications are documented per-row in the
 * §6 mapping table and in 03_MIGRATION_LOG.md Round 2C entry.
 *
 * === WHAT IS PRESERVED (the differentiator) ===
 *   1. Plan→Approve→Execute→Verify loop:
 *      - runPlanningPhase(): read-only LLM round loop, returns IPlanResult.
 *      - User approves the plan (UI layer concern).
 *      - runWithApprovedPlan(): iterates milestones via
 *        executeMilestonesWithPauses(), runs verification between
 *        milestones, fires milestone_reached/paused/resumed/skipped/
 *        completed events.
 *   2. Milestone pause/resume/skip (the Approve gate):
 *      - resumeFromMilestone() resolves the await-resume promise with
 *        'resume' → milestone_completed fires.
 *      - skipCurrentMilestone() resolves with 'skip' → milestone_skipped
 *        fires (NOT completed), helper proceeds to next milestone.
 *   3. Conversation history (F-003 multi-turn fix): each turn's user
 *      message + assistant response + tool calls + tool results are
 *      appended to _conversationHistory and prepended to the next turn.
 *   4. Tool result cache during planning (prevents double-execution).
 *   5. 60s per-LLM-call timeout via AbortController chaining.
 *   6. MAX_ROUNDS = 50 (preserved).
 *   7. extractMilestonesFromPlan() grouping logic (3-5 steps per
 *      milestone, action-type boundaries).
 *   8. parsePlan() regex for [Read]/[Create]/[Edit]/[Run] step lines.
 *
 * === WHAT IS DROPPED (deferred per 02_ARCHITECTURE.md §9) ===
 *   - MCP process integration (mcpProcess.readFile etc.) — replaced by
 *     direct tool registry dispatch. MCP returns in v1.0-beta (M6).
 *   - DiffApplier (edit_file diff parsing) — v0.1 treats edit_file diff
 *     parameter as full new file content per Round 2B's editFile.ts.
 *   - ConstructMemory (Supermemory cloud) — opt-in, deferred.
 *   - UniversalMemory — deferred to v1.0-beta (M5).
 *   - SkillRegistry — deferred (no skills in v0.1).
 *   - SnapshotManager — deferred (undo support lands in v1.0-beta).
 *   - FileWatcher — deferred (real-time file tree diff lands in v1.0).
 *   - AgentErrorRecovery — deferred to v1.0 (retry/skip/abort
 *     classification). v0.1 surfaces errors directly via the 'error'
 *     event; the user can re-run manually.
 *   - CostGovernor / CreditSystem / ExecutionSanity — deferred to
 *     v1.0-beta. v0.1 has no spending gate (the user is presumed to be
 *     using their own API key with their own provider-side limits).
 *   - MCPServerManager — deferred (M6).
 *
 * === WHAT IS SIMPLIFIED ===
 *   - 22 DI deps → 5 constructor args (aiService, toolRegistry,
 *     pendingChanges, workspaceRoots, logger). All singletons obtained
 *     via factory functions, no DI container.
 *   - Inline executeTool switch → delegates to toolRegistry.execute().
 *     The 7 built-in tools (read_file, write_file, list_directory,
 *     edit_file, run_command, search_code, web_fetch) already have
 *     SEC-4/SEC-6/SEC-7/SEC-9/P0-5 baked in (per Round 2B).
 *   - IDialogService.confirm → vscode.window.showWarningMessage with
 *     { modal: true }.
 *   - ICommandService.executeCommand → vscode.commands.executeCommand.
 *   - IFileService → vscode.workspace.fs.
 *   - IWorkspaceContextService → IWorkspaceRootsProvider (already
 *     declared in src/security/workspaceGuard.ts).
 *
 * === SECURITY INVARIANTS PRESERVED ===
 *   - SEC-4: tool registry's file tools call assertWithinWorkspace.
 *   - SEC-6: tool registry's read_file / run_command sanitise output
 *     via PromptSanitiser before returning.
 *   - SEC-7 H4: run_command tool prompts for interpreter commands.
 *   - SEC-7 C3: no shell, parseCommandString + direct spawn (terminalExecutor).
 *   - SEC-9: every spawn routes env through buildChildEnv().
 *   - P0-5: write_file / edit_file ALWAYS stage via pendingChangesService,
 *     NEVER write to disk directly. This is the foundation of the
 *     Approve gate.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-008 (security
 * tools dropped), D-009 (M7 deferred), D-011 (extension route), F-003
 * multi-turn fix, F-007 selectedMilestoneIds fix, P0-5 fix.
 */

import { logger } from '../util/logger';
import {
        IAgentLoop,
        AgentLoopEvent,
        IPlanResult,
        IPlanStep,
        IApprovedPlan,
        IMilestone,
        ExecutionState,
        LoadingState,
        FileChangeEntry,
        IRestoreResult,
} from '../types/agent';
import {
        IChatMessage,
        IToolDefinition,
        IToolCall,
} from '../types/llm';
import { ITool, IConstructToolRegistry } from '../types/tools';
import { IPendingChangesService } from '../diff/pendingChanges';
import { IWorkspaceRootsProvider } from '../security/workspaceGuard';
import { getMemoryService } from '../memory/memoryService';
import { buildSystemPrompt, buildChatSystemPrompt } from './promptBuilder';
import { executeMilestonesWithPauses } from './milestoneExecutor';
import { runVerification, detectVerificationCommand } from './verification';

const MAX_ROUNDS = 50;

/**
 * Cached result of a tool execution, used to avoid double-execution
 * during the planning phase (the LLM streams tool_start → tool_end, and
 * we execute on tool_end; the cache prevents re-execution when building
 * the tool result messages for the next API call).
 */
interface IToolResultCache {
        output: string;
        isError: boolean;
}

/**
 * Constructor dependencies for AgentLoopService.
 *
 * All are singletons obtained from extension.ts factory functions. No
 * DI container — we pass concrete instances. This is the fresh pattern
 * per 02_ARCHITECTURE.md §3 design choice #2.
 */
export interface IAgentLoopDeps {
        aiService: {
                chat(
                        messages: IChatMessage[],
                        tools: IToolDefinition[],
                        options?: { signal?: AbortSignal; systemPrompt?: string; maxTokens?: number; temperature?: number },
                ): AsyncIterable<{ type: 'token'; text: string } | { type: 'tool_start'; toolId: string; toolName: string } | { type: 'tool_input'; toolId: string; text: string } | { type: 'tool_end'; toolId: string; toolName: string; toolInput: unknown } | { type: 'done'; stopReason: string } | { type: 'error'; text: string }>;
        };
        toolRegistry: IConstructToolRegistry;
        pendingChanges: IPendingChangesService;
        workspaceRoots: IWorkspaceRootsProvider;
}

/**
 * AgentLoopService — orchestrates the Plan→Approve→Execute→Verify loop.
 *
 * Singleton — constructed once by extension.ts and accessed via the
 * exported getAgentLoop() accessor. Do not construct additional
 * instances.
 */
export class AgentLoopService implements IAgentLoop {

        // Minimal EventEmitter (replaces vscode.EventEmitter)
        private static _createEmitter<T>() {
                const listeners: Array<(data: T) => void> = [];
                return {
                        event: (listener: (data: T) => void) => {
                                listeners.push(listener);
                                return { dispose: () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
                        },
                        fire: (data: T) => { for (const l of [...listeners]) { try { l(data); } catch { /* swallow */ } } },
                        dispose: () => { listeners.length = 0; },
                };
        }

        private _isRunning = false;
        private _executionState: ExecutionState = ExecutionState.Idle;
        private _currentMilestone: IMilestone | null = null;
        private _milestoneResumeResolver: ((value: 'resume' | 'skip') => void) | null = null;
        private _completedMilestoneIds: Set<string> = new Set();
        private _skippedMilestoneIds: Set<string> = new Set();

        /**
         * Conversation history (F-003 multi-turn fix). Each turn's user
         * message + assistant response + tool calls + tool results are
         * appended here and prepended to the next turn's
         * conversationMessages. Cleared when the user starts a new chat.
         */
        private _conversationHistory: IChatMessage[] = [];

        private readonly _onDidStart = AgentLoopService._createEmitter<string>();
        readonly onDidStart = this._onDidStart.event;
        private readonly _onDidComplete = AgentLoopService._createEmitter<{ summary: string }>();
        readonly onDidComplete = this._onDidComplete.event;
        private readonly _onError = AgentLoopService._createEmitter<{ text: string; recoverable: boolean }>();
        readonly onError = this._onError.event;
        private readonly _onLoadingStateChange = AgentLoopService._createEmitter<LoadingState>();
        readonly onLoadingStateChange = this._onLoadingStateChange.event;
        private readonly _onFileChange = AgentLoopService._createEmitter<FileChangeEntry>();
        readonly onFileChange = this._onFileChange.event;
        private readonly _onDidMilestonePause = AgentLoopService._createEmitter<IMilestone>();
        readonly onDidMilestonePause = this._onDidMilestonePause.event;

        constructor(private readonly deps: IAgentLoopDeps) {
                logger.info('[AgentLoop] Service created (v0.1: 5 deps, no MCP/memory/snapshot/watcher/recovery/cost-governor).');
        }

        // ----------------------------------------------------------------------
        // IAgentLoop properties
        // ----------------------------------------------------------------------

        get isRunning(): boolean {
                return this._isRunning;
        }

        get executionState(): ExecutionState {
                return this._executionState;
        }

        get currentMilestone(): IMilestone | null {
                return this._currentMilestone;
        }

        // ----------------------------------------------------------------------
        // Conversation history (F-003 multi-turn fix)
        // ----------------------------------------------------------------------

        clearConversationHistory(): void {
                this._conversationHistory = [];
                this._completedMilestoneIds.clear();
                this._skippedMilestoneIds.clear();
                logger.info('[AgentLoop] Conversation history cleared');
        }

        // ----------------------------------------------------------------------
        // Tool list builders
        // ----------------------------------------------------------------------

        /**
         * Build the LLM-facing tool list from the registry. Falls back to an
         * empty array if the registry is empty (the LLM will then operate in
         * text-only mode). In v0.1 the registry always has the 7 built-in
         * tools (per Round 2B), so this is just a translation from the
         * registry's ITool shape to the LLM's IToolDefinition shape.
         */
        private getAgentTools(): IToolDefinition[] {
                const registered: ITool[] = this.deps.toolRegistry.listTools();
                return registered.map(t => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: {
                                type: 'object' as const,
                                properties: t.inputSchema.properties as Record<string, unknown>,
                                required: t.inputSchema.required,
                        },
                }));
        }

        /**
         * Read-only tools for the planning phase. The agent can explore the
         * workspace but cannot make changes. Filters the registry's tools
         * down to those with modifiesFiles === false.
         */
        private getPlanningTools(): IToolDefinition[] {
                const all: ITool[] = this.deps.toolRegistry.listTools();
                const readOnly = all.filter(t => !t.modifiesFiles);
                return readOnly.map(t => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: {
                                type: 'object' as const,
                                properties: t.inputSchema.properties as Record<string, unknown>,
                                required: t.inputSchema.required,
                        },
                }));
        }

        // ----------------------------------------------------------------------
        // Planning phase (Plan)
        // ----------------------------------------------------------------------

        async runPlanningPhase(task: string, signal?: AbortSignal): Promise<IPlanResult> {
                logger.info(`[AgentLoop] Planning phase started: ${task}`);

                const workspacePath = this.deps.workspaceRoots.getWorkspaceRoots()[0] ?? '.';

                        // Phase 8-A (M5): retrieve relevant memories from prior tasks and
                        // inject as extraContext. Degrades gracefully — if memory is
                        // disabled (embedProvider=none) or Ollama is down, returns '' and
                        // the agent proceeds without memory context.
                        let memoryContext = '';
                        try {
                                memoryContext = await getMemoryService().retrieve(task, 5);
                        } catch {
                                // Never let memory failure break the agent loop.
                        }

                        const systemPrompt = buildSystemPrompt({
                                task,
                                planningOnly: true,
                                workspacePath,
                                extraContext: memoryContext || undefined,
                        });

                // F-003 multi-turn fix: prepend prior conversation context.
                const conversationMessages: IChatMessage[] = [
                        ...this._conversationHistory,
                        {
                                role: 'user',
                                content: `Analyze the current workspace and create a plan for this task: "${task}"\n\nFirst, explore the workspace to understand its structure, then list the specific steps needed. Use only read_file and list_directory tools.\n\nFormat your response as a numbered list of steps, each starting with [Read], [Create], [Edit], or [Run].`,
                        },
                ];

                let fullResponse = '';

                try {
                        let roundCount = 0;

                        while (roundCount < MAX_ROUNDS) {
                                roundCount++;

                                // Tool result cache: prevents double-execution during planning.
                                const toolResultCache = new Map<string, IToolResultCache>();
                                const assistantToolCalls: IToolCall[] = [];
                                let currentText = '';
                                let stopReason = '';
                                let hadToolCalls = false;

                                // 60s per-LLM-call timeout, chained with user's abort signal.
                                const timeoutController = new AbortController();
                                const timeoutId = setTimeout(() => timeoutController.abort(), 60_000);
                                if (signal) {
                                        signal.addEventListener('abort', () => timeoutController.abort());
                                }

                                const stream = this.deps.aiService.chat(
                                        conversationMessages,
                                        this.getPlanningTools(),
                                        { signal: timeoutController.signal, systemPrompt },
                                );

                                for await (const event of stream) {
                                        if (signal?.aborted) {
                                                clearTimeout(timeoutId);
                                                return { steps: [], summary: 'Cancelled', rawResponse: '' };
                                        }

                                        switch (event.type) {
                                                case 'token':
                                                        currentText += event.text;
                                                        fullResponse += event.text;
                                                        break;
                                                case 'tool_start':
                                                        hadToolCalls = true;
                                                        assistantToolCalls.push({
                                                                id: event.toolId,
                                                                name: event.toolName,
                                                                arguments: '{}',
                                                        });
                                                        break;
                                                case 'tool_end': {
                                                        const toolCall = assistantToolCalls.find(tc => tc.id === event.toolId);
                                                        if (toolCall) {
                                                                toolCall.arguments = JSON.stringify(event.toolInput ?? {});
                                                        }
                                                        // Execute the tool ONCE and cache the result.
                                                        if (!toolResultCache.has(event.toolId)) {
                                                                const toolResult = await this.executeTool(event.toolName, event.toolInput, true);
                                                                toolResultCache.set(event.toolId, {
                                                                        output: toolResult,
                                                                        isError: toolResult.startsWith('Error:'),
                                                                });
                                                        }
                                                        break;
                                                }
                                                case 'done':
                                                        stopReason = event.stopReason;
                                                        break;
                                                case 'error':
                                                        throw new Error(event.text);
                                        }
                                }

                                clearTimeout(timeoutId);

                                // If there were tool calls, add assistant + tool result messages and continue.
                                if (hadToolCalls && stopReason === 'tool_use') {
                                        conversationMessages.push({
                                                role: 'assistant',
                                                content: currentText || '',
                                                toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                                        });

                                        for (const toolCall of assistantToolCalls) {
                                                const cached = toolResultCache.get(toolCall.id);
                                                if (cached) {
                                                        conversationMessages.push({
                                                                role: 'tool',
                                                                content: cached.output,
                                                                toolCallId: toolCall.id,
                                                        });
                                                } else {
                                                        // Fallback: should not happen, but execute once if cache miss.
                                                        logger.warn(`[AgentLoop] Cache miss for tool ${toolCall.id}, executing as fallback`);
                                                        const input = JSON.parse(toolCall.arguments);
                                                        const result = await this.executeTool(toolCall.name, input, true);
                                                        conversationMessages.push({
                                                                role: 'tool',
                                                                content: result,
                                                                toolCallId: toolCall.id,
                                                        });
                                                }
                                        }
                                        continue;
                                }

                                // End turn — planning complete.
                                break;
                        }

                        // Parse the plan from the response.
                        const steps = this.parsePlan(fullResponse);

                        // F-003 fix: remember this turn so the next turn has context.
                        this._conversationHistory.push(
                                { role: 'user', content: task },
                                { role: 'assistant', content: fullResponse },
                        );

                        return {
                                steps,
                                summary: fullResponse,
                                rawResponse: fullResponse,
                        };
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        logger.error(`[AgentLoop] Planning error: ${msg}`);
                        throw error;
                }
        }

        // ----------------------------------------------------------------------
        // Chat mode (Cursor-like: no plan/approve, direct tool use)
        // ----------------------------------------------------------------------

        /**
         * Chat mode: an agentic loop that uses a conversational system prompt
         * and executes tools autonomously without plan/approve gates.
         *
         * Like Cursor — the user types a message, the AI responds with
         * optional tool use, no approval required. Conversation history
         * persists across turns.
         *
         * Yields AgentLoopEvent for streaming tokens, tool calls, and
         * results back to the renderer.
         */
        async *chat(text: string, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
                if (this._isRunning) {
                        yield { type: 'error', text: 'Agent loop is already running.', recoverable: false };
                        return;
                }

                this._isRunning = true;
                this._onDidStart.fire(text);
                this._executionState = ExecutionState.Executing;
                logger.info(`[AgentLoop] Chat mode started: ${text}`);

                try {
                        const workspacePath = this.deps.workspaceRoots.getWorkspaceRoots()[0] ?? '.';
                        const systemPrompt = buildChatSystemPrompt({ workspacePath });

                        // F-003 multi-turn: prepend prior conversation context.
                        const conversationMessages: IChatMessage[] = [
                                ...this._conversationHistory,
                                { role: 'user', content: text },
                        ];

                        let roundCount = 0;
                        let finalSummary = '';

                        while (roundCount < MAX_ROUNDS) {
                                roundCount++;
                                logger.info(`[AgentLoop] Chat round ${roundCount}/${MAX_ROUNDS}`);

                                const assistantToolCalls: IToolCall[] = [];
                                const toolResults: { toolUseId: string; toolName: string; result: string; success: boolean; filePath?: string }[] = [];
                                let currentText = '';
                                let stopReason = '';
                                let hasToolCalls = false;

                                const timeoutController = new AbortController();
                                const timeoutId = setTimeout(() => timeoutController.abort(), 60_000);
                                if (signal) {
                                        signal.addEventListener('abort', () => timeoutController.abort());
                                }

                                const stream = this.deps.aiService.chat(
                                        conversationMessages,
                                        this.getAgentTools(),
                                        { signal: timeoutController.signal, systemPrompt },
                                );

                                for await (const event of stream) {
                                        if (signal?.aborted) {
                                                clearTimeout(timeoutId);
                                                yield { type: 'error', text: '[STOP] Stopped by user', recoverable: false };
                                                this._isRunning = false;
                                                return;
                                        }

                                        switch (event.type) {
                                                case 'token':
                                                        currentText += event.text;
                                                        yield { type: 'token', text: event.text };
                                                        break;

                                                case 'tool_start':
                                                        hasToolCalls = true;
                                                        assistantToolCalls.push({
                                                                id: event.toolId,
                                                                name: event.toolName,
                                                                arguments: '{}',
                                                        });
                                                        yield { type: 'tool_start', toolId: event.toolId, toolName: event.toolName };
                                                        break;

                                                case 'tool_input':
                                                        yield { type: 'tool_executing', toolId: event.toolId, toolName: '', detail: event.text };
                                                        break;

                                                case 'tool_end': {
                                                        const toolCall = assistantToolCalls.find(tc => tc.id === event.toolId);
                                                        if (toolCall) {
                                                                toolCall.arguments = JSON.stringify(event.toolInput ?? {});
                                                        }

                                                        yield { type: 'tool_executing', toolId: event.toolId, toolName: event.toolName, detail: 'Executing...' };

                                                        const toolResult = await this.executeTool(event.toolName, event.toolInput, false);
                                                        const success = !toolResult.startsWith('Error:');

                                                        yield { type: 'tool_result', toolId: event.toolId, toolName: event.toolName, result: toolResult, success };

                                                        // Track file-written events for the UI's pending-changes panel.
                                                        let filePath: string | undefined;
                                                        if ((event.toolName === 'write_file' || event.toolName === 'edit_file') && success) {
                                                                const toolInput = event.toolInput as Record<string, string> | null;
                                                                filePath = toolInput?.path ?? '';
                                                                if (filePath) {
                                                                        yield { type: 'file_written', filePath };
                                                                }
                                                        }

                                                        toolResults.push({
                                                                toolUseId: event.toolId,
                                                                toolName: event.toolName,
                                                                result: toolResult,
                                                                success,
                                                                filePath,
                                                        });
                                                        break;
                                                }

                                                case 'done':
                                                        stopReason = event.stopReason;
                                                        break;

                                                case 'error':
                                                        yield { type: 'error', text: event.text, recoverable: true };
                                                        break;
                                        }
                                }

                                clearTimeout(timeoutId);

                                if (hasToolCalls && toolResults.length > 0) {
                                        conversationMessages.push({
                                                role: 'assistant',
                                                content: currentText || '(executing tools)',
                                                toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                                        });

                                        for (const tr of toolResults) {
                                                conversationMessages.push({
                                                        role: 'tool',
                                                        content: tr.result,
                                                        toolCallId: tr.toolUseId,
                                                });
                                        }
                                }

                                if (stopReason === 'end_turn' || !hasToolCalls) {
                                        finalSummary = currentText;
                                        break;
                                }
                        }

                        // F-003 fix: remember this turn for multi-turn context.
                        this._conversationHistory.push(
                                { role: 'user', content: text },
                                { role: 'assistant', content: finalSummary },
                        );

                        this._executionState = ExecutionState.Complete;
                        this._onDidComplete.fire({ summary: finalSummary });
                        yield { type: 'complete', summary: finalSummary };
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        logger.error(`[AgentLoop] Chat mode error: ${msg}`);
                        this._executionState = ExecutionState.Error;
                        this._onError.fire({ text: msg, recoverable: true });
                        yield { type: 'error', text: msg, recoverable: true };
                } finally {
                        this._isRunning = false;
                }
        }

        // ----------------------------------------------------------------------
        // Direct execution (run, no milestone pausing)
        // ----------------------------------------------------------------------

        async *run(task: string, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
                if (this._isRunning) {
                        yield { type: 'error', text: 'Agent loop is already running.', recoverable: false };
                        return;
                }

                this._isRunning = true;
                this._onDidStart.fire(task);
                this._executionState = ExecutionState.Executing;
                logger.info(`[AgentLoop] Execution started: ${task}`);

                try {
                        const workspacePath = this.deps.workspaceRoots.getWorkspaceRoots()[0] ?? '.';
                        const systemPrompt = buildSystemPrompt({
                                task,
                                planningOnly: false,
                                workspacePath,
                        });

                        // F-003 multi-turn fix: prepend prior conversation context.
                        const conversationMessages: IChatMessage[] = [
                                ...this._conversationHistory,
                                { role: 'user', content: task },
                        ];

                        let roundCount = 0;
                        let finalSummary = '';

                        while (roundCount < MAX_ROUNDS) {
                                roundCount++;
                                logger.info(`[AgentLoop] Round ${roundCount}/${MAX_ROUNDS}`);

                                const assistantToolCalls: IToolCall[] = [];
                                const toolResults: { toolUseId: string; toolName: string; result: string; success: boolean; filePath?: string }[] = [];
                                let currentText = '';
                                let stopReason = '';
                                let hasToolCalls = false;

                                const timeoutController = new AbortController();
                                const timeoutId = setTimeout(() => timeoutController.abort(), 60_000);
                                if (signal) {
                                        signal.addEventListener('abort', () => timeoutController.abort());
                                }

                                const stream = this.deps.aiService.chat(
                                        conversationMessages,
                                        this.getAgentTools(),
                                        { signal: timeoutController.signal, systemPrompt },
                                );

                                for await (const event of stream) {
                                        if (signal?.aborted) {
                                                clearTimeout(timeoutId);
                                                yield { type: 'error', text: '[STOP] Stopped by user', recoverable: false };
                                                this._isRunning = false;
                                                return;
                                        }

                                        switch (event.type) {
                                                case 'token':
                                                        currentText += event.text;
                                                        yield { type: 'token', text: event.text };
                                                        break;

                                                case 'tool_start':
                                                        hasToolCalls = true;
                                                        assistantToolCalls.push({
                                                                id: event.toolId,
                                                                name: event.toolName,
                                                                arguments: '{}',
                                                        });
                                                        yield { type: 'tool_start', toolId: event.toolId, toolName: event.toolName };
                                                        break;

                                                case 'tool_input':
                                                        yield { type: 'tool_executing', toolId: event.toolId, toolName: '', detail: event.text };
                                                        break;

                                                case 'tool_end': {
                                                        const toolCall = assistantToolCalls.find(tc => tc.id === event.toolId);
                                                        if (toolCall) {
                                                                toolCall.arguments = JSON.stringify(event.toolInput ?? {});
                                                        }

                                                        yield { type: 'tool_executing', toolId: event.toolId, toolName: event.toolName, detail: 'Executing...' };

                                                        const toolResult = await this.executeTool(event.toolName, event.toolInput, false);
                                                        const success = !toolResult.startsWith('Error:');

                                                        yield { type: 'tool_result', toolId: event.toolId, toolName: event.toolName, result: toolResult, success };

                                                        // Track file-written events for the UI's pending-changes panel.
                                                        let filePath: string | undefined;
                                                        if ((event.toolName === 'write_file' || event.toolName === 'edit_file') && success) {
                                                                const toolInput = event.toolInput as Record<string, string> | null;
                                                                filePath = toolInput?.path ?? '';
                                                                if (filePath) {
                                                                        yield { type: 'file_written', filePath };
                                                                }
                                                        }

                                                        toolResults.push({
                                                                toolUseId: event.toolId,
                                                                toolName: event.toolName,
                                                                result: toolResult,
                                                                success,
                                                                filePath,
                                                        });
                                                        break;
                                                }

                                                case 'done':
                                                        stopReason = event.stopReason;
                                                        break;

                                                case 'error':
                                                        yield { type: 'error', text: event.text, recoverable: true };
                                                        break;
                                        }
                                }

                                clearTimeout(timeoutId);

                                if (hasToolCalls && toolResults.length > 0) {
                                        conversationMessages.push({
                                                role: 'assistant',
                                                content: currentText || '(executing tools)',
                                                toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                                        });

                                        for (const tr of toolResults) {
                                                conversationMessages.push({
                                                        role: 'tool',
                                                        content: tr.result,
                                                        toolCallId: tr.toolUseId,
                                                });
                                        }
                                }

                                if (stopReason === 'end_turn' || !hasToolCalls) {
                                        finalSummary = currentText;
                                        break;
                                }
                        }

                        // F-003 fix: remember this turn.
                        this._conversationHistory.push(
                                { role: 'user', content: task },
                                { role: 'assistant', content: finalSummary },
                        );

                        // Phase 8-A (M5): store this task + outcome as a memory entry for
                        // future recall. Fire-and-forget — never block the complete event
                        // on memory storage. Degrades gracefully if memory is disabled.
                        try {
                                void getMemoryService().store(
                                        `Task: ${task}\n\nOutcome: ${finalSummary}`,
                                        { type: 'task_completion', milestoneCount: this._completedMilestoneIds.size },
                                );
                        } catch {
                                // Memory storage failure is non-fatal.
                        }

                        this._executionState = ExecutionState.Complete;
                        this._onDidComplete.fire({ summary: finalSummary });
                        yield { type: 'complete', summary: finalSummary };
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        logger.error(`[AgentLoop] Execution error: ${msg}`);
                        this._executionState = ExecutionState.Error;
                        this._onError.fire({ text: msg, recoverable: true });
                        yield { type: 'error', text: msg, recoverable: true };
                } finally {
                        this._isRunning = false;
                }
        }

        // ----------------------------------------------------------------------
        // Execution with approved plan + milestone pausing (the full flow)
        // ----------------------------------------------------------------------

        async *runWithApprovedPlan(approvedPlan: IApprovedPlan, signal?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
                if (this._isRunning) {
                        yield { type: 'error', text: 'Agent loop is already running.', recoverable: false };
                        return;
                }

                this._isRunning = true;
                this._onDidStart.fire(approvedPlan.task);
                this._executionState = ExecutionState.Executing;
                logger.info(`[AgentLoop] runWithApprovedPlan started: ${approvedPlan.task} (${approvedPlan.milestones.length} milestones, mode=${approvedPlan.executionMode})`);

                try {
                        const workspacePath = this.deps.workspaceRoots.getWorkspaceRoots()[0] ?? '.';
                        const systemPrompt = buildSystemPrompt({
                                task: approvedPlan.task,
                                planningOnly: false,
                                workspacePath,
                        });

                        // The executeSubTask callback: runs ONE milestone's worth of LLM + tool loop.
                        const executeSubTask = async function* (this: AgentLoopService, subTask: string, sig?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
                                const conversationMessages: IChatMessage[] = [
                                        ...this._conversationHistory,
                                        { role: 'user', content: subTask },
                                ];

                                let roundCount = 0;
                                let milestoneSummary = '';

                                while (roundCount < MAX_ROUNDS) {
                                        roundCount++;
                                        logger.info(`[AgentLoop] Round ${roundCount}/${MAX_ROUNDS} (milestone sub-task)`);

                                        const assistantToolCalls: IToolCall[] = [];
                                        const toolResults: { toolUseId: string; toolName: string; result: string; success: boolean; filePath?: string }[] = [];
                                        let currentText = '';
                                        let stopReason = '';
                                        let hasToolCalls = false;

                                        const timeoutController = new AbortController();
                                        const timeoutId = setTimeout(() => timeoutController.abort(), 60_000);
                                        if (sig) {
                                                sig.addEventListener('abort', () => timeoutController.abort());
                                        }

                                        const stream = this.deps.aiService.chat(
                                                conversationMessages,
                                                this.getAgentTools(),
                                                { signal: timeoutController.signal, systemPrompt },
                                        );

                                        for await (const event of stream) {
                                                if (sig?.aborted) {
                                                        clearTimeout(timeoutId);
                                                        yield { type: 'error', text: '[STOP] Stopped by user', recoverable: false };
                                                        return;
                                                }

                                                switch (event.type) {
                                                        case 'token':
                                                                currentText += event.text;
                                                                yield { type: 'token', text: event.text };
                                                                break;

                                                        case 'tool_start':
                                                                hasToolCalls = true;
                                                                assistantToolCalls.push({
                                                                        id: event.toolId,
                                                                        name: event.toolName,
                                                                        arguments: '{}',
                                                                });
                                                                yield { type: 'tool_start', toolId: event.toolId, toolName: event.toolName };
                                                                break;

                                                        case 'tool_input':
                                                                yield { type: 'tool_executing', toolId: event.toolId, toolName: '', detail: event.text };
                                                                break;

                                                        case 'tool_end': {
                                                                const toolCall = assistantToolCalls.find(tc => tc.id === event.toolId);
                                                                if (toolCall) {
                                                                        toolCall.arguments = JSON.stringify(event.toolInput ?? {});
                                                                }

                                                                yield { type: 'tool_executing', toolId: event.toolId, toolName: event.toolName, detail: 'Executing...' };

                                                                const toolResult = await this.executeTool(event.toolName, event.toolInput, false);
                                                                const success = !toolResult.startsWith('Error:');

                                                                yield { type: 'tool_result', toolId: event.toolId, toolName: event.toolName, result: toolResult, success };

                                                                let filePath: string | undefined;
                                                                if ((event.toolName === 'write_file' || event.toolName === 'edit_file') && success) {
                                                                        const toolInput = event.toolInput as Record<string, string> | null;
                                                                        filePath = toolInput?.path ?? '';
                                                                        if (filePath) {
                                                                                yield { type: 'file_written', filePath };
                                                                        }
                                                                }

                                                                toolResults.push({
                                                                        toolUseId: event.toolId,
                                                                        toolName: event.toolName,
                                                                        result: toolResult,
                                                                        success,
                                                                        filePath,
                                                                });
                                                                break;
                                                        }

                                                        case 'done':
                                                                stopReason = event.stopReason;
                                                                break;

                                                        case 'error':
                                                                yield { type: 'error', text: event.text, recoverable: true };
                                                                break;
                                                }
                                        }

                                        clearTimeout(timeoutId);

                                        if (hasToolCalls && toolResults.length > 0) {
                                                conversationMessages.push({
                                                        role: 'assistant',
                                                        content: currentText || '(executing tools)',
                                                        toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                                                });

                                                for (const tr of toolResults) {
                                                        conversationMessages.push({
                                                                role: 'tool',
                                                                content: tr.result,
                                                                toolCallId: tr.toolUseId,
                                                        });
                                                }
                                        }

                                        if (stopReason === 'end_turn' || !hasToolCalls) {
                                                milestoneSummary = currentText;
                                                break;
                                        }
                                }

                                // F-003 fix: remember this milestone's turn.
                                this._conversationHistory.push(
                                        { role: 'user', content: subTask },
                                        { role: 'assistant', content: milestoneSummary },
                                );
                        }.bind(this);

                        // The runVerification callback: runs the harness check.
                        const runVerificationFn = async function* (this: AgentLoopService, sig?: AbortSignal): AsyncGenerator<AgentLoopEvent> {
                                this._executionState = ExecutionState.Verifying;
                                const detected = await detectVerificationCommand();

                                if (!detected.command) {
                                        yield {
                                                type: 'verification_result',
                                                passed: true,
                                                output: 'unverified:no-command — workspace has no automated check',
                                                unverified: true,
                                        };
                                        return;
                                }

                                yield { type: 'verification_start', command: detected.command };

                                const result = await runVerification(sig);
                                yield {
                                        type: 'verification_result',
                                        passed: result.passed,
                                        output: result.output,
                                        unverified: result.unverified,
                                };
                        }.bind(this);

                        // The awaitResume callback: resolves when the user calls
                        // resumeFromMilestone() or skipCurrentMilestone().
                        const awaitResume = (milestone: IMilestone): Promise<'resume' | 'skip'> => {
                                return new Promise<'resume' | 'skip'>(resolve => {
                                        this._milestoneResumeResolver = resolve;
                                        this._onDidMilestonePause.fire(milestone);
                                });
                        };

                        // Drive the milestone iteration helper.
                        let aggregatedSummary = '';
                        for await (const event of executeMilestonesWithPauses({
                                approvedPlan,
                                executeSubTask,
                                runVerification: runVerificationFn,
                                awaitResume,
                                signal,
                                log: (msg: string) => logger.info(msg),
                        })) {
                                // Observe milestone events to drive production state.
                                if (event.type === 'milestone_reached') {
                                        this._executionState = ExecutionState.Executing;
                                        this._currentMilestone = event.milestone;
                                } else if (event.type === 'milestone_paused') {
                                        this._executionState = ExecutionState.PausedAtMilestone;
                                } else if (event.type === 'milestone_resumed') {
                                        this._executionState = ExecutionState.Executing;
                                } else if (event.type === 'milestone_skipped') {
                                        this._skippedMilestoneIds.add(event.milestone.id);
                                        this._currentMilestone = null;
                                } else if (event.type === 'milestone_completed') {
                                        this._completedMilestoneIds.add(event.milestone.id);
                                        this._currentMilestone = null;
                                } else if (event.type === 'token') {
                                        aggregatedSummary += event.text;
                                }

                                yield event;

                                // Surface verification failures as recoverable errors.
                                if (event.type === 'verification_result' && !event.passed && !event.unverified) {
                                        this._executionState = ExecutionState.VerificationFailed;
                                }
                        }

                        this._executionState = ExecutionState.Complete;
                        this._onDidComplete.fire({ summary: aggregatedSummary });
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        logger.error(`[AgentLoop] runWithApprovedPlan error: ${msg}`);
                        this._executionState = ExecutionState.Error;
                        this._onError.fire({ text: msg, recoverable: true });
                        yield { type: 'error', text: msg, recoverable: true };
                } finally {
                        this._isRunning = false;
                        this._milestoneResumeResolver = null;
                }
        }

        // ----------------------------------------------------------------------
        // Milestone resume / skip
        // ----------------------------------------------------------------------

        resumeFromMilestone(): void {
                if (this._milestoneResumeResolver) {
                        this._executionState = ExecutionState.Executing;
                        this._milestoneResumeResolver('resume');
                        this._milestoneResumeResolver = null;
                        this._currentMilestone = null;
                }
        }

        skipCurrentMilestone(): void {
                if (this._milestoneResumeResolver) {
                        this._executionState = ExecutionState.Executing;
                        this._milestoneResumeResolver('skip');
                        this._milestoneResumeResolver = null;
                        this._currentMilestone = null;
                }
        }

        // ----------------------------------------------------------------------
        // Plan parsing + milestone extraction
        // ----------------------------------------------------------------------

        /**
         * Parse a plan from the LLM's text response.
         *
         * Matches lines like "1. [Read] src/App.tsx" or "[Create] new-file.tsx".
         * Also matches more natural formats like:
         *   - "1. Read src/App.tsx" or "1. Read: src/App.tsx"
         *   - "Step 1: Read the workspace"
         *   - "- Read the current file"
         *   - "**Create** a new file"
         *
         * If no structured steps are found, creates a smart fallback based
         * on the task description (detecting whether the task involves
         * creating, editing, or just reading).
         */
        private parsePlan(response: string): IPlanStep[] {
                const steps: IPlanStep[] = [];
                const lines = response.split('\n');

                let stepIndex = 0;
                for (const line of lines) {
                        // Pattern 1: Original "[Action]" format (e.g., "1. [Create] file.txt")
                        const bracketMatch = line.match(/^\s*\d+\.?\s*\[(Read|Create|Edit|Run)\]\s*(.+)/i);
                        // Pattern 2: Natural "Action:" format (e.g., "1. Read: workspace" or "2. Create a file called hello.txt")
                        const naturalMatch = line.match(/^\s*\d+\.?\s*\*?\*?(Read|Create|Edit|Run)\*?\*?\s*[:\-–]\s*(.+)/i);
                        // Pattern 3: "Step N: Action" format (e.g., "Step 1: Read the workspace")
                        const stepMatch = line.match(/^\s*(?:Step\s+)?\d+\.?\s*[:\-–]\s*(Read|Create|Edit|Run)\s+(.+)/i);

                        const match = bracketMatch || naturalMatch || stepMatch;
                        if (match) {
                                const action = (match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase()) as IPlanStep['action'];
                                const target = match[2].trim();
                                steps.push({
                                        index: stepIndex++,
                                        action,
                                        target,
                                        description: line.trim(),
                                });
                        }
                }

                if (steps.length === 0) {
                        // Smart fallback: analyze the response to detect the primary action type.
                        // This ensures milestones are properly categorized (e.g., Create steps
                        // are "major" and trigger pauses in major_milestone mode).
                        const lower = response.toLowerCase();
                        let action: IPlanStep['action'] = 'Read';
                        let target = 'workspace';

                        if (/\b(create|write|add|new file|generate)\b/i.test(lower)) {
                                action = 'Create';
                                // Try to extract a filename from the response
                                const fileMatch = lower.match(/(?:called|named|write\s+to|create)\s+[`"']?([\w.-]+\.?\w*)[`"']?/i);
                                target = fileMatch ? fileMatch[1] : 'new files';
                        } else if (/\b(edit|modify|update|change|fix|patch)\b/i.test(lower)) {
                                action = 'Edit';
                                target = 'existing files';
                        } else if (/\b(run|execute|install|build|test)\b/i.test(lower)) {
                                action = 'Run';
                                target = 'commands';
                        }

                        steps.push({
                                index: 0,
                                action,
                                target,
                                description: response.substring(0, 200),
                        });
                }

                return steps;
        }

        /**
         * Extract milestones from a plan's steps.
         * Groups consecutive steps into milestones, marking major ones at
         * natural boundaries (after every 3-5 steps or when the action type
         * changes to a different category).
         *
         * Preserved verbatim from old repo.
         */
        extractMilestonesFromPlan(steps: IPlanStep[]): IMilestone[] {
                if (steps.length === 0) {
                        return [];
                }

                const milestones: IMilestone[] = [];
                let currentGroup: number[] = [];
                let milestoneIndex = 0;

                for (let i = 0; i < steps.length; i++) {
                        currentGroup.push(i);

                        const isNaturalBoundary =
                                currentGroup.length >= 3 &&
                                (i === steps.length - 1 ||
                                        (steps[i].action === 'Run' && steps[i + 1]?.action !== 'Run') ||
                                        (steps[i].action === 'Create' && steps[i + 1]?.action !== 'Create') ||
                                        currentGroup.length >= 5);

                        if (isNaturalBoundary) {
                                const firstStep = steps[currentGroup[0]];
                                const lastStep = steps[currentGroup[currentGroup.length - 1]];
                                const isMajor = currentGroup.some(idx =>
                                        steps[idx].action === 'Create' || steps[idx].action === 'Run',
                                );

                                milestones.push({
                                        id: `milestone-${milestoneIndex}`,
                                        name: `${firstStep.action}: ${firstStep.target}${currentGroup.length > 1 ? ` -> ${lastStep.target}` : ''}`,
                                        description: `Steps ${currentGroup[0] + 1}-${currentGroup[currentGroup.length - 1] + 1}`,
                                        index: milestoneIndex,
                                        isMajor,
                                        stepIndices: [...currentGroup],
                                        completed: false,
                                });

                                currentGroup = [];
                                milestoneIndex++;
                        }
                }

                if (currentGroup.length > 0) {
                        const firstStep = steps[currentGroup[0]];
                        milestones.push({
                                id: `milestone-${milestoneIndex}`,
                                name: `${firstStep.action}: ${firstStep.target}`,
                                description: `Steps ${currentGroup[0] + 1}-${currentGroup[currentGroup.length - 1] + 1}`,
                                index: milestoneIndex,
                                isMajor: currentGroup.some(idx =>
                                        steps[idx].action === 'Create' || steps[idx].action === 'Run',
                                ),
                                stepIndices: [...currentGroup],
                                completed: false,
                        });
                }

                return milestones;
        }

        // ----------------------------------------------------------------------
        // Undo (stub — snapshot manager deferred to v1.0-beta)
        // ----------------------------------------------------------------------

        async undoLastTask(): Promise<IRestoreResult | null> {
                logger.info('[AgentLoop] undoLastTask: snapshot manager deferred to v1.0-beta — returning null');
                return null;
        }

        // ----------------------------------------------------------------------
        // Tool execution (delegates to the registry)
        // ----------------------------------------------------------------------

        /**
         * Execute a tool by name via the tool registry.
         *
         * In the old repo this was a 200-line switch statement that
         * re-implemented each tool's logic inline. In fresh, all 7 built-in
         * tools are registered with the tool registry (Round 2B) and have
         * their own execute functions with SEC-4/SEC-6/SEC-7/SEC-9/P0-5
         * baked in. We just dispatch.
         *
         * The `readOnly` flag is enforced here as a defence-in-depth: even
         * if the LLM somehow calls a modifying tool during planning, we
         * reject it before reaching the registry.
         */
        private async executeTool(name: string, input: unknown, readOnly: boolean): Promise<string> {
                const args = (input as Record<string, unknown> | null) ?? {};

                // Defence-in-depth: enforce readOnly during planning.
                if (readOnly) {
                        const tool = this.deps.toolRegistry.getTool(name);
                        if (tool?.modifiesFiles) {
                                return `Error: ${name} not available during planning phase`;
                        }
                }

                try {
                        const result = await this.deps.toolRegistry.execute(name, args);
                        if (!result.success) {
                                return `Error: ${result.output}`;
                        }
                        return result.output;
                } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        logger.error(`[AgentLoop] Tool execution failed for ${name}: ${msg}`);
                        return `Error: ${msg}`;
                }
        }

        // ----------------------------------------------------------------------
        // Dispose
        // ----------------------------------------------------------------------

        dispose(): void {
                this._onDidStart.dispose();
                this._onDidComplete.dispose();
                this._onError.dispose();
                this._onLoadingStateChange.dispose();
                this._onFileChange.dispose();
                this._onDidMilestonePause.dispose();
                logger.info('[AgentLoop] Disposed');
        }
}

// ----------------------------------------------------------------------
// Singleton accessor (mirrors the pattern from Round 2A/2B)
// ----------------------------------------------------------------------

let _agentLoop: AgentLoopService | undefined;

/**
 * Initialise the singleton AgentLoopService. Called once by extension.ts
 * during activate(). Throws if called twice without an intervening
 * resetAgentLoop() (test helper).
 */
export function initAgentLoop(deps: IAgentLoopDeps): AgentLoopService {
        if (_agentLoop) {
                throw new Error('AgentLoopService already initialised. Call resetAgentLoop() first.');
        }
        _agentLoop = new AgentLoopService(deps);
        return _agentLoop;
}

/**
 * Get the singleton AgentLoopService. Returns undefined if initAgentLoop()
 * has not been called yet (e.g., during unit tests).
 */
export function getAgentLoop(): AgentLoopService | undefined {
        return _agentLoop;
}

/**
 * Test helper: reset the singleton. NOT for production use.
 */
export function resetAgentLoop(): void {
        if (_agentLoop) {
                _agentLoop.dispose();
                _agentLoop = undefined;
        }
}
