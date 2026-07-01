/**
 * builtin/index.ts — barrel + registerBuiltinSkills() for built-in skills.
 *
 * Each built-in skill lives in its own file under `src/skills/builtin/` and
 * exports:
 *   - `<skillName>SkillManifest: ISkillManifest` — the skill manifest
 *   - `register<SkillName>Skill(registry: ISkillRegistry): void` —
 *     convenience wrapper for `registry.registerSkill(manifest, 'builtin')`
 *
 * The skill registry calls `registerBuiltinSkills(this)` in its constructor.
 * All built-in skills are registered unconditionally — there's no opt-in/
 * opt-out at construction time. Users can disable skills after init via
 * `registry.deactivateSkill()`.
 *
 * Built-in skills in v0.1:
 *   - kovix.code-review — structured code review
 *   - kovix.research    — research across web and codebase
 */

import type { ISkillRegistry } from '../../types/skills';
import { registerCodeReviewSkill } from './codeReviewSkill';
import { registerResearchSkill } from './researchSkill';

/**
 * Register all built-in skills with the given registry.
 *
 * Called by `SkillRegistryService` constructor. Idempotent — calling
 * twice will overwrite the previous registration (with a warning log
 * from the registry).
 *
 * Order matters only for log readability — the registry uses a Map, so
 * lookup is O(1) regardless of registration order.
 */
export function registerBuiltinSkills(registry: ISkillRegistry): void {
        registerCodeReviewSkill(registry);
        registerResearchSkill(registry);
}

// Re-export individual skill manifests for direct access.
export { codeReviewSkillManifest } from './codeReviewSkill';
export { researchSkillManifest } from './researchSkill';
