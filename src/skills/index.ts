/**
 * skills/index.ts — barrel re-exports for the skill registry system.
 *
 * Re-exports the singleton accessor functions and all skill types so
 * consumers can import from `src/skills` without knowing internal paths.
 *
 * Usage:
 *   import { initSkillRegistry, getSkillRegistry } from '../skills';
 *   import type { ISkill, ISkillManifest } from '../skills';
 */

// Singleton accessors
export { initSkillRegistry, getSkillRegistry } from './skillRegistryService';

// Re-export the concrete class for type narrowing (rarely needed)
export { SkillRegistryService } from './skillRegistryService';

// Re-export all skill types
export type {
        SkillState,
        SkillSource,
        ISkillManifest,
        ISkillSlashCommand,
        ISkillConfigField,
        ISkillContext,
        ISkill,
        ISkillRegistry,
} from '../types/skills';

// Re-export built-in skill manifests
export { codeReviewSkillManifest, researchSkillManifest } from './builtin';
