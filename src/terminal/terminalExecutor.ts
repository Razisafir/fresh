/**
 * terminalExecutor.ts — Layer 1 interface + Layer 2 concrete implementation
 * for executing shell commands from agent tool calls.
 *
 * Ported from: `Kovix_2.0/src/vs/platform/construct/common/terminal/terminalExecutor.ts` (298L, interface)
 *              `Kovix_2.0/src/vs/workbench/contrib/construct/browser/services/tools/constructToolRegistryService.ts` (lines 1003-1110, run_terminal impl)
 * Port strategy: PORT WITH TRANSLATION + REWRITE.
 *
 * 02_ARCHITECTURE.md §6 open architecture question (resolved per lead
 * recommendation in §6.1): use `child_process` for `run_command` tool
 * (agent runs commands silently, captures output). `vscode.tasks` will be
 * used only for the verification harness (user sees test/build output)
 * which is a separate v1.0 concern.
 *
 * Translation notes:
 *   - DI marker (`createDecorator`, `_serviceBrand`) removed.
 *   - The old impl routed through `ITerminalExecutor` IPC to a node-pty
 *     backend running in the VS Code shared process. The extension host
 *     already runs in Node, so we use `child_process.spawn` directly —
 *     no IPC layer needed.
 *   - Kali WSL2 detection/wrapping is DROPPED per 02_ARCHITECTURE.md §9
 *     non-goals (no Kali integration in v1, per W2 + D-008).
 *   - SEC-9 child env sanitisation is applied to every spawn via
 *     `buildChildEnv()` from `src/security/childEnv.ts`. This prevents
 *     a compromised parent env from leaking secrets (AWS_*, GITHUB_TOKEN,
 *     KOVIX_ENCRYPTION_KEY_HEX, etc.) into spawned grandchildren.
 *   - Rate limiting (10 cmds / 30s) is owned by the agent loop, NOT the
 *     executor. The agent loop will wrap `execute()` with the rate limiter
 *     in Round 2C. This separation lets the executor stay simple and lets
 *     the rate limit be per-session (not per-process).
 *   - The `onOutput` streaming callback is preserved so the agent loop
 *     can show real-time progress for long-running commands (npm install,
 *     cargo build, etc.) once the UI lands.
 *
 * Security invariants preserved (verified by Layer 1 unit tests + the
 * run_command tool's pre-spawn gate):
 *   - SEC-3: COMMAND_BLOCKLIST refused before spawn (defence-in-depth —
 *     the tool also checks).
 *   - SEC-9: buildChildEnv() strips dangerous env keys (NODE_OPTIONS,
 *     LD_PRELOAD, PYTHONPATH, ...) and only allowlists parent keys.
 *   - No shell: spawn uses `{ shell: false }` semantics by spawning the
 *     base command directly with arg array. This prevents shell-injection
 *     via command-string interpolation. The run_command tool splits the
 *     command string via `parseCommandString()` before calling execute().
 *
 * Decisions referenced: D-001 (file-by-file audit), D-008 (Kali/security
 * tools dropped), D-011 (extension route), SEC-3, SEC-9, W2 (no Kali).
 */

import * as child_process from 'child_process';
import { logger } from '../util/logger';
import { buildChildEnv } from '../security/childEnv';
import { isBlockedCommand, detectShellMetacharInArgs } from './commandBlocklist';

// ---------------------------------------------------------------------------
// Layer 1: ITerminalExecutor interface
// ---------------------------------------------------------------------------

/**
 * Result of a terminal command execution.
 */
export interface ITerminalExecResult {
        stdout: string;
        stderr: string;
        exitCode: number;
}

/**
 * Service for executing shell commands securely from agent tool calls.
 *
 * Security posture (preserved from old repo):
 *   - COMMAND_BLOCKLIST refused before spawn.
 *   - SEC-9 child env sanitisation applied to every spawn.
 *   - No shell: caller must split command into program + args array to
 *     prevent shell injection. (Use `parseCommandString()` below.)
 *   - Per-call timeout (default 30s, max 5min).
 *   - AbortSignal support for cancellation.
 *   - Streaming `onOutput` callback for real-time progress.
 *
 * Rate limiting is NOT enforced here — the agent loop owns the per-session
 * rate limiter (10 cmds / 30s per TERMINAL_RATE_LIMIT in old repo).
 */
export interface ITerminalExecutor {
        /**
         * Execute a command and return the result.
         *
         * @param program The program to run (e.g. `git`, `npm`, `node`).
         *                Must NOT contain spaces or shell metacharacters.
         * @param args    Argument array. Each arg is passed verbatim — no shell
         *                expansion happens. Use `parseCommandString()` to split
         *                a user-supplied command string into program + args.
         * @param options Optional: cwd, timeoutMs, signal, onOutput.
         * @returns Result with stdout, stderr, exit code.
         * @throws Error if program is on the blocklist or spawn fails.
         */
        execute(
                program: string,
                args: string[],
                options?: {
                        cwd?: string;
                        timeoutMs?: number;
                        signal?: AbortSignal;
                        onOutput?: (data: string) => void;
                },
        ): Promise<ITerminalExecResult>;

        /**
         * Check if a command (program + args joined) is on the security blocklist.
         * Returns true if refused. Callers should call this BEFORE execute() to
         * produce a user-facing error message rather than an exception.
         */
        isBlocked(command: string): boolean;
}

// ---------------------------------------------------------------------------
// Layer 1: command-string parser (NEW — old repo used bash -c)
// ---------------------------------------------------------------------------

/**
 * Parse a command string into a program name and argument array, honouring
 * double-quoted and single-quoted substrings.
 *
 * Examples:
 *   `git status` → ['git', ['status']]
 *   `npm "run build" --silent` → ['npm', ['run build', '--silent']]
 *   `echo 'hello world'` → ['echo', ['hello world']]
 *
 * This replaces the old repo's approach of passing the full command string
 * to a shell (`bash -c "..."`). The shell approach was vulnerable to
 * argument-injection when the LLM (or any caller) supplied crafted strings.
 * By parsing client-side and spawning the program directly (no shell), we
 * eliminate an entire class of injection attacks.
 *
 * Limitations:
 *   - Does not honour backslash escapes inside double quotes (treats `\`
 *     as literal). This is intentional — it's safer to be conservative
 *     than to perfectly emulate bash quoting. Callers who need full shell
 *     semantics should run via `bash -c <script>` explicitly.
 *   - Returns the program with any leading path prefix preserved
 *     (e.g. `/usr/bin/git` stays as `/usr/bin/git`).
 *
 * @throws Error if the command is empty or unbalanced quotes are found.
 */
export function parseCommandString(command: string): { program: string; args: string[] } {
        const trimmed = command.trim();
        if (!trimmed) {
                throw new Error('parseCommandString: empty command');
        }

        const tokens: string[] = [];
        let current = '';
        let inSingle = false;
        let inDouble = false;

        for (let i = 0; i < trimmed.length; i++) {
                const ch = trimmed[i];

                if (inSingle) {
                        if (ch === "'") {
                                inSingle = false;
                        } else {
                                current += ch;
                        }
                        continue;
                }

                if (inDouble) {
                        if (ch === '"') {
                                inDouble = false;
                        } else {
                                current += ch;
                        }
                        continue;
                }

                if (ch === "'") {
                        inSingle = true;
                        continue;
                }

                if (ch === '"') {
                        inDouble = true;
                        continue;
                }

                if (ch === ' ' || ch === '\t') {
                        if (current.length > 0) {
                                tokens.push(current);
                                current = '';
                        }
                        continue;
                }

                current += ch;
        }

        if (inSingle || inDouble) {
                throw new Error(`parseCommandString: unbalanced quotes in: ${command}`);
        }

        if (current.length > 0) {
                tokens.push(current);
        }

        if (tokens.length === 0) {
                throw new Error(`parseCommandString: no tokens in: ${command}`);
        }

        return { program: tokens[0], args: tokens.slice(1) };
}

// ---------------------------------------------------------------------------
// Layer 2: concrete implementation
// ---------------------------------------------------------------------------

/**
 * Concrete ITerminalExecutor backed by `child_process.spawn`.
 *
 * Singleton — constructed once by the service registry (future services.ts).
 * Use the exported `terminalExecutor` instance, do not construct additional
 * instances.
 *
 * Security: every spawn goes through `buildChildEnv()` (SEC-9). The
 * `program` argument is passed directly to spawn (no shell), so the only
 * injection surface is the program-name lookup itself, which the OS
 * resolves against PATH. Argument injection is prevented by `parseCommandString()`
 * honouring quotes and not expanding shell metacharacters.
 */
export class TerminalExecutor implements ITerminalExecutor {

        /**
         * Default per-command timeout. The run_command tool can override
         * (capped at 5 minutes to prevent runaway processes).
         */
        static readonly DEFAULT_TIMEOUT_MS = 30_000;

        /**
         * Hard cap on per-command timeout. Tool callers requesting a longer
         * timeout are silently capped.
         */
        static readonly MAX_TIMEOUT_MS = 5 * 60_000;

        isBlocked(command: string): boolean {
                return isBlockedCommand(command);
        }

        async execute(
                program: string,
                args: string[],
                options?: {
                        cwd?: string;
                        timeoutMs?: number;
                        signal?: AbortSignal;
                        onOutput?: (data: string) => void;
                },
        ): Promise<ITerminalExecResult> {
                // Defence-in-depth: blocklist check on the joined command string.
                // The run_command tool also checks — we check again here in case a
                // future caller forgets.
                const joined = `${program} ${args.join(' ')}`;
                if (this.isBlocked(joined)) {
                        throw new Error(`Command blocked by safety policy: ${joined}`);
                }

                // SEC-3 defence-in-depth: scan the PROGRAM token for shell metacharacters.
                // We spawn with `shell: false` (line below) so metacharacters in ARGUMENTS
                // are passed literally to the program — not interpreted as shell syntax.
                // The primary defence is therefore `shell: false`, NOT this scan.
                //
                // We deliberately scan ONLY the program token, not the joined string,
                // because legitimate commands like `git commit -m "fix: foo; bar"` have
                // a quoted argument that contains `;` — scanning the joined string would
                // false-positive on every commit message with punctuation. The PROGRAM
                // token (a binary name like `git`, `npm`, `ls`) should never legitimately
                // contain a metacharacter; if it does, `parseCommandString()` failed to
                // split the command correctly and we should refuse rather than spawn
                // whatever the parsed "program" turned out to be.
                const metachar = detectShellMetacharInArgs(program);
                if (metachar) {
                        throw new Error(
                                `Command rejected: shell metacharacter "${metachar}" detected in program token "${program}". ` +
                                `This usually means the command string was not parsed correctly (the program name should ` +
                                `be a single token with no shell syntax). Rewrite the command or run it manually in the terminal.`,
                        );
                }

                const timeoutMs = Math.min(
                        options?.timeoutMs ?? TerminalExecutor.DEFAULT_TIMEOUT_MS,
                        TerminalExecutor.MAX_TIMEOUT_MS,
                );

                // SEC-9: build a sanitised env. Strips NODE_OPTIONS, LD_PRELOAD,
                // PYTHONPATH, etc. and only allowlists parent-env keys (PATH, HOME,
                // LANG, ...). The stripped keys are logged so the user can see if
                // their workspace config tried to inject anything dangerous.
                const { env, strippedKeys } = buildChildEnv();
                if (strippedKeys.length > 0) {
                        logger.warn(
                                `[TerminalExecutor] Stripped ${strippedKeys.length} dangerous env keys from spawn: ${strippedKeys.join(', ')}`,
                        );
                }

                return new Promise<ITerminalExecResult>((resolve, reject) => {
                        const proc = child_process.spawn(program, args, {
                                cwd: options?.cwd,
                                env,
                                stdio: ['ignore', 'pipe', 'pipe'],
                                // No shell — program is spawned directly. This is the
                                // critical security property: no metacharacter expansion,
                                // no command chaining, no $() substitution.
                                shell: false,
                        });

                        let stdout = '';
                        let stderr = '';
                        let settled = false;

                        const cleanup = () => {
                                proc.stdout?.removeAllListeners();
                                proc.stderr?.removeAllListeners();
                                proc.removeAllListeners();
                        };

                        // Stream stdout
                        proc.stdout?.on('data', (chunk: Buffer) => {
                                const text = chunk.toString('utf8');
                                stdout += text;
                                options?.onOutput?.(text);
                        });

                        // Stream stderr (still goes to onOutput — many tools write
                        // progress to stderr, e.g. npm, cargo, pip)
                        proc.stderr?.on('data', (chunk: Buffer) => {
                                const text = chunk.toString('utf8');
                                stderr += text;
                                options?.onOutput?.(text);
                        });

                        // Timeout
                        const timer = setTimeout(() => {
                                if (settled) return;
                                settled = true;
                                try { proc.kill('SIGKILL'); } catch { /* already exited */ }
                                cleanup();
                                resolve({
                                        stdout,
                                        stderr: stderr + `\n[TerminalExecutor] Timeout after ${timeoutMs}ms`,
                                        exitCode: -1,
                                });
                        }, timeoutMs);

                        // AbortSignal
                        if (options?.signal) {
                                if (options.signal.aborted) {
                                        if (!settled) {
                                                settled = true;
                                                clearTimeout(timer);
                                                try { proc.kill('SIGKILL'); } catch { /* noop */ }
                                                cleanup();
                                                resolve({ stdout, stderr: stderr + '\n[TerminalExecutor] Aborted before start', exitCode: -1 });
                                        }
                                } else {
                                        options.signal.addEventListener('abort', () => {
                                                if (settled) return;
                                                settled = true;
                                                clearTimeout(timer);
                                                try { proc.kill('SIGKILL'); } catch { /* noop */ }
                                                cleanup();
                                                resolve({ stdout, stderr: stderr + '\n[TerminalExecutor] Aborted by caller', exitCode: -1 });
                                        }, { once: true });
                                }
                        }

                        proc.on('error', (err) => {
                                if (settled) return;
                                settled = true;
                                clearTimeout(timer);
                                cleanup();
                                reject(err);
                        });

                        proc.on('close', (code) => {
                                if (settled) return;
                                settled = true;
                                clearTimeout(timer);
                                cleanup();
                                resolve({
                                        stdout,
                                        stderr,
                                        exitCode: code ?? -1,
                                });
                        });
                });
        }
}

/**
 * Singleton instance. Constructed at module load time.
 *
 * Future services.ts will own this and re-export it; for now, code that
 * needs the terminal executor imports from here directly.
 */
export const terminalExecutor = new TerminalExecutor();
