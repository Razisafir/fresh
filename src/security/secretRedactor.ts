/**
 * secretRedactor.ts — Layer 1 pure-logic: backward-compat shim over secretPatterns.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/security/secretRedactor.ts` (29L)
 * Port strategy: VERBATIM. Pure re-export, no logic.
 *
 * 02_ARCHITECTURE.md §4.6 lists this as a Layer 1 port-verbatim file.
 *
 * The canonical implementation lives in `secretPatterns.ts` (single source
 * of truth shared with `promptSanitiser.ts`). This file exists only so
 * existing imports of `redactSecrets` or `SECRET_PATTERNS` from
 * `'./secretRedactor'` continue to work. New code should import directly
 * from `'./secretPatterns'`.
 *
 * Closes K2-M4: the SEC-7 L3 pattern set (nvapi-, gsk_, ghp_/gho_/ghs_,
 * glpat-, xox*, Authorization: Basic, UPPER_CASE env names, 32+ hex)
 * was previously only in the agentLoop-side sanitiser; the tool-registry
 * path silently redacted fewer secrets. Both paths now share one module.
 *
 * Decisions referenced: D-001 (file-by-file audit).
 */

export {
	SECRET_PATTERNS,
	redactSecrets,
	resetSecretPatterns,
	listSecretPatternNames,
	type SecretPattern,
} from './secretPatterns';
