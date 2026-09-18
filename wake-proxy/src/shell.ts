/**
 * Promise wrappers around child_process for the few shell commands the proxy
 * runs (docker compose, user hooks).
 */
import { exec, execFile } from "child_process";

/** Error from a failed command, carrying what the command printed to stderr. */
export class CommandError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

/**
 * Run a shell command line via `/bin/sh -c` (what `exec` does) in `cwd`.
 * Rejects with a `CommandError` on a non-zero exit.
 */
export function runShell(command: string, cwd?: string): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new CommandError(err.message, stderr));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Run an executable with an argument list — no shell involved, so arguments
 * taken from untrusted output (container names parsed from docker's stderr)
 * cannot be interpreted as shell syntax.
 */
export function runFile(file: string, args: string[]): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (err, stdout, stderr) => {
      if (err) reject(new CommandError(err.message, stderr));
      else resolve({ stdout, stderr });
    });
  });
}
