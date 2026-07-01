/**
 * skills.ts — Layer 1 type definitions for the skill registry system.
 *
 * A "skill" is a higher-order capability built on top of the tool layer.
 * Where a tool is a single atomic operation (read a file, run a command),
 * a skill composes multiple tools together with domain knowledge (a system
 * prompt fragment), role constraints, UI metadata, and configuration.
 *
 * Skill lifecycle:
 *   discovered → loaded → active → (disabled | error)
 *                      ↘ disabled
 *
 * Skill sources:
 *   - builtin  — shipped with Kovix, always available
 *   - user     — installed from ~/.kovix/skills/ directory
 *   - mcp      — contributed by an MCP server
 *   - marketplace — installed from a future Kovix marketplace
 *
 * The concrete registry implementation lives in
 * `src/skills/skillRegistryService.ts` (Layer 2).
 *
 * Layer 1 — pure types, no runtime logic, no side-effect imports.
 */

import type { IConstructToolRegistry } from './tools';

// ---------------------------------------------------------------------------
// Skill lifecycle states
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for a skill.
 *
 *   - discovered: manifest found but not yet loaded
 *   - loaded:     manifest validated and skill object constructed
 *   - active:     skill is running and its tools/prompt are available
 *   - error:      skill failed during activation
 *   - disabled:   skill was explicitly disabled by the user
 */
export type SkillState = 'discovered' | 'loaded' | 'active' | 'error' | 'disabled';

// ---------------------------------------------------------------------------
// Skill source
// ---------------------------------------------------------------------------

/**
 * Origin of a skill — where it was loaded from.
 *
 *   - builtin:     shipped with Kovix core
 *   - user:        installed by the user in ~/.kovix/skills/
 *   - mcp:         contributed by a connected MCP server
 *   - marketplace: installed from a Kovix marketplace (future)
 */
export type SkillSource = 'builtin' | 'user' | 'mcp' | 'marketplace';

// ---------------------------------------------------------------------------
// Skill manifest
// ---------------------------------------------------------------------------

/**
 * The JSON/YAML definition that describes a skill. This is the "recipe"
 * — it contains everything needed to instantiate and present the skill
 * without any runtime logic.
 *
 * Manifests for built-in skills are defined in code (see
 * `src/skills/builtin/`). User skill manifests live as JSON files in
 * `~/.kovix/skills/<skill-id>/manifest.json`.
 */
export interface ISkillManifest {
        /** Unique skill ID (e.g. "kovix.code-review"). */
        id: string;
        /** Human-readable name. */
        name: string;
        /** Semantic version (semver). */
        version: string;
        /** Short description of what this skill does. */
        description: string;
        /** Detailed description for skill detail view. */
        longDescription?: string;

        // --- Authorship ---

        /** Author name or organization. */
        author?: string;
        /** URL to the skill's homepage. */
        homepage?: string;
        /** URL to the skill's source repository. */
        repository?: string;
        /** SPDX license identifier. */
        license?: string;

        // --- Capabilities ---

        /**
         * Tool names this skill provides. These must be registered in the
         * tool registry (either built-in or MCP tools). The skill does NOT
         * register these tools itself — it references tools that already
         * exist and groups them under a coherent capability.
         */
        tools: string[];
        /**
         * System prompt fragment injected into the agent's system prompt
         * when this skill is active. Should be written as a self-contained
         * instruction block that the agent can follow.
         */
        systemPromptFragment?: string;
        /** Custom slash commands provided by this skill. */
        slashCommands?: ISkillSlashCommand[];

        // --- Constraints ---

        /**
         * Which agent roles can use this skill. Empty or undefined means
         * all roles can use it. Role strings match AgentRole values
         * (e.g. "general", "coder", "reviewer").
         */
        allowedRoles?: string[];
        /**
         * Tools that must be registered in the tool registry for this
         * skill to activate. If any required tool is missing, the skill
         * will remain in the "error" state with a descriptive message.
         */
        requiredTools?: string[];
        /**
         * MCP servers that must be connected for this skill to activate.
         * Server names must match the names in the app config's mcpServers.
         */
        requiredMcpServers?: string[];

        // --- UI ---

        /** Icon name or emoji for UI display. */
        icon?: string;
        /** Accent color as a hex string (e.g. "#10B981"). */
        color?: string;
        /** Category for grouping (e.g. "coding", "research", "writing", "devops"). */
        category?: string;
        /** Tags for search and filtering. */
        tags?: string[];

        // --- Memory ---

        /**
         * How long skill-specific memory persists.
         *   - session: cleared when the app restarts
         *   - project: persists per workspace
         *   - global: persists across all sessions and workspaces
         */
        memoryScope?: 'session' | 'project' | 'global';

        // --- Config ---

        /** User-configurable fields exposed in the skill settings UI. */
        configurable?: ISkillConfigField[];
}

// ---------------------------------------------------------------------------
// Skill slash command
// ---------------------------------------------------------------------------

/**
 * A custom slash command provided by a skill.
 *
 * Slash commands let users trigger skill-specific workflows with a short
 * command prefix (e.g. "/review" to start a code review).
 */
export interface ISkillSlashCommand {
        /** Command name including the slash prefix (e.g. "/review"). */
        name: string;
        /** What this command does. */
        description: string;
        /**
         * Function name in the skill module that handles this command.
         * Resolved at activation time.
         */
        handler: string;
        /** Alternative names (e.g. ["/cr"] for "/review"). */
        aliases?: string[];
}

// ---------------------------------------------------------------------------
// Skill config field
// ---------------------------------------------------------------------------

/**
 * A single user-configurable field for a skill.
 *
 * Rendered in the skill settings UI. Supports string, number, boolean,
 * and select (dropdown) types.
 */
export interface ISkillConfigField {
        /** Unique key within this skill's config namespace. */
        key: string;
        /** Value type — determines the UI control. */
        type: 'string' | 'number' | 'boolean' | 'select';
        /** Human-readable label. */
        label: string;
        /** Help text shown below the control. */
        description?: string;
        /** Default value when the user hasn't configured this field. */
        default?: unknown;
        /** Options for the 'select' type. */
        options?: { label: string; value: string }[];
        /** Whether this field must be set before the skill can activate. */
        required?: boolean;
}

// ---------------------------------------------------------------------------
// ISkillContext — provided to skill during activation
// ---------------------------------------------------------------------------

/**
 * Context object passed to a skill when it is activated.
 *
 * Provides access to the tool registry (for checking tool availability),
 * user configuration values, workspace roots, and an optional session ID.
 */
export interface ISkillContext {
        /** The tool registry — skills can check tool availability. */
        toolRegistry: IConstructToolRegistry;
        /** User-provided config values (from ISkillConfigField defaults + overrides). */
        config: Record<string, unknown>;
        /** Workspace root paths the agent can access. */
        workspaceRoots: string[];
        /** Current session ID (if available). */
        sessionId?: string;
}

// ---------------------------------------------------------------------------
// ISkill — runtime skill instance
// ---------------------------------------------------------------------------

/**
 * Runtime representation of an active (or inactive) skill.
 *
 * Created by the skill registry from an ISkillManifest. Implements the
 * lifecycle methods (activate/deactivate), tool execution delegation,
 * and exposes state for querying.
 */
export interface ISkill {
        /** The manifest this skill was created from. */
        manifest: ISkillManifest;
        /** Current lifecycle state. */
        state: SkillState;
        /** Where this skill came from. */
        source: SkillSource;

        // --- Lifecycle ---

        /**
         * Activate this skill. Called by the registry when transitioning
         * from "loaded" or "disabled" to "active".
         *
         * @param context Activation context with tool registry, config, etc.
         * @throws Error if activation fails (registry sets state to "error").
         */
        activate(context: ISkillContext): Promise<void>;

        /**
         * Deactivate this skill. Called by the registry when transitioning
         * from "active" to "disabled" or "loaded".
         */
        deactivate(): Promise<void>;

        // --- Tool execution ---

        /**
         * Execute a tool by name on behalf of this skill.
         *
         * The skill delegates to the tool registry — it does NOT implement
         * tool logic itself. This method exists so the registry can track
         * which skill "owns" a tool invocation for usage statistics.
         *
         * @param toolName Name of the tool to execute.
         * @param input Tool input parameters.
         * @param signal Optional AbortSignal for cancellation.
         * @returns The tool execution result.
         */
        executeTool(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;

        // --- State ---

        /** Whether this skill is currently active. */
        readonly isActive: boolean;
        /** The error that caused this skill to enter the "error" state. */
        readonly error?: Error;
        /** When this skill was last activated. */
        readonly activatedAt?: Date;
        /** How many times tools from this skill have been executed. */
        readonly usageCount: number;
}

// ---------------------------------------------------------------------------
// ISkillRegistry — the registry interface
// ---------------------------------------------------------------------------

/**
 * ISkillRegistry — registry for higher-order skills.
 *
 * Manages the full lifecycle of skills: discovery, registration,
 * activation, deactivation, and querying. Skills compose multiple tools
 * with domain knowledge (system prompt fragments), role constraints,
 * and UI metadata.
 *
 * The registry also:
 *   - Builds system prompt fragments from all active skills for a given role
 *   - Routes tool lookups to the owning skill (for usage tracking)
 *   - Stores per-skill configuration
 *   - Notifies listeners on skill state changes
 *
 * The concrete implementation lives in `src/skills/skillRegistryService.ts`.
 */
export interface ISkillRegistry {
        // --- Discovery ---

        /**
         * Discover skills from all sources (builtin + user directory).
         * User skills are loaded from manifest.json files in ~/.kovix/skills/ subdirectories.
         */
        discoverSkills(): Promise<void>;

        // --- Registration ---

        /**
         * Register a skill from its manifest and source.
         *
         * @param manifest The skill manifest.
         * @param source Where this skill came from.
         */
        registerSkill(manifest: ISkillManifest, source: SkillSource): Promise<void>;

        /**
         * Unregister a skill by ID. Deactivates it first if active.
         *
         * @param skillId The unique skill ID.
         */
        unregisterSkill(skillId: string): Promise<void>;

        // --- Lifecycle ---

        /**
         * Activate a skill by ID. Validates that all requiredTools are
         * available in the tool registry before activating.
         *
         * @param skillId The unique skill ID.
         * @param context Activation context.
         * @throws Error if the skill cannot be activated.
         */
        activateSkill(skillId: string, context: ISkillContext): Promise<void>;

        /**
         * Deactivate a skill by ID.
         *
         * @param skillId The unique skill ID.
         */
        deactivateSkill(skillId: string): Promise<void>;

        /**
         * Activate all registered skills that are in "loaded" or "disabled" state.
         *
         * @param context Activation context.
         */
        activateAll(context: ISkillContext): Promise<void>;

        // --- Query ---

        /** List all registered skills. */
        listSkills(): ISkill[];

        /** Get a specific skill by ID. */
        getSkill(skillId: string): ISkill | undefined;

        /** Get all skills in a given category. */
        getSkillsByCategory(category: string): ISkill[];

        /**
         * Get all skills that a given agent role can use.
         * Returns all skills if the skill has no allowedRoles restriction,
         * or if the role is in the skill's allowedRoles list.
         *
         * @param role Agent role string (e.g. "general", "coder").
         */
        getSkillsByRole(role: string): ISkill[];

        /** Get all currently active skills. */
        getActiveSkills(): ISkill[];

        // --- System prompt building ---

        /**
         * Build a combined system prompt fragment from all active skills
         * that are available to the given agent role.
         *
         * @param role Agent role string.
         * @returns Combined system prompt fragment, or empty string if none.
         */
        buildSkillSystemPrompt(role: string): string;

        // --- Tool routing ---

        /**
         * Find the skill that provides a given tool.
         *
         * @param toolName The tool name to look up.
         * @returns The owning skill, or undefined if no skill provides this tool.
         */
        findSkillForTool(toolName: string): ISkill | undefined;

        // --- Config ---

        /**
         * Get the current configuration for a skill.
         * Returns default values from the manifest's configurable fields
         * merged with any user overrides.
         *
         * @param skillId The unique skill ID.
         */
        getSkillConfig(skillId: string): Record<string, unknown>;

        /**
         * Set configuration overrides for a skill.
         *
         * @param skillId The unique skill ID.
         * @param config Configuration key-value pairs.
         */
        setSkillConfig(skillId: string, config: Record<string, unknown>): void;

        // --- Events ---

        /**
         * Register a handler for skill state changes.
         *
         * @param handler Called when any skill's state changes.
         */
        onSkillStateChanged(handler: (skillId: string, state: SkillState) => void): void;
}
