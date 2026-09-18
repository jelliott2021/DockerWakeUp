// Everything a generator does to the outside world — where it writes, which
// environment it reads, how it runs commands, whether it is root — goes through
// this context so tests can substitute all of it.
import { execSync, type ExecSyncOptions } from "child_process";

/** Runs a shell command synchronously (child_process.execSync by default). */
export type RunCommand = (command: string, options?: ExecSyncOptions) => unknown;

export interface GeneratorContext {
  /**
   * The proxy-generator directory. Outputs go under it (confs/, Caddyfile,
   * traefik-dynamic.yml); docker-compose.override.yml and the legacy
   * nginx-generator/confs are looked up in its parent.
   */
  generatorDir: string;
  /** Environment variables (NGINX_SITES_DIR); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Used for every rm/ln/nginx/systemctl call; defaults to execSync. */
  runCommand?: RunCommand;
  /** Whether privileged operations need no sudo; defaults to the process running as uid 0. */
  isRoot?: boolean;
}

/** A GeneratorContext with every default filled in. */
export type ResolvedContext = Required<GeneratorContext>;

/** Fills in the process-based defaults for the fields `ctx` leaves out. */
export function resolveContext(ctx: GeneratorContext): ResolvedContext {
  return {
    generatorDir: ctx.generatorDir,
    env: ctx.env ?? process.env,
    runCommand: ctx.runCommand ?? execSync,
    isRoot: ctx.isRoot ?? process.getuid?.() === 0,
  };
}
