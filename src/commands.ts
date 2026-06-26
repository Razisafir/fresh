/**
 * commands.ts — Layer 4 command handlers for the Kovix extension.
 *
 * Phase 3 Round 2D: registers the seven v0.1 commands from package.json:
 *   - kovix.openAgentPanel   — focuses the agent chat webview (R-008 fix)
 *   - kovix.manageApiKeys    — opens the API key quick-input flow
 *   - kovix.setActiveMode    — quick-pick for autonomy mode
 *   - kovix.runTask          — prompts for a task, runs planning phase,
 *                              displays the plan for approval (Execute
 *                              gate fires when user approves). Output
 *                              streams to the agent panel webview if
 *                              open, else to an output channel.
 *   - kovix.viewPendingChanges — lists pending changes for review
 *   - kovix.resumeMilestone  — resumes from the current paused milestone
 *   - kovix.skipMilestone    — skips the current paused milestone
 *
 * 02_ARCHITECTURE.md §4.8 lists this file as Layer 4 (entry). All
 * commands are thin wrappers around the agent loop singleton obtained
 * via getAgentLoop(). The agent panel webview (src/ui/agentPanel.ts) is
 * the primary surface; these commands exist as command-palette entry
 * points and for headless testing / power users.
 *
 * Decisions referenced: D-011 (extension route), D-012 (2-webview scope),
 * D-013 (Material aesthetic), P0-5 fix (no direct disk writes —
 * write_file/edit_file stage via pendingChangesService), R-008 fix
 * (openAgentPanel uses WebviewViewProvider.focus, not openView).
 */

import * as vscode from 'vscode';
import { logger } from './util/logger';
import { getAgentLoop } from './agent/agentLoop';
import { getAIService } from './extension';
import { pendingChangesService } from './diff/pendingChangesService';
import { getAgentPanel } from './ui/agentPanel';
import { ExecutionState } from './types/agent';

/**
 * Register all v0.1 commands. Called once by extension.ts activate().
 *
 * @param context Extension context (for subscription disposal).
 */
export function registerCommands(context: vscode.ExtensionContext): void {
        // ----------------------------------------------------------------------
        // kovix.openAgentPanel
        // ----------------------------------------------------------------------
        // Round 2D: focuses the agent panel webview via the WebviewViewProvider.
        // This fixes R-008 — the old repo's `openView` call didn't reliably
        // expand the auxiliary bar on first launch. Using the provider's
        // `focus()` method (which delegates to `view.show(true)` or falls
        // back to `${viewId}.focus` if the view hasn't resolved yet) is the
        // VS Code-recommended pattern for activity-bar-anchored views.
        context.subscriptions.push(
                vscode.commands.registerCommand('kovix.openAgentPanel', async () => {
                        const panel = getAgentPanel();
                        if (!panel) {
                                vscode.window.showErrorMessage('Kovix agent panel is not initialised. Reload the window.');
                                return;
                        }
                        await panel.focus();
                }),
        );

        // ----------------------------------------------------------------------
        // kovix.manageApiKeys
        // ----------------------------------------------------------------------
        // v0.1 flow: prompt for the active provider's API key, store in
        // SecretStorage. The AI service reads from SecretStorage on next
        // provider switch / activation. This is the SEC-7 enforcement: keys
        // never touch settings.json.
        context.subscriptions.push(
                vscode.commands.registerCommand('kovix.manageApiKeys', async () => {
                        const aiService = getAIService();
                        if (!aiService) {
                                vscode.window.showErrorMessage('Kovix AI service is not initialised. Reload the window.');
                                return;
                        }
                        const provider = aiService.activeProviderType ?? 'anthropic';
                        const existing = await context.secrets.get(`kovix.apiKey.${provider}`);
                        const input = await vscode.window.showInputBox({
                                prompt: `API key for ${provider}`,
                                password: true,
                                placeHolder: existing ? '•••••••• (stored, enter a new key to replace)' : 'Enter your API key',
                                ignoreFocusOut: true,
                        });
                        if (input === undefined) {
                                return; // user cancelled
                        }
                        if (input.length === 0) {
                                vscode.window.showWarningMessage('Kovix: no API key entered. The agent will not be able to call the LLM.');
                                return;
                        }
                        await context.secrets.store(`kovix.apiKey.${provider}`, input);
                        vscode.window.showInformationMessage(`Kovix: API key stored for ${provider}.`);
                }),
        );

        // ----------------------------------------------------------------------
        // kovix.setActiveMode
        // ----------------------------------------------------------------------
        // Quick-pick for the autonomy mode (every_milestone / major_milestone
        // / selective / full_auto). Writes to kovix.autonomy.defaultMode.
        context.subscriptions.push(
                vscode.commands.registerCommand('kovix.setActiveMode', async () => {
                        const config = vscode.workspace.getConfiguration('kovix');
                        const current = config.get<string>('autonomy.defaultMode', 'major_milestone');
                        const items: Array<{ label: string; description: string; value: string }> = [
                                { label: 'Every Milestone', description: 'Pause at every milestone (most control)', value: 'every_milestone' },
                                { label: 'Major Milestone', description: 'Pause only at major changes (recommended)', value: 'major_milestone' },
                                { label: 'Selective', description: 'Pause only at user-selected milestones', value: 'selective' },
                                { label: 'Full Auto', description: 'No pauses — run the whole plan end-to-end', value: 'full_auto' },
                        ];
                        const picked = await vscode.window.showQuickPick(items, {
                                placeHolder: `Current: ${current} — pick an autonomy mode`,
                        });
                        if (!picked) {
                                return;
                        }
                        await config.update('autonomy.defaultMode', picked.value, vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage(`Kovix: autonomy mode set to ${picked.label}.`);
                }),
        );

        // ----------------------------------------------------------------------
        // kovix.runTask
        // ----------------------------------------------------------------------
        // The primary entry point. Prompts for a task, runs the planning
        // phase, displays the plan in a quick-pick for approval, then runs
        // execution with the user's chosen autonomy mode. Streams events to
        // an output channel (v0.1 — the webview will replace this).
        context.subscriptions.push(
                vscode.commands.registerCommand('kovix.runTask', async () => {
                        const agentLoop = getAgentLoop();
                        if (!agentLoop) {
                                vscode.window.showErrorMessage('Kovix agent loop is not initialised. Reload the window.');
                                return;
                        }
                        if (agentLoop.isRunning) {
                                vscode.window.showWarningMessage('Kovix agent is already running. Wait for it to finish or stop it first.');
                                return;
                        }

                        const task = await vscode.window.showInputBox({
                                prompt: 'Describe the task for the Kovix agent',
                                placeHolder: 'e.g., Add a unit test for src/utils/format.ts',
                                ignoreFocusOut: true,
                        });
                        if (!task) {
                                return;
                        }

                        // Run planning phase.
                        await vscode.window.withProgress(
                                {
                                        location: vscode.ProgressLocation.Notification,
                                        title: 'Kovix: planning…',
                                        cancellable: true,
                                },
                                async (progress, token) => {
                                        progress.report({ message: 'Analysing workspace and generating plan' });
                                        const controller = new AbortController();
                                        const cancelDisposable = token.onCancellationRequested(() => controller.abort());
                                        try {
                                                const plan = await agentLoop.runPlanningPhase(task, controller.signal);
                                                if (plan.steps.length === 0) {
                                                        vscode.window.showWarningMessage('Kovix: planning produced no steps. Try rephrasing the task.');
                                                        return;
                                                }

                                                // Display the plan for approval.
                                                const milestones = agentLoop.extractMilestonesFromPlan(plan.steps);
                                                const planSummary = plan.steps
                                                        .map((s, i) => `${i + 1}. [${s.action}] ${s.target}`)
                                                        .join('\n');
                                                const approval = await vscode.window.showInformationMessage(
                                                        `Kovix generated a plan with ${plan.steps.length} steps and ${milestones.length} milestones.`,
                                                        { modal: true, detail: planSummary },
                                                        'Approve & Run',
                                                        'Cancel',
                                                );

                                                if (approval !== 'Approve & Run') {
                                                        vscode.window.showInformationMessage('Kovix: plan cancelled by user.');
                                                        return;
                                                }

                                                // Build the approved plan and start execution.
                                                const config = vscode.workspace.getConfiguration('kovix');
                                                const executionMode = config.get<string>('autonomy.defaultMode', 'major_milestone');
                                                const approvedPlan = {
                                                        task,
                                                        steps: plan.steps.map(s => ({ ...s, selected: true })),
                                                        executionMode,
                                                        milestones,
                                                        approved: true,
                                                        approvedAt: Date.now(),
                                                };

                                                // Stream execution events to an output channel (v0.1 — webview comes later).
                                                const channel = vscode.window.createOutputChannel('Kovix Agent');
                                                channel.show(true);
                                                channel.appendLine(`=== Kovix task: ${task} ===`);
                                                channel.appendLine(`Mode: ${executionMode}, milestones: ${milestones.length}`);
                                                channel.appendLine('');

                                                const execController = new AbortController();
                                                const disposable = token.onCancellationRequested(() => execController.abort());

                                                try {
                                                        for await (const event of agentLoop.runWithApprovedPlan(approvedPlan, execController.signal)) {
                                                                switch (event.type) {
                                                                        case 'token':
                                                                                channel.append(event.text);
                                                                                break;
                                                                        case 'tool_start':
                                                                                channel.appendLine(`\n[tool_start] ${event.toolName}`);
                                                                                break;
                                                                        case 'tool_executing':
                                                                                channel.appendLine(`  ${event.detail ?? ''}`);
                                                                                break;
                                                                        case 'tool_result':
                                                                                channel.appendLine(`[tool_result] ${event.toolName}: ${event.success ? 'OK' : 'FAILED'}`);
                                                                                channel.appendLine(event.result.split('\n').map(l => `  ${l}`).join('\n'));
                                                                                break;
                                                                        case 'file_written':
                                                                                channel.appendLine(`[file_written] ${event.filePath} (staged — review in Pending Changes)`);
                                                                                break;
                                                                        case 'milestone_reached':
                                                                                channel.appendLine(`\n--- Milestone: ${event.milestone.name} ---`);
                                                                                break;
                                                                        case 'milestone_paused':
                                                                                channel.appendLine(`[milestone_paused] ${event.milestone.name}`);
                                                                                {
                                                                                        const resumeAction = await vscode.window.showInformationMessage(
                                                                                                `Kovix paused at milestone: ${event.milestone.name}`,
                                                                                                { modal: true, detail: event.milestone.description },
                                                                                                'Resume',
                                                                                                'Skip',
                                                                                                'Abort',
                                                                                        );
                                                                                        if (resumeAction === 'Resume') {
                                                                                                agentLoop.resumeFromMilestone();
                                                                                        } else if (resumeAction === 'Skip') {
                                                                                                agentLoop.skipCurrentMilestone();
                                                                                        } else {
                                                                                                execController.abort();
                                                                                        }
                                                                                }
                                                                                break;
                                                                        case 'milestone_skipped':
                                                                                channel.appendLine(`[milestone_skipped] ${event.milestone.name}`);
                                                                                break;
                                                                        case 'verification_start':
                                                                                channel.appendLine(`[verification] running: ${event.command}`);
                                                                                break;
                                                                        case 'verification_result':
                                                                                channel.appendLine(`[verification] ${event.passed ? 'PASS' : 'FAIL'}${event.unverified ? ' (unverified)' : ''}`);
                                                                                break;
                                                                        case 'complete':
                                                                                channel.appendLine(`\n=== Complete ===\n${event.summary}`);
                                                                                vscode.window.showInformationMessage('Kovix: task complete. Review staged changes in Pending Changes.');
                                                                                break;
                                                                        case 'error':
                                                                                channel.appendLine(`[ERROR] ${event.text}`);
                                                                                vscode.window.showErrorMessage(`Kovix: ${event.text}`);
                                                                                break;
                                                                }
                                                        }
                                                } finally {
                                                        disposable.dispose();
                                                        channel.appendLine('\n=== Stream ended ===');
                                                }
                                        } catch (error) {
                                                const msg = error instanceof Error ? error.message : String(error);
                                                logger.error(`[kovix.runTask] ${msg}`);
                                                vscode.window.showErrorMessage(`Kovix planning failed: ${msg}`);
                                        } finally {
                                                cancelDisposable.dispose();
                                        }
                                },
                        );
                }),
        );

        // ----------------------------------------------------------------------
        // kovix.viewPendingChanges
        // ----------------------------------------------------------------------
        // Lists pending changes and lets the user accept/reject each one.
        // This is the Approve gate UI for v0.1 (the webview will replace it).
        context.subscriptions.push(
                vscode.commands.registerCommand('kovix.viewPendingChanges', async () => {
                        const pending = pendingChangesService.pendingEntries;
                        if (pending.length === 0) {
                                vscode.window.showInformationMessage('Kovix: no pending changes.');
                                return;
                        }
                        const items = pending.map(p => ({
                                label: p.uri.fsPath,
                                description: p.isNewFile ? 'new file' : 'edit',
                                detail: p.proposedContent.length > 80 ? p.proposedContent.substring(0, 80) + '…' : p.proposedContent,
                                uri: p.uri,
                        }));
                        const picked = await vscode.window.showQuickPick(items, {
                                placeHolder: `${pending.length} pending change(s) — pick one to review`,
                        });
                        if (!picked) {
                                return;
                        }
                        const action = await vscode.window.showQuickPick(
                                ['Accept (write to disk)', 'Reject (discard)', 'View diff'],
                                { placeHolder: `Review: ${picked.label}` },
                        );
                        if (action === 'Accept (write to disk)') {
                                await pendingChangesService.accept(picked.uri);
                                vscode.window.showInformationMessage(`Kovix: accepted ${picked.label}.`);
                        } else if (action === 'Reject (discard)') {
                                await pendingChangesService.reject(picked.uri);
                                vscode.window.showInformationMessage(`Kovix: rejected ${picked.label}.`);
                        } else if (action === 'View diff') {
                                // Open the staged content in a new editor for review.
                                const entry = pending.find(p => p.uri.toString() === picked.uri.toString());
                                if (entry) {
                                        const doc = await vscode.workspace.openTextDocument({
                                                content: entry.proposedContent,
                                                language: 'plaintext',
                                        });
                                        await vscode.window.showTextDocument(doc, { preview: true });
                                }
                        }
                }),
        );

        // ----------------------------------------------------------------------
        // kovix.resumeMilestone / kovix.skipMilestone
        // ----------------------------------------------------------------------
        // Convenience commands exposed for keybinding. The runTask flow already
        // prompts the user when a milestone pauses, but these commands let
        // power-users resume/skip via keyboard shortcut without dismissing the
        // modal.
        context.subscriptions.push(
                vscode.commands.registerCommand('kovix.resumeMilestone', () => {
                        const agentLoop = getAgentLoop();
                        if (!agentLoop) {
                                return;
                        }
                        if (agentLoop.executionState !== ExecutionState.PausedAtMilestone) {
                                vscode.window.showWarningMessage('Kovix: not currently paused at a milestone.');
                                return;
                        }
                        agentLoop.resumeFromMilestone();
                }),
        );
        context.subscriptions.push(
                vscode.commands.registerCommand('kovix.skipMilestone', () => {
                        const agentLoop = getAgentLoop();
                        if (!agentLoop) {
                                return;
                        }
                        if (agentLoop.executionState !== ExecutionState.PausedAtMilestone) {
                                vscode.window.showWarningMessage('Kovix: not currently paused at a milestone.');
                                return;
                        }
                        agentLoop.skipCurrentMilestone();
                }),
        );

        logger.info('[Commands] Registered 7 commands (openAgentPanel, manageApiKeys, setActiveMode, runTask, viewPendingChanges, resumeMilestone, skipMilestone).');
}
