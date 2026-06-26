/**
 * Integration test: AgentLoopService Plan→Approve→Execute→Verify happy path.
 *
 * Constructs a real AgentLoopService with MOCK collaborators and verifies
 * the security + correctness invariants of the planning phase, the
 * milestone extractor, and the F-003 multi-turn conversation fix.
 *
 * The vscode-shim at node_modules/vscode/index.js provides EventEmitter /
 * Disposable so AgentLoopService can be constructed in plain Node.
 */

import { expect } from 'chai';
import * as vscode from 'vscode';
import {
        AgentLoopService,
        IAgentLoopDeps,
        resetAgentLoop,
} from '../../src/agent/agentLoop';
import { ITool, IToolResult, IConstructToolRegistry, ToolExecuteFn } from '../../src/types/tools';
import { IPendingChangesService, PendingChangeEntry } from '../../src/diff/pendingChanges';
import { IWorkspaceRootsProvider } from '../../src/security/workspaceGuard';
import { IChatMessage, IToolDefinition } from '../../src/types/llm';
import { ISelectablePlanStep } from '../../src/types/agent';

// --- Mock collaborators -----------------------------------------------------

type ChatEvent =
        | { type: 'token'; text: string }
        | { type: 'tool_start'; toolId: string; toolName: string }
        | { type: 'tool_input'; toolId: string; text: string }
        | { type: 'tool_end'; toolId: string; toolName: string; toolInput: unknown }
        | { type: 'done'; stopReason: string }
        | { type: 'error'; text: string };

/** Fake AI service that returns pre-scripted responses from a queue. */
type MockAIServiceType = IAgentLoopDeps['aiService'];
class MockAIService implements MockAIServiceType {
        public callLog: Array<{ messages: IChatMessage[]; tools: IToolDefinition[] }> = [];
        public responses: AsyncGenerator<ChatEvent>[] = [];

        constructor(responses: AsyncGenerator<ChatEvent>[] = []) {
                this.responses = [...responses];
        }

        async *chat(messages: IChatMessage[], tools: IToolDefinition[], _options?: { signal?: AbortSignal; systemPrompt?: string }): AsyncGenerator<ChatEvent> {
                this.callLog.push({ messages: [...messages], tools: [...tools] });
                const response = this.responses.shift();
                if (!response) {
                        yield { type: 'error', text: 'MockAIService: no more canned responses' };
                        return;
                }
                yield* response;
        }
}

/** Fake tool registry that records every execute() call and returns canned results. */
class MockToolRegistry implements IConstructToolRegistry {
        public executeCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
        public tools: Map<string, { tool: ITool; executeFn: ToolExecuteFn }> = new Map();

        constructor(private results: Record<string, IToolResult> = {}) {}

        registerTool(tool: ITool, executeFn: ToolExecuteFn): void {
                this.tools.set(tool.name, { tool, executeFn });
        }
        unregisterTool(name: string): void {
                this.tools.delete(name);
        }
        listTools(): ITool[] {
                return [...this.tools.values()].map(e => e.tool);
        }
        getTool(name: string): ITool | undefined {
                return this.tools.get(name)?.tool;
        }
        async execute(name: string, args: Record<string, unknown>, _signal?: AbortSignal): Promise<IToolResult> {
                this.executeCalls.push({ name, args });
                const entry = this.tools.get(name);
                if (entry) {
                        return entry.executeFn(args);
                }
                return this.results[name] ?? { success: true, output: `<mock ${name} output>`, truncated: false };
        }
        dispose(): void { /* no-op */ }
}

/** Fake pending-changes service that records stage calls in memory. */
class MockPendingChanges implements IPendingChangesService {
        public staged: PendingChangeEntry[] = [];
        private _onDidChange = new vscode.EventEmitter<void>();

        get onDidChangePendingChanges() { return this._onDidChange.event; }
        get pendingEntries(): ReadonlyArray<PendingChangeEntry> { return [...this.staged]; }

        async stageFile(uri: vscode.Uri, proposedContent: string): Promise<void> {
                this.staged.push({
                        uri, originalContent: '', proposedContent, isNewFile: true,
                });
                this._onDidChange.fire();
        }
        async stageEdit(uri: vscode.Uri, _diff: string): Promise<void> {
                this.staged.push({
                        uri, originalContent: '', proposedContent: '', isNewFile: false,
                });
                this._onDidChange.fire();
        }
        async accept(uri: vscode.Uri): Promise<void> {
                this.staged = this.staged.filter(e => e.uri.toString() !== uri.toString());
                this._onDidChange.fire();
        }
        async reject(uri: vscode.Uri): Promise<void> {
                this.staged = this.staged.filter(e => e.uri.toString() !== uri.toString());
                this._onDidChange.fire();
        }
        async acceptAll(): Promise<void> {
                this.staged = [];
                this._onDidChange.fire();
        }
        async rejectAll(): Promise<void> {
                this.staged = [];
                this._onDidChange.fire();
        }
        getOriginalContent(_uri: vscode.Uri): string | undefined { return ''; }
        getProposedContent(uri: vscode.Uri): string | undefined {
                return this.staged.find(e => e.uri.toString() === uri.toString())?.proposedContent;
        }
        hasPendingChanges(): boolean { return this.staged.length > 0; }
        dispose(): void { this._onDidChange.dispose(); }
}

/** Helper: build a canned LLM response from tokens + tool calls. */
async function* cannedResponse(
        tokens: string[],
        toolCalls: Array<{ id: string; name: string; input: unknown }> = [],
        stopReason = 'end_turn',
): AsyncGenerator<ChatEvent> {
        for (const t of tokens) {
                yield { type: 'token', text: t };
        }
        for (const tc of toolCalls) {
                yield { type: 'tool_start', toolId: tc.id, toolName: tc.name };
                yield { type: 'tool_end', toolId: tc.id, toolName: tc.name, toolInput: tc.input };
        }
        yield { type: 'done', stopReason };
}

const stubWorkspaceRoots: IWorkspaceRootsProvider = {
        getWorkspaceRoots: () => [process.cwd()],
};

function makeTool(opts: { name: string; modifiesFiles: boolean; requiresNetwork?: boolean; output?: string }): ITool {
        return {
                name: opts.name,
                description: `mock ${opts.name}`,
                inputSchema: { type: 'object', properties: {}, required: [] },
                modifiesFiles: opts.modifiesFiles,
                requiresNetwork: opts.requiresNetwork ?? false,
                category: 'file',
        };
}

// --- Tests ------------------------------------------------------------------

describe('AgentLoopService (integration)', () => {
        afterEach(() => {
                resetAgentLoop();
        });

        describe('runPlanningPhase()', () => {
                it('returns parsed steps from the LLM response', async () => {
                        const ai = new MockAIService([
                                cannedResponse([
                                        'Here is my plan:\n',
                                        '1. [Read] src/file.ts\n',
                                        '2. [Edit] src/file.ts to add the new function\n',
                                        '3. [Run] npm test\n',
                                ]),
                        ]);

                        const tools = new MockToolRegistry();
                        const pending = new MockPendingChanges();
                        const loop = new AgentLoopService({
                                aiService: ai, toolRegistry: tools, pendingChanges: pending,
                                workspaceRoots: stubWorkspaceRoots,
                        });

                        const plan = await loop.runPlanningPhase('add a function');

                        expect(plan.steps).to.have.lengthOf(3);
                        expect(plan.steps[0].action).to.equal('Read');
                        expect(plan.steps[0].target).to.equal('src/file.ts');
                        expect(plan.steps[1].action).to.equal('Edit');
                        expect(plan.steps[2].action).to.equal('Run');
                });

                it('uses only read-only tools during planning (write_file / edit_file excluded)', async () => {
                        const ai = new MockAIService([
                                cannedResponse(['1. [Read] file.ts\n']),
                        ]);

                        const tools = new MockToolRegistry();
                        tools.registerTool(
                                makeTool({ name: 'read_file', modifiesFiles: false }),
                                async () => ({ success: true, output: 'content', truncated: false }),
                        );
                        tools.registerTool(
                                makeTool({ name: 'write_file', modifiesFiles: true }),
                                async () => ({ success: true, output: 'wrote', truncated: false }),
                        );

                        const pending = new MockPendingChanges();
                        const loop = new AgentLoopService({
                                aiService: ai, toolRegistry: tools, pendingChanges: pending,
                                workspaceRoots: stubWorkspaceRoots,
                        });

                        await loop.runPlanningPhase('explore');

                        const planningCall = ai.callLog[0];
                        expect(planningCall.tools.some(t => t.name === 'read_file')).to.be.true;
                        expect(planningCall.tools.some(t => t.name === 'write_file')).to.be.false;
                });

                it('returns empty steps + "Cancelled" summary when signal is already aborted', async () => {
                        const ai = new MockAIService([]);
                        const tools = new MockToolRegistry();
                        const pending = new MockPendingChanges();
                        const loop = new AgentLoopService({
                                aiService: ai, toolRegistry: tools, pendingChanges: pending,
                                workspaceRoots: stubWorkspaceRoots,
                        });

                        const ac = new AbortController();
                        ac.abort();
                        const plan = await loop.runPlanningPhase('task', ac.signal);

                        expect(plan.steps).to.have.lengthOf(0);
                        expect(plan.summary).to.equal('Cancelled');
                });

                it('caches tool results during planning (no double-execution on the same tool call)', async () => {
                        const ai = new MockAIService([
                                (async function* () {
                                        yield { type: 'token', text: 'Let me explore.\n' };
                                        yield { type: 'tool_start', toolId: 'tc-1', toolName: 'read_file' };
                                        yield { type: 'tool_end', toolId: 'tc-1', toolName: 'read_file', toolInput: { path: 'src/file.ts' } };
                                        yield { type: 'done', stopReason: 'tool_use' };
                                })(),
                                cannedResponse(['1. [Read] file.ts\n']),
                        ]);

                        const tools = new MockToolRegistry();
                        tools.registerTool(
                                makeTool({ name: 'read_file', modifiesFiles: false }),
                                async () => ({ success: true, output: 'file contents', truncated: false }),
                        );

                        const pending = new MockPendingChanges();
                        const loop = new AgentLoopService({
                                aiService: ai, toolRegistry: tools, pendingChanges: pending,
                                workspaceRoots: stubWorkspaceRoots,
                        });

                        await loop.runPlanningPhase('explore');

                        const readCalls = tools.executeCalls.filter(c => c.name === 'read_file');
                        expect(readCalls).to.have.lengthOf(1, 'tool result cache should prevent double-execution');
                });
        });

        describe('extractMilestonesFromPlan()', () => {
                it('groups consecutive steps into milestones', () => {
                        const ai = new MockAIService([]);
                        const tools = new MockToolRegistry();
                        const pending = new MockPendingChanges();
                        const loop = new AgentLoopService({
                                aiService: ai, toolRegistry: tools, pendingChanges: pending,
                                workspaceRoots: stubWorkspaceRoots,
                        });

                        // Use a Run step in the MIDDLE so the "Run followed by non-Run"
                        // boundary fires and creates 2 milestones. (A Run at the end only
                        // creates 1 milestone because it's the last step.)
                        const steps: ISelectablePlanStep[] = [
                                { index: 0, action: 'Read', target: 'a.ts', description: 'r', selected: true },
                                { index: 1, action: 'Read', target: 'b.ts', description: 'r', selected: true },
                                { index: 2, action: 'Read', target: 'c.ts', description: 'r', selected: true },
                                { index: 3, action: 'Run', target: 'npm install', description: 'install', selected: true },
                                { index: 4, action: 'Edit', target: 'a.ts', description: 'e', selected: true },
                                { index: 5, action: 'Run', target: 'npm test', description: 'test', selected: true },
                        ];

                        const milestones = loop.extractMilestonesFromPlan(steps);

                        expect(milestones.length).to.be.greaterThanOrEqual(2);
                        const allIndices = milestones.flatMap(m => m.stepIndices);
                        expect(allIndices).to.have.members([0, 1, 2, 3, 4, 5]);
                        expect(milestones.some(m => m.isMajor)).to.be.true;
                });

                it('returns empty array for empty steps', () => {
                        const ai = new MockAIService([]);
                        const tools = new MockToolRegistry();
                        const pending = new MockPendingChanges();
                        const loop = new AgentLoopService({
                                aiService: ai, toolRegistry: tools, pendingChanges: pending,
                                workspaceRoots: stubWorkspaceRoots,
                        });

                        expect(loop.extractMilestonesFromPlan([])).to.have.lengthOf(0);
                });
        });

        describe('clearConversationHistory() (F-003 multi-turn fix)', () => {
                it('persists conversation history across planning calls (F-003 fix)', async () => {
                        const ai = new MockAIService([
                                cannedResponse(['1. [Read] a\n']),
                                cannedResponse(['1. [Read] b\n']),
                                cannedResponse(['1. [Read] c\n']),
                        ]);

                        const tools = new MockToolRegistry();
                        const pending = new MockPendingChanges();
                        const loop = new AgentLoopService({
                                aiService: ai, toolRegistry: tools, pendingChanges: pending,
                                workspaceRoots: stubWorkspaceRoots,
                        });

                        // First call: only the new user message
                        await loop.runPlanningPhase('first task');
                        expect(ai.callLog[0].messages).to.have.lengthOf(1);

                        // Second call: prior context prepended (F-003 fix)
                        await loop.runPlanningPhase('second task');
                        expect(ai.callLog[1].messages.length).to.be.greaterThan(1, 'second call should have prior context prepended');

                        // Clear and verify it goes back to 1 message
                        loop.clearConversationHistory();
                        await loop.runPlanningPhase('third task');
                        expect(ai.callLog[2].messages).to.have.lengthOf(1, 'after clear, only the new user message should be present');
                });
        });

        describe('undoLastTask() (stub — snapshot manager deferred)', () => {
                it('returns null (snapshot manager is deferred to v1.0-beta)', async () => {
                        const ai = new MockAIService([]);
                        const tools = new MockToolRegistry();
                        const pending = new MockPendingChanges();
                        const loop = new AgentLoopService({
                                aiService: ai, toolRegistry: tools, pendingChanges: pending,
                                workspaceRoots: stubWorkspaceRoots,
                        });

                        const result = await loop.undoLastTask();
                        expect(result).to.be.null;
                });
        });
});
