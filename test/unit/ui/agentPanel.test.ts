/**
 * agentPanel.test.ts — unit tests for the Kovix agent panel webview provider.
 *
 * Tests run in plain Node via the vscode shim at `node_modules/vscode/index.js`.
 * The real VS Code webview host is not available in tests, so we exercise
 * the pure-logic parts of the provider:
 *
 *   1. registerAgentPanel() returns a singleton; calling it twice returns
 *      the same instance (idempotent registration).
 *   2. The view ID exported from agentPanel.ts matches the ID declared in
 *      package.json's contributes.views.kovix[0].id.
 *   3. The webview HTML built by the provider includes the strict CSP,
 *      the correct nonce, the script tag with the nonce, and the agentPanel.js
 *      resource URI — i.e., the asset wiring is correct.
 *   4. The provider forwards AgentLoopEvents to the webview as the correct
 *      WebviewOutboundMessage shape (verified by capturing postMessage calls).
 *
 * We do NOT test:
 *   - The actual rendering of the webview (that requires a browser / VS Code
 *     extension host). The webview JS is exercised in a manual smoke test.
 *   - The agent loop's behavior (covered by agentLoop.integration.test.ts).
 *   - The pending changes service (covered by its own tests).
 */

import { expect } from 'chai';
import * as vscode from 'vscode';
import {
        AgentPanelViewProvider,
        AGENT_PANEL_VIEW_ID,
        registerAgentPanel,
        getAgentPanel,
        IAIServiceInfo,
} from '../../../src/ui/agentPanel';
import { AgentLoopEvent, IMilestone } from '../../../src/types/agent';

// --- Test helpers --------------------------------------------------------

/**
 * Minimal fake WebviewView that captures postMessage calls + supports the
 * surface area the provider uses (webview.options, .html, .onDidReceiveMessage,
 * .asWebviewUri, .cspSource, .postMessage).
 */
class FakeWebviewView {
        webview: {
                options: unknown;
                html: string;
                cspSource: string;
                onDidReceiveMessage: (listener: (msg: unknown) => void) => { dispose: () => void };
                postMessages: unknown[];
                postMessage: (msg: unknown) => Thenable<boolean>;
                asWebviewUri: (uri: vscode.Uri) => { toString: () => string };
        };
        // Listener field — kept so tests can drive inbound messages if needed.
        // Marked public to satisfy ts-node's strict noUnusedLocals in the
        // tsconfig.test.json extends-chain (test files don't relax that flag).
        msgListener: ((msg: unknown) => void) | null = null;

        constructor() {
                this.webview = {
                        options: {},
                        html: '',
                        cspSource: 'vscode-webview://test-csp-source',
                        onDidReceiveMessage: (listener: (msg: unknown) => void) => {
                                this.msgListener = listener;
                                return { dispose: () => { this.msgListener = null; } };
                        },
                        postMessages: [],
                        postMessage: (msg: unknown) => {
                                this.webview.postMessages.push(msg);
                                return Promise.resolve(true);
                        },
                        asWebviewUri: (uri: vscode.Uri) => ({
                                toString: () => `vscode-webview:///${uri.fsPath}`,
                        }),
                };
        }
        show(_preserveFocus: boolean): void { /* noop */ }
}

/**
 * Construct a provider directly (bypass registerAgentPanel singleton) so
 * tests are isolated. Returns the provider + a fake view that the test
 * can drive.
 */
function makeIsolatedProvider(): { provider: AgentPanelViewProvider; view: FakeWebviewView } {
        const fakeContext: vscode.ExtensionContext = {
                extensionUri: vscode.Uri.file('/test/extension'),
                extensionPath: '/test/extension',
                subscriptions: [],
                get extensionMode() { return vscode.ExtensionMode.Test; },
        } as unknown as vscode.ExtensionContext;
        const fakeAiService: IAIServiceInfo = { activeProviderType: 'anthropic' };
        const provider = new AgentPanelViewProvider(fakeContext, fakeAiService);
        const view = new FakeWebviewView();
        provider.resolveWebviewView(view as unknown as vscode.WebviewView, {} as vscode.WebviewViewResolveContext);
        return { provider, view };
}

// --- Tests ---------------------------------------------------------------

describe('agentPanel (Round 2D — WebviewViewProvider)', () => {

        describe('AGENT_PANEL_VIEW_ID', () => {
                it('matches the view ID declared in package.json', () => {
                        // Per package.json: contributes.views.kovix[0].id = "kovix.agentPanel"
                        expect(AGENT_PANEL_VIEW_ID).to.equal('kovix.agentPanel');
                });
        });

        describe('registerAgentPanel() (singleton)', () => {
                it('returns a provider instance', () => {
                        const ctx = { extensionUri: vscode.Uri.file('/test'), subscriptions: [] } as unknown as vscode.ExtensionContext;
                        const ai = { activeProviderType: 'anthropic' } as IAIServiceInfo;
                        const provider = registerAgentPanel(ctx, ai);
                        expect(provider).to.be.an.instanceOf(AgentPanelViewProvider);
                });

                it('returns the same instance on subsequent calls (singleton)', () => {
                        const ctx1 = { extensionUri: vscode.Uri.file('/test'), subscriptions: [] } as unknown as vscode.ExtensionContext;
                        const ctx2 = { extensionUri: vscode.Uri.file('/test'), subscriptions: [] } as unknown as vscode.ExtensionContext;
                        const ai = { activeProviderType: 'anthropic' } as IAIServiceInfo;
                        const provider1 = registerAgentPanel(ctx1, ai);
                        const provider2 = registerAgentPanel(ctx2, ai);
                        expect(provider2).to.equal(provider1);
                });

                it('getAgentPanel() returns the registered provider', () => {
                        const ctx = { extensionUri: vscode.Uri.file('/test'), subscriptions: [] } as unknown as vscode.ExtensionContext;
                        const ai = { activeProviderType: 'anthropic' } as IAIServiceInfo;
                        const provider = registerAgentPanel(ctx, ai);
                        expect(getAgentPanel()).to.equal(provider);
                });
        });

        describe('resolveWebviewView() (HTML assembly)', () => {
                it('builds HTML with a strict CSP (default-src none)', () => {
                        const { view } = makeIsolatedProvider();
                        expect(view.webview.html).to.contain("default-src 'none'");
                });

                it('builds HTML with a nonce-protected script tag', () => {
                        const { view } = makeIsolatedProvider();
                        const nonceMatch = view.webview.html.match(/script-src 'nonce-([A-Za-z0-9+/=]+)'/);
                        expect(nonceMatch, 'CSP must include a script-src nonce').to.not.be.null;
                        const nonce = nonceMatch![1];
                        expect(view.webview.html).to.contain(`<script nonce="${nonce}"`);
                });

                it('loads agentPanel.css via the webview URI', () => {
                        const { view } = makeIsolatedProvider();
                        expect(view.webview.html).to.contain('agentPanel.css');
                        expect(view.webview.html).to.contain('rel="stylesheet"');
                });

                it('loads agentPanel.js via the webview URI', () => {
                        const { view } = makeIsolatedProvider();
                        expect(view.webview.html).to.contain('agentPanel.js');
                        expect(view.webview.html).to.match(/<script[^>]*src="[^"]*agentPanel\.js"/);
                });

                it('includes the empty-state heading', () => {
                        const { view } = makeIsolatedProvider();
                        expect(view.webview.html).to.contain('Ask Kovix to build something');
                });

                it('includes the milestone pause banner (hidden by default)', () => {
                        const { view } = makeIsolatedProvider();
                        expect(view.webview.html).to.contain('milestone-banner');
                        expect(view.webview.html).to.contain(' hidden');
                });

                it('includes the pending changes section (hidden by default)', () => {
                        const { view } = makeIsolatedProvider();
                        expect(view.webview.html).to.contain('pending-section');
                });

                it('includes the input textarea + send button', () => {
                        const { view } = makeIsolatedProvider();
                        expect(view.webview.html).to.contain('input-textarea');
                        expect(view.webview.html).to.contain('send-button');
                });
        });

        describe('AgentLoopEvent → webview message translation', () => {
                function forward(provider: AgentPanelViewProvider, event: AgentLoopEvent): void {
                        (provider as unknown as { forwardAgentLoopEvent(e: AgentLoopEvent): void }).forwardAgentLoopEvent(event);
                }

                function messages(view: FakeWebviewView): unknown[] {
                        return view.webview.postMessages;
                }

                it('forwards token events as agentMessageStart + token', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'token', text: 'Hello' });
                        expect(messages(view)).to.have.lengthOf(2);
                        expect(messages(view)[0]).to.deep.include({ type: 'agentMessageStart' });
                        expect(messages(view)[1]).to.deep.equal({ type: 'token', text: 'Hello' });
                });

                it('only emits agentMessageStart once per stream (subsequent tokens do not re-open)', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'token', text: 'a' });
                        forward(provider, { type: 'token', text: 'b' });
                        forward(provider, { type: 'token', text: 'c' });
                        const starts = messages(view).filter((m) => (m as { type: string }).type === 'agentMessageStart');
                        expect(starts).to.have.lengthOf(1);
                });

                it('forwards tool_start with a fresh timestamp map entry', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'tool_start', toolId: 't1', toolName: 'read_file' });
                        expect(messages(view)).to.have.lengthOf(1);
                        const toolStart = messages(view).find((m) => (m as { type: string }).type === 'toolStart');
                        expect(toolStart).to.deep.equal({ type: 'toolStart', toolId: 't1', toolName: 'read_file' });
                });

                it('forwards tool_result with computed durationMs', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'tool_start', toolId: 't1', toolName: 'read_file' });
                        view.webview.postMessages.length = 0;

                        forward(provider, {
                                type: 'tool_result',
                                toolId: 't1',
                                toolName: 'read_file',
                                result: 'file contents here',
                                success: true,
                        });
                        const toolEnd = messages(view).find((m) => (m as { type: string }).type === 'toolEnd') as {
                                type: string;
                                toolId: string;
                                toolName: string;
                                success: boolean;
                                result: string;
                                durationMs?: number;
                        } | undefined;
                        expect(toolEnd).to.not.be.undefined;
                        expect(toolEnd!.toolId).to.equal('t1');
                        expect(toolEnd!.toolName).to.equal('read_file');
                        expect(toolEnd!.success).to.be.true;
                        expect(toolEnd!.result).to.equal('file contents here');
                        expect(toolEnd!.durationMs).to.be.a('number');
                        expect(toolEnd!.durationMs!).to.be.at.least(0);
                });

                it('forwards milestone_paused + sets agentState to paused', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        const milestone: IMilestone = {
                                id: 'm1',
                                name: 'Read README.md',
                                description: 'Read and understand README.md',
                                index: 0,
                                isMajor: true,
                                stepIndices: [0],
                                completed: false,
                        };
                        forward(provider, { type: 'milestone_paused', milestone });
                        expect(messages(view)).to.have.lengthOf(2);
                        expect(messages(view)[0]).to.deep.equal({
                                type: 'milestonePaused',
                                milestone: { id: 'm1', name: 'Read README.md', description: 'Read and understand README.md' },
                        });
                        expect(messages(view)[1]).to.deep.equal({ type: 'agentState', state: 'paused' });
                });

                it('forwards milestone_resumed + sets agentState to running', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, {
                                type: 'milestone_resumed',
                                milestone: { id: 'm1', name: 'Read README.md' } as IMilestone,
                        });
                        expect(messages(view)).to.have.lengthOf(2);
                        expect(messages(view)[0]).to.deep.equal({
                                type: 'milestoneResumed',
                                milestone: { id: 'm1', name: 'Read README.md' },
                        });
                        expect(messages(view)[1]).to.deep.equal({ type: 'agentState', state: 'running' });
                });

                it('forwards milestone_skipped + sets agentState to running', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, {
                                type: 'milestone_skipped',
                                milestone: { id: 'm1', name: 'Read README.md' } as IMilestone,
                        });
                        expect(messages(view)).to.have.lengthOf(2);
                        expect(messages(view)[0]).to.deep.equal({
                                type: 'milestoneSkipped',
                                milestone: { id: 'm1', name: 'Read README.md' },
                        });
                        expect(messages(view)[1]).to.deep.equal({ type: 'agentState', state: 'running' });
                });

                it('forwards verification_result with unverified flag', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, {
                                type: 'verification_result',
                                passed: true,
                                output: 'unverified:no-command',
                                unverified: true,
                        });
                        expect(messages(view)).to.have.lengthOf(1);
                        expect(messages(view)[0]).to.deep.equal({
                                type: 'verificationResult',
                                passed: true,
                                output: 'unverified:no-command',
                                unverified: true,
                        });
                });

                it('forwards complete + sets agentState to complete + closes open stream', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'token', text: 'partial' });
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'complete', summary: 'Done!' });
                        const types = messages(view).map((m) => (m as { type: string }).type);
                        expect(types).to.include('agentMessageEnd');
                        expect(types).to.include('complete');
                        expect(types).to.include('agentState');
                });

                it('forwards error with recoverable flag', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'error', text: 'Boom', recoverable: true });
                        expect(messages(view)).to.have.lengthOf(1);
                        expect(messages(view)[0]).to.deep.equal({ type: 'error', text: 'Boom', recoverable: true });
                });

                it('forwards error with recoverable=false AND emits agentState=error', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'error', text: 'Fatal', recoverable: false });
                        const types = messages(view).map((m) => (m as { type: string }).type);
                        expect(types).to.include('error');
                        expect(types).to.include('agentState');
                        const stateMsg = messages(view).find((m) => (m as { type: string }).type === 'agentState');
                        expect(stateMsg).to.deep.equal({ type: 'agentState', state: 'error' });
                });

                it('closes the streaming message when a tool_start interrupts', () => {
                        const { provider, view } = makeIsolatedProvider();
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'token', text: 'Let me read' });
                        view.webview.postMessages.length = 0;

                        forward(provider, { type: 'tool_start', toolId: 't1', toolName: 'read_file' });
                        const types = messages(view).map((m) => (m as { type: string }).type);
                        expect(types).to.include('agentMessageEnd');
                        expect(types).to.include('toolStart');
                });
        });

        describe('focus() (R-008 fix)', () => {
                it('falls back to the built-in focus command when the view is not yet resolved', async () => {
                        const ctx = { extensionUri: vscode.Uri.file('/test'), subscriptions: [] } as unknown as vscode.ExtensionContext;
                        const ai = { activeProviderType: 'anthropic' } as IAIServiceInfo;
                        const provider = new AgentPanelViewProvider(ctx, ai);
                        let executedCommand: string | undefined;
                        const origExecute = vscode.commands.executeCommand;
                        (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (cmd: string) => {
                                executedCommand = cmd;
                                return undefined;
                        };
                        try {
                                await provider.focus();
                                expect(executedCommand).to.equal(`${AGENT_PANEL_VIEW_ID}.focus`);
                        } finally {
                                (vscode.commands as unknown as { executeCommand: unknown }).executeCommand = origExecute;
                        }
                });

                it('calls view.show(true) when the view is already resolved', async () => {
                        const { provider, view } = makeIsolatedProvider();
                        let showCalled = false;
                        view.show = () => { showCalled = true; };
                        await provider.focus();
                        expect(showCalled).to.be.true;
                });
        });

        describe('dispose()', () => {
                it('clears the singleton accessor', () => {
                        const ctx = { extensionUri: vscode.Uri.file('/test'), subscriptions: [] } as unknown as vscode.ExtensionContext;
                        const ai = { activeProviderType: 'anthropic' } as IAIServiceInfo;
                        const provider = registerAgentPanel(ctx, ai);
                        expect(getAgentPanel()).to.equal(provider);
                        provider.dispose();
                        expect(getAgentPanel()).to.be.undefined;
                });
        });
});
