/**
 * index.ts — Barrel exports for the swarm module.
 */

export { FileLockManager, type ILockManager, type ILockHandle, LockTimeoutError } from './fileLock';
export { Partitioner, type IPartitionResult, type ISubPlan, type IPartitionerDeps } from './partitioner';
export {
	SwarmOrchestrator,
	type SwarmEventType,
	type ISwarmOptions,
	type IWorkerResult,
	type ISwarmOrchestrator,
	getSwarmOrchestrator,
	resolveSwarmApproval,
} from './orchestrator';
export {
	CreditSystem,
	CostGovernor,
	type ICreditSystemConfig,
	getCreditSystem,
	getCostGovernor,
	initCostGovernor,
} from './costGovernor';
export {
	ErrorRecoveryService,
	type IErrorRecoveryResult,
	type ErrorClassification,
	getErrorRecoveryService,
} from './errorRecovery';
