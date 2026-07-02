/**
 * Type stubs for node-pty.
 * Full types are available when node-pty is installed (npm ci).
 * This stub allows typecheck to pass in environments without node-pty.
 */
declare module 'node-pty' {
  interface IPty {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData: (listener: (data: string) => void) => void;
    onExit: (listener: (e: { exitCode: number; signal?: number }) => void) => void;
  }

  interface ISpawnOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options?: ISpawnOptions
  ): IPty;
}
