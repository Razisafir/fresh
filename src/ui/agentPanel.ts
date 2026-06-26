/**
 * agentPanel.ts — Kovix agent chat WebviewViewProvider.
 *
 * Round 2D deliverable (per ISSUES.md O-001, D-012, D-013). Implements
 * `vscode.WebviewViewProvider` and binds the webview at
 * `src/ui/webview/agentPanel.{html,css,js}` to the AgentLoopService
 * singleton.
 *
 * **R-008 fix:** uses `WebviewViewProvider` (NOT `openView`). The
 * `openView()` API on the auxiliary bar has a known reliability bug
 * (it doesn't reliably expand the bar on first launch). Registering
 * the view via `registerWebviewViewProvider` and letting the activity-
 * bar icon click resolve the view is the VS Code-recommended pattern.
 * This is the fix documented in `docs/ISSUES.md` R-008.
 *
 * **Architecture:**
 *   - The provider owns the webview's HTML/CSS/JS asset URIs.
 *   - The provider does NOT own the agent loop. The agent loop is a
 *     singleton obtained via `getAgentLoop()`. The provider subscribes
 *     to its async generator output and forwards events as postMessage.
 *   - The provider owns ONE AbortController per active run, used to
 *     cancel an in-flight planning + execution cycle when the user
 *     clicks Stop / Abort / Cancel.
 *   - The provider is the single bridge between the agent loop's
 *     AsyncGenerator<AgentLoopEvent> and the webview's postMessage
 *     inbox. No other component writes to the webview.
 *
 * **CSP:** the webview HTML is generated server-side with a strict
 * Content Security Policy: default-src 'none', style-src 'unsafe-inline'
 * (CSS is injected as a `<style>` tag), script-src 'nonce-<random>'.
 * The JS file is loaded via a `<script nonce="...">` tag.
 *
 * Decisions referenced: D-011 (extension route), D-012 (2-webview scope),
 * D-013 (Material aesthetic), R-008 (WebviewViewProvider fix), P0-5
 * (pending changes gate).
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { logger } from '../util/logger';
import { getAgentLoop } from '../agent/agentLoop';
import { pendingChangesService } from '../diff/pendingChangesService';
import {
        AgentLoopEvent,
        ExecutionState,
        IApprovedPlan,
        IPlanResult,
        ISelectablePlanStep,
} from '../types/agent';

/**
 * Minimal view of the AI service that the provider needs. Defining this
 * locally (rather than importing ConstructAIService from `../llm/aiService`)
 * avoids a circular dependency: agentPanel → extension → commands →
 * agentPanel. The concrete ConstructAIService structurally satisfies this
 * interface, so the call site in `extension.ts` just passes the instance.
 */
export interface IAIServiceInfo {
        readonly activeProviderType: string | undefined;
}

/** View ID — must match `package.json` `contributes.views.kovix[0].id`. */
export const AGENT_PANEL_VIEW_ID = 'kovix.agentPanel';

/**
 * Messages flowing from the webview → extension host.
 * Mirrors the protocol documented in `agentPanel.js`.
 */
type WebviewInboundMessage =
        | { type: 'ready' }
        | { type: 'sendTask'; text: string }
        | { type: 'cancel' }
        | { type: 'approvePlan'; executionMode: 'every_milestone' | 'major_milestone' | 'selective' | 'full_auto' }
        | { type: 'cancelPlan' }
        | { type: 'resumeMilestone' }
        | { type: 'skipMilestone' }
        | { type: 'abortMilestone' }
        | { type: 'acceptPending'; filePath: string }
        | { type: 'rejectPending'; filePath: string }
        | { type: 'viewDiff'; filePath: string }
        | { type: 'clearConversation' }
        | { type: 'manageApiKeys' };

/**
 * Messages flowing from the extension host → webview.
 * Mirrors the protocol documented in `agentPanel.js`.
 */
type WebviewOutboundMessage =
        | { type: 'ready'; activeProvider: string | null; hasApiKey: boolean }
        | { type: 'agentState'; state: 'idle' | 'planning' | 'running' | 'paused' | 'complete' | 'error' }
        | { type: 'userMessage'; text: string; timestamp: number }
        | { type: 'agentMessageStart'; timestamp: number }
        | { type: 'token'; text: string }
        | { type: 'agentMessageEnd' }
        | { type: 'thinking' }
        | {
                type: 'plan';
                task: string;
                milestones: Array<{
                        id: string;
                        name: string;
                        steps: Array<{ index: number; action: string; target: string; description: string }>;
                }>;
        }
        | { type: 'toolStart'; toolId: string; toolName: string }
        | { type: 'toolInput'; toolId: string; text: string }
        | { type: 'toolEnd'; toolId: string; toolName: string; success: boolean; result: string; durationMs?: number }
        | { type: 'fileWritten'; filePath: string; isNew: boolean }
        | { type: 'milestoneReached'; milestone: { id: string; name: string; description: string } }
        | { type: 'milestonePaused'; milestone: { id: string; name: string; description: string } }
        | { type: 'milestoneResumed'; milestone: { id: string; name: string } }
        | { type: 'milestoneSkipped'; milestone: { id: string; name: string } }
        | { type: 'milestoneCompleted'; milestone: { id: string; name: string } }
        | { type: 'verificationStart'; command: string }
        | { type: 'verificationResult'; passed: boolean; output: string; unverified: boolean }
        | { type: 'pendingChanges'; entries: Array<{ filePath: string; isNew: boolean }> }
        | { type: 'pendingChangeAccepted'; filePath: string }
        | { type: 'pendingChangeRejected'; filePath: string }
        | { type: 'complete'; summary: string }
        | { type: 'error'; text: string; recoverable: boolean }
        | { type: 'cleared' };

/**
 * Singleton provider instance. Set in `registerAgentPanel()` and
 * accessed by `getAgentPanel()` so command handlers can call
 * `provider.focus()` when the user runs `Kovix: Open Agent Panel`.
 */
let _provider: AgentPanelViewProvider | undefined;

/**
 * Register the agent panel webview view provider with VS Code.
 * Called once by `extension.ts activate()`.
 *
 * @param context Extension context — used for subscriptions + webview asset URIs.
 * @param aiService The AI service singleton (used to report active provider
 *   + key status to the webview on `ready`). Passed in here rather than
 *   imported from `extension.ts` to avoid a circular dependency.
 * @returns The provider instance (also accessible later via getAgentPanel()).
 */
export function registerAgentPanel(
        context: vscode.ExtensionContext,
        aiService: IAIServiceInfo,
): AgentPanelViewProvider {
        if (_provider) {
                return _provider;
        }
        _provider = new AgentPanelViewProvider(context, aiService);
        const registration = vscode.window.registerWebviewViewProvider(
                AGENT_PANEL_VIEW_ID,
                _provider,
                {
                        webviewOptions: {
                                // retainContextWhenHidden keeps the webview alive when the
                                // user collapses the auxiliary bar. Costs ~10MB RAM; worth
                                // it because re-creating the conversation DOM on every
                                // toggle would lose the in-flight streaming state.
                                retainContextWhenHidden: true,
                        },
                },
        );
        context.subscriptions.push(registration);
        context.subscriptions.push(_provider);
        return _provider;
}

/** Accessor for the singleton provider (used by command handlers). */
export function getAgentPanel(): AgentPanelViewProvider | undefined {
        return _provider;
}

// =========================================================================
// Provider
// =========================================================================

export class AgentPanelViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {

        private _view: vscode.WebviewView | undefined;
        private readonly _disposables: vscode.Disposable[] = [];

        /** Abort controller for the active run (planning + execution). */
        private _abortController: AbortController | undefined;

        /** Map of toolId → start timestamp, for duration reporting. */
        private _toolStartTimes: Map<string, number> = new Map();

        /** Resolves to true when the user clicks Approve in the webview. */
        private _planApprovalResolver: ((value: { executionMode: string } | null) => void) | undefined;

        /**
         * Whether we've sent an `agentMessageStart` for the current agent
         * turn. Reset to false whenever a non-token event arrives that
         * breaks the stream (tool_start, milestone, complete, error).
         */
        private _streamingMessageOpen = false;

        constructor(
                private readonly _context: vscode.ExtensionContext,
                private readonly _aiService: IAIServiceInfo,
        ) {
                // Subscribe to pending-changes updates so the webview stays in
                // sync even when the host (not the webview) accepts/rejects.
                // The onDidChangePending event is optional in the interface —
                // wire it defensively.
                const onChange = (pendingChangesService as unknown as {
                        onDidChangePending?: vscode.Event<void>;
                }).onDidChangePending;
                if (onChange) {
                        this._disposables.push(onChange(() => this.pushPendingSnapshot()));
                }
        }

        // -------------------------------------------------------------------------
        // WebviewViewProvider
        // -------------------------------------------------------------------------

        /**
         * Called by VS Code when the user first opens the view (clicks the
         * Kovix activity bar icon). We configure the webview's options,
         * wire up the message listener, and inject the HTML.
         */
        resolveWebviewView(view: vscode.WebviewView, _context: vscode.WebviewViewResolveContext): void {
                this._view = view;

                view.webview.options = {
                        enableScripts: true,
                        // Restrict the webview to only load resources from our
                        // extension's directory. No external network, no other
                        // extensions' files.
                        localResourceRoots: [
                                vscode.Uri.joinPath(this._context.extensionUri, 'src', 'ui', 'webview'),
                                vscode.Uri.joinPath(this._context.extensionUri, 'media'),
                        ],
                };

                // Wire up the inbound message handler.
                const messageDisposable = view.webview.onDidReceiveMessage(
                        (msg: WebviewInboundMessage) => this.onMessage(msg),
                        this,
                        this._context.subscriptions,
                );
                this._disposables.push(messageDisposable);

                // Re-render HTML on VS Code theme change (so the webview can
                // re-apply its tokens; for v0.1 we're dark-only, but the wiring
                // is here so v1.0-beta light theme lands as a one-line toggle).
                const themeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
                        // For v0.1 we don't actually need to re-render — the CSS
                        // is static. But we re-inject to allow future theme hooks.
                        const view = this._view;
                        if (view) {
                                view.webview.html = this._buildHtml();
                        }
                });
                this._disposables.push(themeDisposable);

                // Set the initial HTML.
                view.webview.html = this._buildHtml();

                logger.info('[AgentPanel] Webview resolved.');
        }

        // -------------------------------------------------------------------------
        // Public surface (called by command handlers + extension.ts)
        // -------------------------------------------------------------------------

        /**
         * Bring the agent panel into focus (reveals the auxiliary bar if
         * hidden, then focuses the view). Used by the `kovix.openAgentPanel`
         * command — fixes R-008 (openView was unreliable).
         */
        async focus(): Promise<void> {
                if (!this._view) {
                        // The view hasn't been resolved yet. Force-resolve it by
                        // calling VS Code's built-in command with our view ID.
                        await vscode.commands.executeCommand(`${AGENT_PANEL_VIEW_ID}.focus`);
                        return;
                }
                this._view.show?.(true);
        }

        /**
         * Push a state update to the webview. Called by command handlers
         * when something happens outside the agent loop (e.g. the user
         * changed the API key via `kovix.manageApiKeys`).
         */
        notifyAgentState(state: 'idle' | 'planning' | 'running' | 'paused' | 'complete' | 'error'): void {
                this.postMessage({ type: 'agentState', state });
        }

        // -------------------------------------------------------------------------
        // Inbound message handler (webview → host)
        // -------------------------------------------------------------------------

        private async onMessage(msg: WebviewInboundMessage): Promise<void> {
                try {
                        switch (msg.type) {
                                case 'ready':                 return this.onWebviewReady();
                                case 'sendTask':              return this.onSendTask(msg.text);
                                case 'cancel':                return this.onCancel();
                                case 'approvePlan':           return this.onApprovePlan(msg.executionMode);
                                case 'cancelPlan':            return this.onCancelPlan();
                                case 'resumeMilestone':       return this.onResumeMilestone();
                                case 'skipMilestone':         return this.onSkipMilestone();
                                case 'abortMilestone':        return this.onAbortMilestone();
                                case 'acceptPending':         return this.onAcceptPending(msg.filePath);
                                case 'rejectPending':         return this.onRejectPending(msg.filePath);
                                case 'viewDiff':              return this.onViewDiff(msg.filePath);
                                case 'clearConversation':     return this.onClearConversation();
                                case 'manageApiKeys':         return this.onManageApiKeys();
                                default:
                                        logger.warn(`[AgentPanel] Unknown inbound message: ${(msg as { type?: string }).type}`);
                        }
                } catch (err) {
                        const text = err instanceof Error ? err.message : String(err);
                        logger.error(`[AgentPanel] Error handling ${msg.type}: ${text}`);
                        this.postMessage({ type: 'error', text: `Internal error: ${text}`, recoverable: true });
                }
        }

        private onWebviewReady(): void {
                // Push initial state to the webview.
                const provider = this._aiService.activeProviderType ?? null;
                const hasKey = provider ? this._hasApiKey(provider) : false;
                this.postMessage({ type: 'ready', activeProvider: provider, hasApiKey: hasKey });
                this.pushPendingSnapshot();
                this.syncAgentState();
        }

        private async onSendTask(text: string): Promise<void> {
                const agentLoop = getAgentLoop();
                if (!agentLoop) {
                        this.postMessage({ type: 'error', text: 'Agent loop is not initialised. Reload the window.', recoverable: false });
                        return;
                }
                if (agentLoop.isRunning) {
                        this.postMessage({ type: 'error', text: 'Agent is already running. Stop it first.', recoverable: true });
                        return;
                }
                if (!text || !text.trim()) {
                        return;
                }

                // Echo the user message into the chat transcript.
                this.postMessage({ type: 'userMessage', text, timestamp: Date.now() });

                // Start planning phase.
                this.postMessage({ type: 'agentState', state: 'planning' });
                this.postMessage({ type: 'thinking' });

                this._abortController = new AbortController();
                try {
                        const plan = await agentLoop.runPlanningPhase(text, this._abortController.signal);
                        this._abortController = undefined;

                        // Send the plan to the webview for approval.
                        this.sendPlanToWebview(text, plan);
                        this.postMessage({ type: 'agentState', state: 'idle' });
                } catch (err) {
                        this._abortController = undefined;
                        const text = err instanceof Error ? err.message : String(err);
                        const aborted = err instanceof Error && err.name === 'AbortError';
                        if (aborted) {
                                this.postMessage({ type: 'agentMessageEnd' });
                                this.postMessage({ type: 'agentState', state: 'idle' });
                                this.postMessage({ type: 'error', text: 'Task cancelled.', recoverable: true });
                        } else {
                                this.postMessage({ type: 'agentState', state: 'error' });
                                this.postMessage({ type: 'error', text: `Planning failed: ${text}`, recoverable: true });
                        }
                }
        }

        private onCancel(): void {
                this._abortController?.abort();
        }

        private onApprovePlan(executionMode: string): void {
                const resolver = this._planApprovalResolver;
                this._planApprovalResolver = undefined;
                if (resolver) {
                        resolver({ executionMode });
                }
        }

        private onCancelPlan(): void {
                const resolver = this._planApprovalResolver;
                this._planApprovalResolver = undefined;
                if (resolver) {
                        resolver(null);
                }
        }

        private onResumeMilestone(): void {
                const agentLoop = getAgentLoop();
                if (!agentLoop) { return; }
                if (agentLoop.executionState !== ExecutionState.PausedAtMilestone) {
                        this.postMessage({ type: 'error', text: 'Not currently paused at a milestone.', recoverable: true });
                        return;
                }
                agentLoop.resumeFromMilestone();
        }

        private onSkipMilestone(): void {
                const agentLoop = getAgentLoop();
                if (!agentLoop) { return; }
                if (agentLoop.executionState !== ExecutionState.PausedAtMilestone) {
                        this.postMessage({ type: 'error', text: 'Not currently paused at a milestone.', recoverable: true });
                        return;
                }
                agentLoop.skipCurrentMilestone();
        }

        private onAbortMilestone(): void {
                this._abortController?.abort();
                // Dismiss the banner immediately; the agent loop will emit
                // 'error' or 'complete' as it unwinds.
                this.postMessage({ type: 'agentState', state: 'idle' });
        }

        private async onAcceptPending(filePath: string): Promise<void> {
                const uri = vscode.Uri.file(filePath);
                try {
                        await pendingChangesService.accept(uri);
                        this.postMessage({ type: 'pendingChangeAccepted', filePath });
                        this.pushPendingSnapshot();
                } catch (err) {
                        const text = err instanceof Error ? err.message : String(err);
                        this.postMessage({ type: 'error', text: `Accept failed: ${text}`, recoverable: true });
                }
        }

        private async onRejectPending(filePath: string): Promise<void> {
                const uri = vscode.Uri.file(filePath);
                try {
                        await pendingChangesService.reject(uri);
                        this.postMessage({ type: 'pendingChangeRejected', filePath });
                        this.pushPendingSnapshot();
                } catch (err) {
                        const text = err instanceof Error ? err.message : String(err);
                        this.postMessage({ type: 'error', text: `Reject failed: ${text}`, recoverable: true });
                }
        }

        private async onViewDiff(filePath: string): Promise<void> {
                // Open the staged content in a new editor for review.
                const uri = vscode.Uri.file(filePath);
                const entry = [...pendingChangesService.pendingEntries].find(
                        (e) => e.uri.toString() === uri.toString(),
                );
                if (!entry) {
                        this.postMessage({ type: 'error', text: `Pending entry not found: ${filePath}`, recoverable: true });
                        return;
                }
                const doc = await vscode.workspace.openTextDocument({
                        content: entry.proposedContent,
                        language: 'plaintext',
                });
                await vscode.window.showTextDocument(doc, { preview: true });
        }

        private onClearConversation(): void {
                const agentLoop = getAgentLoop();
                if (!agentLoop) { return; }
                if (agentLoop.isRunning) {
                        this.postMessage({ type: 'error', text: 'Cannot clear history while the agent is running.', recoverable: true });
                        return;
                }
                agentLoop.clearConversationHistory();
                this.postMessage({ type: 'cleared' });
        }

        private onManageApiKeys(): void {
                vscode.commands.executeCommand('kovix.manageApiKeys');
        }

        // -------------------------------------------------------------------------
        // Plan + execution orchestration
        // -------------------------------------------------------------------------

        /**
         * Send the plan to the webview for approval, then wait for the
         * user's response. If approved, build an IApprovedPlan and start
         * the execution phase, streaming events to the webview.
         */
        private sendPlanToWebview(task: string, plan: IPlanResult): void {
                const agentLoop = getAgentLoop();
                if (!agentLoop) { return; }

                const milestones = agentLoop.extractMilestonesFromPlan(plan.steps);
                const milestonePayload = milestones.map((m) => ({
                        id: m.id,
                        name: m.name,
                        steps: m.stepIndices.map((idx) => {
                                const s = plan.steps[idx];
                                return {
                                        index: idx + 1,
                                        action: s.action,
                                        target: s.target,
                                        description: s.description,
                                };
                        }),
                }));

                this.postMessage({
                        type: 'plan',
                        task,
                        milestones: milestonePayload,
                });

                // Wait for the webview to send approvePlan or cancelPlan.
                new Promise<{ executionMode: string } | null>((resolve) => {
                        this._planApprovalResolver = resolve;
                }).then((result) => {
                        if (!result) {
                                // User cancelled — nothing more to do.
                                return;
                        }
                        const selectedSteps: ISelectablePlanStep[] = plan.steps.map((s) => ({
                                index: s.index,
                                action: s.action,
                                target: s.target,
                                description: s.description,
                                selected: true,
                        }));
                        const approvedPlan: IApprovedPlan = {
                                task,
                                steps: selectedSteps,
                                executionMode: result.executionMode,
                                milestones,
                                approved: true,
                                approvedAt: Date.now(),
                        };
                        void this.runExecution(approvedPlan);
                });
        }

        /**
         * Run the execution phase, streaming AgentLoopEvents to the webview.
         */
        private async runExecution(approvedPlan: IApprovedPlan): Promise<void> {
                const agentLoop = getAgentLoop();
                if (!agentLoop) { return; }

                this.postMessage({ type: 'agentState', state: 'running' });
                this._abortController = new AbortController();
                this._streamingMessageOpen = false;

                try {
                        for await (const event of agentLoop.runWithApprovedPlan(approvedPlan, this._abortController.signal)) {
                                this.forwardAgentLoopEvent(event);
                        }
                } catch (err) {
                        const text = err instanceof Error ? err.message : String(err);
                        const aborted = err instanceof Error && err.name === 'AbortError';
                        // Close any open streaming message before emitting the
                        // terminal state.
                        if (this._streamingMessageOpen) {
                                this.postMessage({ type: 'agentMessageEnd' });
                                this._streamingMessageOpen = false;
                        }
                        if (aborted) {
                                this.postMessage({ type: 'agentState', state: 'idle' });
                                this.postMessage({ type: 'error', text: 'Task aborted.', recoverable: true });
                        } else {
                                this.postMessage({ type: 'agentState', state: 'error' });
                                this.postMessage({ type: 'error', text: `Execution failed: ${text}`, recoverable: true });
                        }
                } finally {
                        this._abortController = undefined;
                        this._toolStartTimes.clear();
                        this._streamingMessageOpen = false;
                }
        }

        /**
         * Translate an AgentLoopEvent into one or more webview messages.
         * This is the only place the agent loop's event union touches the
         * webview's protocol — keeping the mapping here makes both sides
         * independently evolvable.
         */
        private forwardAgentLoopEvent(event: AgentLoopEvent): void {
                switch (event.type) {
                        case 'thinking':
                                // Close any open streaming message so the thinking
                                // indicator renders cleanly.
                                if (this._streamingMessageOpen) {
                                        this.postMessage({ type: 'agentMessageEnd' });
                                        this._streamingMessageOpen = false;
                                }
                                this.postMessage({ type: 'thinking' });
                                break;
                        case 'token':
                                // Open a streaming agent message on the first token of a
                                // new turn (or after a tool call breaks the stream).
                                if (!this._streamingMessageOpen) {
                                        this.postMessage({ type: 'agentMessageStart', timestamp: Date.now() });
                                        this._streamingMessageOpen = true;
                                }
                                this.postMessage({ type: 'token', text: event.text });
                                break;
                        case 'tool_start':
                                // A tool call closes the current streaming message —
                                // tool cards attach to the parent agent message.
                                if (this._streamingMessageOpen) {
                                        this.postMessage({ type: 'agentMessageEnd' });
                                        this._streamingMessageOpen = false;
                                }
                                this._toolStartTimes.set(event.toolId, Date.now());
                                this.postMessage({ type: 'toolStart', toolId: event.toolId, toolName: event.toolName });
                                break;
                        case 'tool_executing':
                                this.postMessage({ type: 'toolInput', toolId: event.toolId, text: event.detail ?? '' });
                                break;
                        case 'tool_result': {
                                const start = this._toolStartTimes.get(event.toolId);
                                const durationMs = start ? Date.now() - start : undefined;
                                this._toolStartTimes.delete(event.toolId);
                                this.postMessage({
                                        type: 'toolEnd',
                                        toolId: event.toolId,
                                        toolName: event.toolName,
                                        success: event.success,
                                        result: event.result,
                                        durationMs,
                                });
                                break;
                        }
                        case 'file_written': {
                                // Look up the pending entry for this file to determine
                                // isNew. The pending changes service is the source of
                                // truth (P0-5: every write stages through it).
                                const uri = vscode.Uri.file(event.filePath);
                                const entry = [...pendingChangesService.pendingEntries].find(
                                        (e) => e.uri.toString() === uri.toString(),
                                );
                                this.postMessage({
                                        type: 'fileWritten',
                                        filePath: event.filePath,
                                        isNew: entry?.isNewFile ?? false,
                                });
                                // Push the updated snapshot so the pending section
                                // reflects the new entry immediately.
                                this.pushPendingSnapshot();
                                break;
                        }
                        case 'milestone_reached':
                                this.postMessage({
                                        type: 'milestoneReached',
                                        milestone: { id: event.milestone.id, name: event.milestone.name, description: event.milestone.description },
                                });
                                break;
                        case 'milestone_paused':
                                this.postMessage({
                                        type: 'milestonePaused',
                                        milestone: { id: event.milestone.id, name: event.milestone.name, description: event.milestone.description },
                                });
                                this.postMessage({ type: 'agentState', state: 'paused' });
                                break;
                        case 'milestone_resumed':
                                this.postMessage({
                                        type: 'milestoneResumed',
                                        milestone: { id: event.milestone.id, name: event.milestone.name },
                                });
                                this.postMessage({ type: 'agentState', state: 'running' });
                                break;
                        case 'milestone_skipped':
                                this.postMessage({
                                        type: 'milestoneSkipped',
                                        milestone: { id: event.milestone.id, name: event.milestone.name },
                                });
                                this.postMessage({ type: 'agentState', state: 'running' });
                                break;
                        case 'milestone_completed':
                                this.postMessage({
                                        type: 'milestoneCompleted',
                                        milestone: { id: event.milestone.id, name: event.milestone.name },
                                });
                                break;
                        case 'verification_start':
                                this.postMessage({ type: 'verificationStart', command: event.command });
                                break;
                        case 'verification_result':
                                this.postMessage({
                                        type: 'verificationResult',
                                        passed: event.passed,
                                        output: event.output,
                                        unverified: event.unverified ?? false,
                                });
                                break;
                        case 'complete':
                                if (this._streamingMessageOpen) {
                                        this.postMessage({ type: 'agentMessageEnd' });
                                        this._streamingMessageOpen = false;
                                }
                                this.postMessage({ type: 'complete', summary: event.summary });
                                this.postMessage({ type: 'agentState', state: 'complete' });
                                break;
                        case 'error':
                                if (this._streamingMessageOpen) {
                                        this.postMessage({ type: 'agentMessageEnd' });
                                        this._streamingMessageOpen = false;
                                }
                                this.postMessage({ type: 'error', text: event.text, recoverable: event.recoverable });
                                if (!event.recoverable) {
                                        this.postMessage({ type: 'agentState', state: 'error' });
                                }
                                break;
                }
        }

        // -------------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------------

        private postMessage(msg: WebviewOutboundMessage): void {
                if (!this._view) {
                        // Webview not yet resolved — drop the message. (The webview
                        // will request 'ready' on resolve; we push initial state then.)
                        return;
                }
                this._view.webview.postMessage(msg);
        }

        private syncAgentState(): void {
                const agentLoop = getAgentLoop();
                if (!agentLoop) { return; }
                let state: 'idle' | 'planning' | 'running' | 'paused' | 'complete' | 'error' = 'idle';
                switch (agentLoop.executionState) {
                        case ExecutionState.Planning:
                        case ExecutionState.AwaitingApproval:
                                state = 'planning'; break;
                        case ExecutionState.Executing:
                        case ExecutionState.Verifying:
                                state = 'running'; break;
                        case ExecutionState.PausedAtMilestone:
                                state = 'paused'; break;
                        case ExecutionState.Complete:
                                state = 'complete'; break;
                        case ExecutionState.VerificationFailed:
                        case ExecutionState.Error:
                                state = 'error'; break;
                        case ExecutionState.Idle:
                        default:
                                state = 'idle'; break;
                }
                this.postMessage({ type: 'agentState', state });
        }

        private pushPendingSnapshot(): void {
                const entries = [...pendingChangesService.pendingEntries].map((e) => ({
                        filePath: e.uri.fsPath,
                        isNew: e.isNewFile,
                }));
                this.postMessage({ type: 'pendingChanges', entries });
        }

        private _hasApiKey(provider: string): boolean {
                // Synchronous best-effort check. SecretStorage.get is async, so
                // we can't block here. We optimistically report true and let
                // the provider surface a clear error if the key is missing.
                // (A follow-up v1.0-beta task: cache key presence in memory
                // after the first successful chat call.)
                void provider;
                return true;
        }

        // -------------------------------------------------------------------------
        // HTML / asset assembly
        // -------------------------------------------------------------------------

        /**
         * Build the webview HTML with the correct CSP, nonce, and resource URIs.
         * The HTML shell is `src/ui/webview/agentPanel.html`; we read it once
         * and substitute the placeholders.
         *
         * Why generate vs. serve static: VS Code webviews need nonce-protected
         * script tags and `webview.asWebviewUri(...)`-rewritten resource URIs.
         * Doing this in one place (here) keeps the .html file editable as a
         * normal HTML document.
         */
        private _buildHtml(): string {
                const webview = this._view?.webview;
                if (!webview) { return '<!DOCTYPE html><html><body>Webview not ready</body></html>'; }

                const nonce = getNonce();
                const webviewDir = vscode.Uri.joinPath(this._context.extensionUri, 'src', 'ui', 'webview');

                const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'agentPanel.css'));
                const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'agentPanel.js'));

                // CSP: default-src 'none'; img-src the webview's own origin + data
                // URIs (for inline SVGs); style-src the CSS file + inline styles;
                // script-src only the JS file with the nonce.
                const csp = [
                        `default-src 'none'`,
                        `img-src ${webview.cspSource} data:`,
                        `style-src ${webview.cspSource} 'unsafe-inline'`,
                        `script-src 'nonce-${nonce}'`,
                        `font-src ${webview.cspSource}`,
                ].join('; ');

                return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Kovix Agent</title>
  <link rel="stylesheet" href="${cssUri.toString()}" />
</head>
<body>
  <div class="kovix-root" id="kovix-root">

    <header class="panel-header" role="banner">
      <div class="title">
        <span class="brand-dot" aria-hidden="true"></span>
        <span>Kovix</span>
      </div>
      <div class="actions">
        <button type="button" class="action-button" id="action-clear" title="Clear conversation" aria-label="Clear conversation">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
        <button type="button" class="action-button" id="action-settings" title="Manage API keys" aria-label="Manage API keys">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </header>

    <div class="milestone-banner" id="milestone-banner" role="alert" aria-live="assertive" hidden>
      <span class="pause-icon" aria-hidden="true">⏸</span>
      <span class="milestone-label" id="milestone-label">Paused at milestone</span>
      <div class="banner-actions">
        <button type="button" class="resume-button" id="milestone-resume">Resume</button>
        <button type="button" class="skip-button" id="milestone-skip">Skip</button>
        <button type="button" class="abort-button" id="milestone-abort">Abort</button>
      </div>
    </div>

    <main class="message-list" id="message-list" role="log" aria-live="polite" aria-label="Kovix conversation">
      <div class="empty-state" id="empty-state">
        <div class="empty-icon" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h7M5 12l4-4M5 12l4 4" />
            <path d="M12 6 Q19 9 19 12 Q19 15 12 18" />
          </svg>
        </div>
        <div class="empty-title">Ask Kovix to build something</div>
        <div class="empty-subtitle">
          Describe a task and the agent will plan, ask for approval, then
          execute with the right tools. Files it writes are staged for
          your review.
        </div>
      </div>
    </main>

    <section class="pending-section collapsed" id="pending-section" aria-label="Pending changes" hidden>
      <div class="pending-header" id="pending-header" role="button" tabindex="0" aria-expanded="false">
        <span class="chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
        <span class="pending-label">Pending Changes</span>
        <span class="pending-count" id="pending-count">0</span>
      </div>
      <div class="pending-list" id="pending-list"></div>
    </section>

    <footer class="input-area" role="contentinfo">
      <div class="input-wrapper" id="input-wrapper">
        <textarea id="input-textarea" rows="1" placeholder="Ask Kovix to build, edit, or explain something…" aria-label="Task input" autocomplete="off" spellcheck="true"></textarea>
        <button type="button" class="send-button" id="send-button" aria-label="Send task" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        </button>
      </div>
      <div class="input-meta">
        <span><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline</span>
        <span id="agent-status">Idle</span>
      </div>
    </footer>

  </div>
  <script nonce="${nonce}" src="${jsUri.toString()}"></script>
</body>
</html>`;
        }

        // -------------------------------------------------------------------------
        // Disposable
        // -------------------------------------------------------------------------

        dispose(): void {
                this._abortController?.abort();
                for (const d of this._disposables) {
                        try { d.dispose(); } catch { /* swallow */ }
                }
                this._disposables.length = 0;
                this._view = undefined;
                _provider = undefined;
                logger.info('[AgentPanel] Provider disposed.');
        }
}

// -------------------------------------------------------------------------
// Utilities
// -------------------------------------------------------------------------

/**
 * Generate a CSP-friendly nonce. 32 base64 chars from crypto.randomBytes.
 * Used in the script-src CSP directive.
 */
function getNonce(): string {
        return randomBytes(16).toString('base64');
}
