/**
 * skillRegistryService.ts — Layer 2 concrete implementation of ISkillRegistry.
 *
 * Follows the same singleton pattern as ToolRegistryService:
 *   - Constructed once during app initialization
 *   - Re-exported via `getSkillRegistry()` accessor
 *   - Built-in skills are registered at construction time
 *
 * The registry stores skills in a Map<string, ISkill> keyed by manifest ID.
 * It supports:
 *   - Discovering user skills from manifest.json files in ~/.kovix/skills/
 *   - Building system prompts from active skills' systemPromptFragment values
 *   - Routing tool lookups back to the owning skill
 *   - Tracking skill state transitions and notifying listeners
 *   - Per-skill configuration storage
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../util/logger';
import type { IConstructToolRegistry, IToolResult } from '../types/tools';
import type {
        ISkill,
        ISkillManifest,
        ISkillRegistry,
        ISkillContext,
        SkillState,
        SkillSource,
} from '../types/skills';
import { registerBuiltinSkills } from './builtin';

// ---------------------------------------------------------------------------
// ConcreteSkill — runtime skill instance
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of the ISkill interface.
 *
 * Wraps a manifest with runtime state (lifecycle, usage tracking, error
 * handling). Delegates tool execution to the tool registry passed via
 * the activation context.
 */
class ConcreteSkill implements ISkill {
        manifest: ISkillManifest;
        state: SkillState;
        source: SkillSource;

        private _error: Error | undefined;
        private _activatedAt: Date | undefined;
        private _usageCount = 0;
        private _toolRegistry: IConstructToolRegistry | undefined;

        constructor(manifest: ISkillManifest, source: SkillSource) {
                this.manifest = manifest;
                this.source = source;
                this.state = 'loaded';
        }

        get isActive(): boolean {
                return this.state === 'active';
        }

        get error(): Error | undefined {
                return this._error;
        }

        get activatedAt(): Date | undefined {
                return this._activatedAt;
        }

        get usageCount(): number {
                return this._usageCount;
        }

        async activate(context: ISkillContext): Promise<void> {
                if (this.state === 'active') {
                        logger.verbose(`[SkillRegistry] Skill ${this.manifest.id} is already active — skipping.`);
                        return;
                }

                // Validate required tools are available.
                const requiredTools = this.manifest.requiredTools ?? [];
                for (const toolName of requiredTools) {
                        if (!context.toolRegistry.getTool(toolName)) {
                                const err = new Error(
                                        `Required tool "${toolName}" is not registered. ` +
                                        `Cannot activate skill "${this.manifest.id}".`,
                                );
                                this._error = err;
                                this.state = 'error';
                                logger.warn(`[SkillRegistry] ${err.message}`);
                                throw err;
                        }
                }

                this._toolRegistry = context.toolRegistry;
                this._activatedAt = new Date();
                this._error = undefined;
                this.state = 'active';
                logger.info(`[SkillRegistry] Skill "${this.manifest.id}" activated.`);
        }

        async deactivate(): Promise<void> {
                if (this.state !== 'active') {
                        logger.verbose(`[SkillRegistry] Skill ${this.manifest.id} is not active — skipping deactivate.`);
                        return;
                }

                this._toolRegistry = undefined;
                this.state = 'disabled';
                logger.info(`[SkillRegistry] Skill "${this.manifest.id}" deactivated.`);
        }

        async executeTool(
                toolName: string,
                input: Record<string, unknown>,
                signal?: AbortSignal,
        ): Promise<unknown> {
                if (!this._toolRegistry) {
                        throw new Error(
                                `Skill "${this.manifest.id}" has no tool registry — ` +
                                `is it activated?`,
                        );
                }

                // Verify this tool belongs to this skill.
                if (!this.manifest.tools.includes(toolName)) {
                        throw new Error(
                                `Tool "${toolName}" is not provided by skill "${this.manifest.id}". ` +
                                `Available tools: ${this.manifest.tools.join(', ')}`,
                        );
                }

                this._usageCount++;
                const result: IToolResult = await this._toolRegistry.execute(toolName, input, signal);
                return result;
        }
}

// ---------------------------------------------------------------------------
// SkillRegistryService — singleton registry
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of ISkillRegistry.
 *
 * Singleton — constructed once during app initialization and re-exported
 * via `getSkillRegistry()` accessor. Built-in skills are registered at
 * construction time; user skills are discovered on demand via
 * `discoverSkills()`.
 */
export class SkillRegistryService implements ISkillRegistry {

        private readonly _skills: Map<string, ConcreteSkill> = new Map();
        private readonly _configs: Map<string, Record<string, unknown>> = new Map();
        private readonly _stateChangeHandlers: Array<(skillId: string, state: SkillState) => void> = [];

        constructor() {
                registerBuiltinSkills(this);
                logger.info(`[SkillRegistry] Initialized with ${this._skills.size} built-in skills`);
        }

        // --- Discovery ---

        async discoverSkills(): Promise<void> {
                const userSkillsDir = path.join(os.homedir(), '.kovix', 'skills');
                let entries: fsSync.Dirent[];

                try {
                        entries = await fs.readdir(userSkillsDir, { withFileTypes: true });
                } catch {
                        logger.info(`[SkillRegistry] No user skills directory at ${userSkillsDir} — skipping discovery.`);
                        return;
                }

                for (const entry of entries) {
                        if (!entry.isDirectory()) continue;

                        const manifestPath = path.join(userSkillsDir, entry.name, 'manifest.json');
                        try {
                                const raw = await fs.readFile(manifestPath, 'utf8');
                                const manifest = JSON.parse(raw) as ISkillManifest;

                                if (!manifest.id || !manifest.name || !manifest.version) {
                                        logger.warn(`[SkillRegistry] Invalid manifest at ${manifestPath}: missing id, name, or version. Skipping.`);
                                        continue;
                                }

                                // Don't overwrite built-in skills with user skills of the same ID.
                                if (this._skills.has(manifest.id)) {
                                        logger.warn(`[SkillRegistry] Skill "${manifest.id}" already registered — skipping user skill at ${manifestPath}.`);
                                        continue;
                                }

                                await this.registerSkill(manifest, 'user');
                                logger.info(`[SkillRegistry] Discovered user skill: ${manifest.id}@${manifest.version}`);
                        } catch (err) {
                                logger.warn(`[SkillRegistry] Failed to load manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
                        }
                }
        }

        // --- Registration ---

        async registerSkill(manifest: ISkillManifest, source: SkillSource): Promise<void> {
                if (this._skills.has(manifest.id)) {
                        logger.warn(`[SkillRegistry] Skill already registered: ${manifest.id}. Overwriting.`);
                }

                const skill = new ConcreteSkill(manifest, source);
                skill.state = 'loaded';
                this._skills.set(manifest.id, skill);

                // Initialise config with defaults from the manifest's configurable fields.
                const defaultConfig: Record<string, unknown> = {};
                if (manifest.configurable) {
                        for (const field of manifest.configurable) {
                                if (field.default !== undefined) {
                                        defaultConfig[field.key] = field.default;
                                }
                        }
                }
                this._configs.set(manifest.id, defaultConfig);

                this._notifyStateChange(manifest.id, 'loaded');
                logger.verbose(`[SkillRegistry] Registered skill: ${manifest.id} (source: ${source})`);
        }

        async unregisterSkill(skillId: string): Promise<void> {
                const skill = this._skills.get(skillId);
                if (!skill) {
                        logger.verbose(`[SkillRegistry] Cannot unregister unknown skill: ${skillId}`);
                        return;
                }

                if (skill.isActive) {
                        await skill.deactivate();
                        this._notifyStateChange(skillId, 'disabled');
                }

                this._skills.delete(skillId);
                this._configs.delete(skillId);
                logger.verbose(`[SkillRegistry] Unregistered skill: ${skillId}`);
        }

        // --- Lifecycle ---

        async activateSkill(skillId: string, context: ISkillContext): Promise<void> {
                const skill = this._skills.get(skillId);
                if (!skill) {
                        throw new Error(`Cannot activate unknown skill: ${skillId}`);
                }

                if (skill.state === 'disabled') {
                        skill.state = 'loaded';
                        this._notifyStateChange(skillId, 'loaded');
                }

                try {
                        // Merge stored config into context.
                        const storedConfig = this._configs.get(skillId) ?? {};
                        const mergedContext: ISkillContext = {
                                ...context,
                                config: { ...storedConfig, ...context.config },
                        };

                        await skill.activate(mergedContext);
                        this._notifyStateChange(skillId, 'active');
                } catch (err) {
                        this._notifyStateChange(skillId, 'error');
                        throw err;
                }
        }

        async deactivateSkill(skillId: string): Promise<void> {
                const skill = this._skills.get(skillId);
                if (!skill) {
                        logger.verbose(`[SkillRegistry] Cannot deactivate unknown skill: ${skillId}`);
                        return;
                }

                await skill.deactivate();
                this._notifyStateChange(skillId, 'disabled');
        }

        async activateAll(context: ISkillContext): Promise<void> {
                const skillIds = Array.from(this._skills.keys());
                for (const skillId of skillIds) {
                        const skill = this._skills.get(skillId)!;
                        if (skill.state === 'loaded' || skill.state === 'disabled') {
                                try {
                                        await this.activateSkill(skillId, context);
                                } catch (err) {
                                        // Log but don't throw — other skills should still activate.
                                        logger.warn(
                                                `[SkillRegistry] Failed to activate skill "${skillId}": ` +
                                                `${err instanceof Error ? err.message : String(err)}`,
                                        );
                                }
                        }
                }
        }

        // --- Query ---

        listSkills(): ISkill[] {
                return Array.from(this._skills.values());
        }

        getSkill(skillId: string): ISkill | undefined {
                return this._skills.get(skillId);
        }

        getSkillsByCategory(category: string): ISkill[] {
                return Array.from(this._skills.values()).filter(
                        skill => skill.manifest.category === category,
                );
        }

        getSkillsByRole(role: string): ISkill[] {
                return Array.from(this._skills.values()).filter(skill => {
                        const allowed = skill.manifest.allowedRoles;
                        // No restriction = available to all roles.
                        if (!allowed || allowed.length === 0) return true;
                        return allowed.includes(role);
                });
        }

        getActiveSkills(): ISkill[] {
                return Array.from(this._skills.values()).filter(skill => skill.isActive);
        }

        // --- System prompt building ---

        buildSkillSystemPrompt(role: string): string {
                const activeSkills = this.getActiveSkills();
                const roleSkills = activeSkills.filter(skill => {
                        const allowed = skill.manifest.allowedRoles;
                        if (!allowed || allowed.length === 0) return true;
                        return allowed.includes(role);
                });

                const fragments = roleSkills
                        .map(skill => skill.manifest.systemPromptFragment)
                        .filter((fragment): fragment is string => typeof fragment === 'string' && fragment.length > 0);

                if (fragments.length === 0) {
                        return '';
                }

                return fragments.join('\n\n');
        }

        // --- Tool routing ---

        findSkillForTool(toolName: string): ISkill | undefined {
                for (const skill of this._skills.values()) {
                        if (skill.manifest.tools.includes(toolName)) {
                                return skill;
                        }
                }
                return undefined;
        }

        // --- Config ---

        getSkillConfig(skillId: string): Record<string, unknown> {
                return this._configs.get(skillId) ?? {};
        }

        setSkillConfig(skillId: string, config: Record<string, unknown>): void {
                const current = this._configs.get(skillId) ?? {};
                this._configs.set(skillId, { ...current, ...config });
                logger.verbose(`[SkillRegistry] Config updated for skill: ${skillId}`);
        }

        // --- Events ---

        onSkillStateChanged(handler: (skillId: string, state: SkillState) => void): void {
                this._stateChangeHandlers.push(handler);
        }

        // --- Internal ---

        /**
         * Notify all registered state-change handlers.
         */
        private _notifyStateChange(skillId: string, state: SkillState): void {
                for (const handler of this._stateChangeHandlers) {
                        try {
                                handler(skillId, state);
                        } catch (err) {
                                logger.warn(
                                        `[SkillRegistry] State change handler threw: ` +
                                        `${err instanceof Error ? err.message : String(err)}`,
                                );
                        }
                }
        }
}

// ---------------------------------------------------------------------------
// Singleton + accessor
// ---------------------------------------------------------------------------

let _instance: SkillRegistryService | undefined;

/**
 * Construct the singleton skill registry. Called once during app
 * initialization. Throws if called twice.
 */
export function initSkillRegistry(): SkillRegistryService {
        if (_instance) {
                throw new Error('SkillRegistryService has already been initialised. Use getSkillRegistry() instead.');
        }
        _instance = new SkillRegistryService();
        return _instance;
}

/**
 * Returns the singleton skill registry instance. Available after
 * `initSkillRegistry()` has been called.
 */
export function getSkillRegistry(): SkillRegistryService | undefined {
        return _instance;
}
