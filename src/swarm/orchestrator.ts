/**
 * orchestrator.ts — Swarm orchestrator for Kovix.
 *
 * Implements the architecture from 08_SWARM_DESIGN.md §4:
 *   Lead Agent → Partitioner → User Approval → N Workers → Aggregator → Complete
 *
 * Design decisions (from 08_SWARM_DESIGN.md):
 *   - 3.1: Option C — Hybrid partitioning (lead proposes, user approves)
 *   - 3.2: Option A — File-level locking
 *   - 3.3: Option A — Extend existing agent panel (no 3rd webview)
 *   - 3.4: Option C — Tiered approval (approve partition once, workers run autonomously)
 */

import type { IApprovedPlan, AgentLoopEvent } from '../types/agent';
import type { IAgentLoopDeps } from '../agent/agentLoop';
import { Partitioner, type IPartitionResult, type ISubPlan } from './partitioner';
import { FileLockManager, type ILockManager, type ILockHandle } from './fileLock';
import { logger } from '../util/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwarmEventType =
        | { type: 'swarm_partition_ready'; partition: IPartitionResult }
        | { type: 'swarm_worker_started'; agentId: string; agentName: string }
        | { type: 'swarm_worker_progress'; agentId: string; event: AgentLoopEvent }
        | { type: 'swarm_worker_completed'; agentId: string; success: boolean; summary: string }
        | { type: 'swarm_worker_failed'; agentId: string; error: string }
        | { type: 'swarm_completed'; summary: string; workerResults: ReadonlyArray<{ agentId: string; agentName: string; success: boolean; summary: string }> }
        | { type: 'swarm_error'; error: string };

export interface ISwarmOptions {
        /** Maximum number of parallel workers. Default: 4. */
        maxWorkers?: number;
        /** Whether to require user approval of the partition. Default: true. */
        requirePartitionApproval?: boolean;
        /** Signal to abort the entire swarm. */
        signal?: AbortSignal;
}

export interface IWorkerResult {
        agentId: string;
        agentName: string;
        success: boolean;
        summary: string;
        stepsCompleted: number;
        filesModified: string[];
}

export interface ISwarmOrchestrator {
        execute(
                plan: IApprovedPlan,
                agentDeps: IAgentLoopDeps,
                options?: ISwarmOptions,
        ): AsyncGenerator<SwarmEventType>;
        resolveApproval(approved: boolean): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SwarmOrchestrator implements ISwarmOrchestrator {
        private readonly _partitioner: Partitioner;
        private readonly _lockManager: ILockManager;
        private _approvalResolver: ((approved: boolean) => void) | null = null;

        constructor(
                partitionerDeps: { aiService: IAgentLoopDeps['aiService'] },
                lockManager?: ILockManager,
        ) {
                this._partitioner = new Partitioner(partitionerDeps);
                this._lockManager = lockManager ?? new FileLockManager();
        }

        async *execute(
                plan: IApprovedPlan,
                agentDeps: IAgentLoopDeps,
                options?: ISwarmOptions,
        ): AsyncGenerator<SwarmEventType> {
                const maxWorkers = options?.maxWorkers ?? 4;
                const signal = options?.signal;

                logger.info(`[SwarmOrchestrator] Starting swarm execution for plan with ${plan.steps.length} steps`);

                // Step 1: Partition the plan
                let partition: IPartitionResult;
                try {
                        partition = await this._partitioner.partition(plan, { signal });
                } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        logger.error(`[SwarmOrchestrator] Partitioning failed: ${msg}`);
                        yield { type: 'swarm_error', error: `Partitioning failed: ${msg}` };
                        return;
                }

                if (!partition.shouldSwarm) {
                        logger.info(`[SwarmOrchestrator] Partitioner recommends single-agent: ${partition.reasoning}`);
                        yield { type: 'swarm_error', error: `Single-agent recommended: ${partition.reasoning}` };
                        return;
                }

                // Cap at maxWorkers
                if (partition.subPlans.length > maxWorkers) {
                        while (partition.subPlans.length > maxWorkers) {
                                const excess = partition.subPlans.pop()!;
                                partition.subPlans[partition.subPlans.length - 1].steps.push(...excess.steps);
                                partition.subPlans[partition.subPlans.length - 1].filesTouched.push(...excess.filesTouched);
                        }
                }

                // Step 2: Emit partition for user approval
                yield { type: 'swarm_partition_ready', partition };

                if (options?.requirePartitionApproval !== false) {
                        const approved = await this._waitForApproval(signal);
                        if (!approved) {
                                yield { type: 'swarm_error', error: 'Swarm partition rejected by user.' };
                                return;
                        }
                }

                // Step 3: Spawn workers in parallel
                const workerResults = await this._spawnWorkers(partition.subPlans, plan, agentDeps, signal);

                // Step 4: Aggregate results
                const summary = this._buildSummary(workerResults);
                yield { type: 'swarm_completed', summary, workerResults };

                logger.info(`[SwarmOrchestrator] Swarm completed: ${workerResults.filter(r => r.success).length}/${workerResults.length} workers succeeded`);
        }

        resolveApproval(approved: boolean): void {
                if (this._approvalResolver) {
                        this._approvalResolver(approved);
                        this._approvalResolver = null;
                }
        }

        private _waitForApproval(signal?: AbortSignal): Promise<boolean> {
                return new Promise((resolve) => {
                        this._approvalResolver = resolve;
                        if (signal) {
                                const onAbort = () => {
                                        signal.removeEventListener('abort', onAbort);
                                        resolve(false);
                                };
                                signal.addEventListener('abort', onAbort);
                        }
                });
        }

        private async _spawnWorkers(
                subPlans: ISubPlan[],
                originalPlan: IApprovedPlan,
                agentDeps: IAgentLoopDeps,
                signal?: AbortSignal,
        ): Promise<IWorkerResult[]> {
                const results = await Promise.allSettled(
                        subPlans.map(subPlan => this._runWorker(subPlan, originalPlan, agentDeps, signal)),
                );

                return results.map((result, i) => {
                        if (result.status === 'fulfilled') return result.value;
                        return {
                                agentId: subPlans[i].agentId,
                                agentName: subPlans[i].agentName,
                                success: false,
                                summary: `Worker failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
                                stepsCompleted: 0,
                                filesModified: [],
                        };
                });
        }

        private async _runWorker(
                subPlan: ISubPlan,
                originalPlan: IApprovedPlan,
                agentDeps: IAgentLoopDeps,
                signal?: AbortSignal,
        ): Promise<IWorkerResult> {
                logger.info(`[SwarmOrchestrator] Worker "${subPlan.agentName}" starting with ${subPlan.steps.length} steps`);

                // Acquire file locks
                const locks: ILockHandle[] = [];
                try {
                        for (const filePath of subPlan.filesTouched) {
                                const lock = await this._lockManager.acquire(filePath, subPlan.agentId, 60_000);
                                locks.push(lock);
                        }
                } catch (err) {
                        locks.forEach(l => l.release());
                        const msg = err instanceof Error ? err.message : String(err);
                        return {
                                agentId: subPlan.agentId,
                                agentName: subPlan.agentName,
                                success: false,
                                summary: `Failed to acquire file locks: ${msg}`,
                                stepsCompleted: 0,
                                filesModified: [],
                        };
                }

                // Build a worker-specific IApprovedPlan from the sub-plan steps
                const workerPlan: IApprovedPlan = {
                        task: originalPlan.task,
                        steps: subPlan.steps.map((s, i) => ({ ...s, index: i, selected: true })),
                        executionMode: 'full_auto',
                        milestones: [],
                        approved: true,
                        approvedAt: Date.now(),
                };

                try {
                        const { AgentLoopService } = await import('../agent/agentLoop');
                        const worker = new AgentLoopService(agentDeps);

                        let stepsCompleted = 0;
                        const filesModified: string[] = [];
                        const textParts: string[] = [];

                        const workerSignal = signal ?? new AbortController().signal;
                        const stream = worker.runWithApprovedPlan(workerPlan, workerSignal);
                        for await (const event of stream) {
                                if (event.type === 'token') {
                                        textParts.push(event.text);
                                } else if (event.type === 'tool_result') {
                                        if (event.toolName === 'write_file' || event.toolName === 'edit_file') {
                                                filesModified.push(event.result.slice(0, 200));
                                                stepsCompleted++;
                                        }
                                } else if (event.type === 'file_written') {
                                        filesModified.push(event.filePath);
                                }
                        }

                        const fullText = textParts.join('');
                        const summary = fullText.length > 500
                                ? `...${fullText.slice(-500)}`
                                : fullText || `Worker "${subPlan.agentName}" completed.`;

                        return {
                                agentId: subPlan.agentId,
                                agentName: subPlan.agentName,
                                success: true,
                                summary,
                                stepsCompleted,
                                filesModified: filesModified.filter(Boolean),
                        };
                } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        return {
                                agentId: subPlan.agentId,
                                agentName: subPlan.agentName,
                                success: false,
                                summary: `Worker failed: ${msg}`,
                                stepsCompleted: 0,
                                filesModified: [],
                        };
                } finally {
                        locks.forEach(l => l.release());
                }
        }

        private _buildSummary(results: IWorkerResult[]): string {
                const succeeded = results.filter(r => r.success).length;
                const failed = results.filter(r => !r.success).length;
                const totalFiles = new Set(results.flatMap(r => r.filesModified)).size;

                let summary = `Swarm completed: ${succeeded} workers succeeded`;
                if (failed > 0) summary += `, ${failed} failed`;
                summary += `. ${totalFiles} files modified across ${results.length} workers.`;

                for (const result of results) {
                        summary += `\n\n**${result.agentName}**: ${result.success ? 'OK' : 'FAIL'} ${result.summary}`;
                }

                return summary;
        }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _orchestrator: SwarmOrchestrator | undefined;

export function getSwarmOrchestrator(aiService: IAgentLoopDeps['aiService']): SwarmOrchestrator {
        if (!_orchestrator) {
                _orchestrator = new SwarmOrchestrator({ aiService });
        }
        return _orchestrator;
}

export function resolveSwarmApproval(approved: boolean): void {
        if (_orchestrator) {
                _orchestrator.resolveApproval(approved);
        }
}
