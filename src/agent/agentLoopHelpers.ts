/**
 * agentLoopHelpers.ts — Layer 1 pure-logic: extracted agent-loop helper functions.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/agent/agentLoopHelpers.ts` (210L)
 * Port strategy: PORT WITH MINOR TRANSLATION. The functions are pure-ish
 * (they take collaborators as parameters, no VS Code imports), but they
 * reference types from pricing/creditSystem and executionSanity which are
 * Layer 1 interfaces not yet ported in this Round 1.
 *
 * 02_ARCHITECTURE.md §4.1 lists this as a Layer 1 port-verbatim file.
 *
 * Translation notes:
 *   - `ILogService` (VS Code internal) replaced with a local `ILogger`
 *     interface that matches the surface area we use (`info`, `warn`).
 *     The real logger (`src/util/logger.ts`) is structurally compatible.
 *   - The pricing types (`ICostGovernor`, `ICreditSystem`, `CreditActionType`)
 *     are forward-declared as local interfaces in this file. When the
 *     pricing module is ported in a later Phase 3 round, those forward
 *     declarations will be replaced with imports from `src/pricing/`.
 *     The forward declarations preserve the exact shape so consumers
 *     don't break.
 *   - `IExecutionSanityService` and `SanitySeverity` similarly forward-declared.
 *   - No logic changes. The Phase 4 fix that includes Warning in the
 *     suspicious filter is preserved verbatim.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route).
 */

// ---------------------------------------------------------------------------
// Forward declarations — pricing module (Layer 1 interfaces, ported in a later round)
// ---------------------------------------------------------------------------
// These types match the old repo's pricing module shape exactly. They are
// declared locally so this file compiles standalone; once the pricing
// module is ported to `src/pricing/`, the local declarations will be
// removed and replaced with imports.

/**
 * Action type for credit billing. Drives the cost-per-call table.
 */
export type CreditActionType =
        | 'file_edit'
        | 'terminal_command'
        | 'browser_action'
        | 'tool_call'
        | 'llm_call';

/**
 * Per-call credit accounting interface (Layer 2 service, ported later).
 * Shape preserved verbatim from `Kovix_2.0/src/vs/platform/construct/common/pricing/creditSystem.ts`.
 */
export interface ICreditSystem {
        getCreditsRemaining(): number;
        consumeCredits(
                amount: number,
                actionType: CreditActionType,
                metadata?: { agentType?: string; sessionId?: string | undefined; description?: string },
        ): boolean;
}

/**
 * Cost governor interface (Layer 2 service, ported later).
 * Shape preserved verbatim from the old repo.
 */
export interface ICostGovernor {
        isEmergencyMode(): boolean;
        shouldAutoSwitchModel(): boolean;
        getCheaperModel(currentModel: string): string | undefined;
}

// ---------------------------------------------------------------------------
// Forward declarations — execution sanity module (Layer 1 interface, ported later)
// ---------------------------------------------------------------------------

export enum SanitySeverity {
        Warning = 'warning',
        Critical = 'critical',
        Fail = 'fail',
}

export interface ISanityCheckResult {
        readonly severity: SanitySeverity;
        readonly checkName: string;
        readonly message: string;
        readonly suggestedAction?: string;
}

/**
 * Hallucinated-success detector (Layer 2 service, ported later).
 * Shape preserved verbatim from `Kovix_2.0/src/vs/platform/construct/common/executionSanity.ts`.
 */
export interface IExecutionSanityService {
        validateCommandResult(
                command: string,
                exitCode: number,
                stdout: string,
                stderr: string,
        ): ISanityCheckResult[];
}

// ---------------------------------------------------------------------------
// Local logger interface (matches src/util/logger.ts surface)
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface that matches the surface area of `src/util/logger.ts`.
 * Declared locally to avoid a Layer 1 → Layer 2 (util) dependency cycle.
 */
export interface ILogger {
        info(message: string): void;
        warn(message: string): void;
}

// ---------------------------------------------------------------------------
// mapToolToActionType
// ---------------------------------------------------------------------------

/**
 * Map an agent tool name to the corresponding CreditActionType for billing.
 *
 * Reads (search_code, read_file) map to a generic 'tool_call' that
 * costs 1 credit — this is intentional: even reads cost something because
 * they consume LLM context window and compute. Writes and commands also
 * cost 1 credit. Premium models can apply a multiplier upstream in
 * CreditSystemService.consumeCredits.
 *
 * Pure function — no side effects, deterministic.
 */
export function mapToolToActionType(toolName: string): CreditActionType {
        switch (toolName) {
                case 'write_file':
                case 'edit_file':
                        return 'file_edit';
                case 'run_command':
                        return 'terminal_command';
                case 'web_search':
                        return 'browser_action';
                case 'search_code':
                        return 'tool_call';
                default:
                        // MCP tools (serverName__toolName) and any other registered tools
                        // count as generic tool calls.
                        return 'tool_call';
        }
}

// ---------------------------------------------------------------------------
// checkCostGate
// ---------------------------------------------------------------------------

/**
 * Check whether the cost governor allows another LLM round.
 *
 * Returns `{ allowed: true }` when fine, or `{ allowed: false, reason }`
 * when the agent must stop because emergency mode is active
 * (costGovernor.isEmergencyMode() returns true when credits remaining
 * drop below 10).
 *
 * Also logs a recommendation when shouldAutoSwitchModel() returns true
 * (credits < 20% of allocation). The actual model switch is handled
 * upstream by the AI service / user settings; this is informational only.
 *
 * Pure-ish: reads from costGovernor + creditSystem, may write to logService.
 */
export function checkCostGate(
        costGovernor: ICostGovernor,
        creditSystem: ICreditSystem,
        logService: ILogger,
): { allowed: boolean; reason: string } {
        if (costGovernor.isEmergencyMode()) {
                const remaining = creditSystem.getCreditsRemaining();
                return {
                        allowed: false,
                        reason: `Cost governor emergency stop: only ${remaining} credits remaining. ` +
                                `Replenish credits or upgrade your tier to resume agent execution. ` +
                                `Essential actions (file save, git commit, settings) remain available outside the agent loop.`,
                };
        }
        if (costGovernor.shouldAutoSwitchModel()) {
                // Log a recommendation; actual model switching is handled by the
                // AI service / user settings. This is informational only for v1.
                const cheaper = costGovernor.getCheaperModel('default');
                if (cheaper) {
                        logService.info(`[AgentLoop][CostGovernor] Credits low (<20% of allocation). Consider switching to ${cheaper} to conserve credits.`);
                }
        }
        return { allowed: true, reason: '' };
}

// ---------------------------------------------------------------------------
// applyCommandSanity
// ---------------------------------------------------------------------------

/**
 * Run sanity checks on a `run_command` tool result and append the findings
 * to the output so the LLM sees them. If any Critical, Fail, OR Warning
 * results come back, the tool result is marked as suspicious (the LLM
 * should re-plan based on the augmented output).
 *
 * Returns the (possibly augmented) output string plus a flag indicating
 * whether a hallucinated success was detected.
 *
 * Phase 4 behavior change (preserved from old repo): previously only
 * Critical/Fail triggered suspicious=true. Now Warning also triggers it.
 * Rationale: an exit 0 with empty output (Warning) is a strong
 * hallucination signal that the LLM should see and re-plan from. Dropping
 * Warning findings on the floor (the prior behavior) meant the LLM never
 * knew the command produced nothing.
 *
 * Phase 4 also: ALL findings (Warning+Critical+Fail) are appended to the
 * output, not just the suspicious ones. The LLM gets maximum signal.
 */
export function applyCommandSanity(
        executionSanity: IExecutionSanityService,
        logService: ILogger,
        command: string,
        exitCode: number,
        stdout: string,
        stderr: string,
): { output: string; suspicious: boolean } {
        try {
                const checks = executionSanity.validateCommandResult(command, exitCode, stdout, stderr);
                // Phase 4 fix: include Warning in the suspicious filter.
                // Prior code only flagged Critical/Fail, which meant "exit 0 +
                // empty output" (Warning) was silently dropped.
                const suspiciousChecks = checks.filter(
                        c => c.severity === SanitySeverity.Critical
                                || c.severity === SanitySeverity.Fail
                                || c.severity === SanitySeverity.Warning,
                );
                if (suspiciousChecks.length === 0) {
                        return { output: stdout + (stderr ? `\n${stderr}` : ''), suspicious: false };
                }
                const findings = suspiciousChecks
                        .map(c => `[Sanity ${c.severity}] ${c.checkName}: ${c.message}${c.suggestedAction ? ` (${c.suggestedAction})` : ''}`)
                        .join('\n');
                logService.warn(`[AgentLoop][ExecutionSanity] Suspicious command output for "${command}":\n${findings}`);
                const baseOutput = stdout + (stderr ? `\n${stderr}` : '') + (exitCode !== 0 ? `\nExit code: ${exitCode}` : '');
                return {
                        output: `${baseOutput}\n\n--- Execution Sanity Findings ---\n${findings}\n--- End Sanity Findings ---\nThe above sanity checks flagged this command's output as suspicious. Re-plan based on the actual output, not on the assumption that the command succeeded.`,
                        suspicious: true,
                };
        } catch (err) {
                // Sanity checks must never break tool execution. Log and fall through.
                logService.warn(`[AgentLoop][ExecutionSanity] validateCommandResult threw: ${err instanceof Error ? err.message : String(err)}`);
                return { output: stdout + (stderr ? `\n${stderr}` : ''), suspicious: false };
        }
}

// ---------------------------------------------------------------------------
// consumeCreditsForToolCall
// ---------------------------------------------------------------------------

/**
 * Consume credits for a successful tool call. Reads are free; writes/
 * commands consume 1 credit each. Failures do NOT consume credits (the
 * user shouldn't pay for broken tool calls).
 *
 * Fire-and-forget: credit accounting must never block the agent loop.
 * If consumeCredits returns false (insufficient credits), the next
 * round's checkCostGate() will catch it and stop the loop with a
 * recoverable error. If consumeCredits throws, we log and continue —
 * the gate will catch on next round.
 *
 * Returns true if credits were consumed, false if not (failure, or
 * consumeCredits returned false, or threw).
 */
export function consumeCreditsForToolCall(
        creditSystem: ICreditSystem,
        logService: ILogger,
        toolName: string,
        success: boolean,
        sessionId: string | undefined,
): boolean {
        if (!success) {
                // Failed tool calls do not consume credits.
                return false;
        }
        const actionType = mapToolToActionType(toolName);
        try {
                const consumed = creditSystem.consumeCredits(1, actionType, {
                        agentType: 'kovix-agent',
                        sessionId: sessionId,
                        description: `Agent tool: ${toolName}`,
                });
                if (!consumed) {
                        logService.warn(`[AgentLoop][CostGovernor] consumeCredits returned false for ${toolName} -- credits likely exhausted; next round will be blocked by checkCostGate`);
                }
                return consumed;
        } catch (err) {
                logService.warn(`[AgentLoop][CostGovernor] consumeCredits threw for ${toolName}: ${err instanceof Error ? err.message : String(err)} -- continuing, gate will catch on next round`);
                return false;
        }
}
