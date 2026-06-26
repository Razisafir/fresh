/**
 * childEnv.ts — Layer 1 pure-logic: SEC-9 child-process env sanitisation.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/security/childEnv.ts` (169L)
 * Port strategy: VERBATIM. Pure logic; only uses Node's `process.env` global,
 * which is available in the extension host.
 *
 * 02_ARCHITECTURE.md §4.6 lists this as a Layer 1 port-verbatim file.
 *
 * Prior state (SEC-7 H2): `_buildChildEnv()` was a private method on
 * `MCPConnectionPool` with an allowlist of parent-env keys. The v2 audit
 * (Kovix-Security-Audit-v2.docx) found four gaps:
 *
 *   K2-H1 — `mcpProcessNode.spawnServer()` still spread `{ ...process.env }`,
 *           bypassing the allowlist entirely (separate spawn path).
 *   K2-H2 — `_buildChildEnv()` layered `def.env` on top of the allowlisted
 *           parent env WITHOUT validating `def.env` keys against a dangerous-
 *           env denylist. A malicious marketplace entry could set
 *           `NODE_OPTIONS=--require /tmp/evil.js` or `LD_PRELOAD=/tmp/x.so`.
 *   K2-H3 — `agentReachMcpServer.buildCommandEnv()` spread `...process.env`
 *           for curl/yt-dlp/python3/mcporter grandchildren.
 *   K2-H4 — `uiuxProMaxMcpServer` spawned python3 with `...process.env`.
 *
 * This module is the single canonical implementation. Every spawn site in
 * the Kovix tree MUST route env construction through `buildChildEnv()`.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route).
 */

/**
 * Parent-env keys that are safe to pass through to spawned MCP server
 * children. Everything else is dropped — a malicious `def.env` cannot
 * reach the child via the parent env, and a compromised parent shell
 * cannot leak secrets (AWS_*, GITHUB_TOKEN, KOVIX_ENCRYPTION_KEY_HEX,
 * database URLs, etc.) into MCP grandchildren.
 */
export const PARENT_ENV_ALLOWLIST: readonly string[] = [
	// Binary resolution
	'PATH', 'PATHEXT', 'Path',
	// User / config dirs
	'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
	// Locale
	'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
	// Identity / shell (read-only metadata, not secrets)
	'USER', 'LOGNAME', 'SHELL', 'TERM',
	// OS basics (Windows + temp dirs)
	'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR',
	// Kovix read-only config flags (NOT secrets — secrets live in SecretStorage)
	'KOVIX_ALLOW_PRIVATE_NET', 'KOVIX_ALLOW_LOOPBACK',
	'PONYTAIL_DEFAULT_MODE',
];

/**
 * Env keys that are ALWAYS stripped from `serverEnv` (def.env), even if the
 * marketplace entry or workspace config explicitly sets them.
 *
 * These keys allow code injection into the spawned child or its descendants
 * (Node, dynamic linkers, Python, Perl, Ruby, JVM, Electron). A malicious
 * marketplace entry setting any of these is a direct RCE primitive; we refuse
 * to pass them through and log a warning so the user knows their server
 * definition was sanitized.
 */
export const DENIED_ENV_KEYS: readonly string[] = [
	// Node.js code injection
	'NODE_OPTIONS',
	'NODE_PATH',
	'NODE_REPL_EXTERNAL_MODULE',
	'NODE_EXTRA_CA_CERTS',        // allows MITM with attacker CA
	'NODE_DEBUG',
	// Dynamic linker hijack (Linux / macOS / *BSD)
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'LD_AUDIT',
	'LD_BIND_NOW',                 // benign-ish, but stripped for consistency
	'DYLD_INSERT_LIBRARIES',
	'DYLD_LIBRARY_PATH',
	'DYLD_FALLBACK_LIBRARY_PATH',
	'LD_PRELOAD_64',
	// Electron / runtime escape
	'ELECTRON_RUN_AS_NODE',
	'ELECTRON_ENABLE_LOGGING',
	'ELECTRON_NO_ASAR',
	'ELECTRON_OVERRIDE_DIST_PATH',
	// Python code injection
	'PYTHONSTARTUP',
	'PYTHONPATH',
	'PYTHONINSPECT',
	'PYTHONDONTWRITEBYTECODE',
	'PYTHONHOME',
	'PYTHONWARNINGS',              // can be abused for module-load gadgetry
	// Perl / Ruby / JVM
	'PERL5OPT',
	'PERLLIB',
	'PERL5LIB',
	'RUBYOPT',
	'RUBYLIB',
	'CLASSPATH',
	'JAVA_TOOL_OPTIONS',
	'_JAVA_OPTIONS',
	// Generic shell-injection vectors
	'ENV',
	'BASH_ENV',
	'ZDOTDIR',
	'ENVFILE',
	// npm / yarn config — can pull arbitrary tarballs
	'npm_config_prefix',
	'npm_config_userconfig',
	'npm_config_globalconfig',
	'npm_config_cache',
	'YARN_CACHE_FOLDER',
];

/**
 * Build the env object for a spawned MCP server child process.
 *
 * 1. Start with an empty object.
 * 2. Copy through only the allowlisted parent-env keys (PATH, HOME, LANG, ...).
 * 3. Layer `serverEnv` (def.env) on top, BUT strip any key that appears in
 *    `DENIED_ENV_KEYS`. Stripped keys are returned via the second tuple
 *    element so callers can log them.
 *
 * @param serverEnv  The per-server env block from the MCP server definition.
 * @returns `[childEnv, strippedKeys]` — the env to pass to spawn(), and the
 *          list of denied keys that were stripped (for telemetry / logging).
 */
export function buildChildEnv(
	serverEnv?: Record<string, string>,
): { env: Record<string, string>; strippedKeys: string[] } {
	const env: Record<string, string> = {};
	const parentEnv = process.env as Record<string, string>;

	// Step 1+2: allowlisted parent env
	for (const key of PARENT_ENV_ALLOWLIST) {
		if (parentEnv[key] !== undefined && parentEnv[key] !== '') {
			env[key] = parentEnv[key];
		}
	}

	// Step 3: layer serverEnv, stripping dangerous keys
	const strippedKeys: string[] = [];
	if (serverEnv) {
		const deniedSet = new Set(DENIED_ENV_KEYS);
		for (const [k, v] of Object.entries(serverEnv)) {
			if (deniedSet.has(k)) {
				strippedKeys.push(k);
				continue;
			}
			// Defensive: also strip case-insensitive variants on Windows
			// (Windows env is case-insensitive; Node normalizes to the
			// exact case set by the parent). If the lowercase form is in
			// the denylist, strip the variant.
			if (deniedSet.has(k.toUpperCase()) || deniedSet.has(k.toLowerCase())) {
				strippedKeys.push(k);
				continue;
			}
			env[k] = v as string;
		}
	}

	return { env, strippedKeys };
}
