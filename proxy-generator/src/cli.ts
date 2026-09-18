// The command line: argument parsing and the dispatch to one generator.
// `main` returns the exit code instead of calling process.exit so the whole
// run can be driven from tests; generate.ts turns it into process.exitCode.
import { generateCaddy } from "./caddy";
import { loadGeneratorConfig, resolveConfigPath } from "./config";
import { type GeneratorContext } from "./context";
import { generateNginx } from "./nginx";
import { generateTraefik } from "./traefik";

/** The reverse proxies a config can be generated for. */
export const PROXY_KINDS = ["nginx", "caddy", "traefik"] as const;
export type ProxyKind = (typeof PROXY_KINDS)[number];

/** Printed (to stderr) when --proxy is missing or names an unknown proxy. */
export const USAGE =
  "Usage: generate.ts --proxy nginx|caddy|traefik [/path/to/config.json] [--caddyfile-only]";

export interface ParsedArgs {
  /** The value of `--proxy <x>` / `--proxy=<x>`, "" when absent; validated by main(). */
  proxy: string;
  /** The first positional argument: the config.json path, if given. */
  configPath: string | undefined;
  /** `--caddyfile-only`: skip docker-compose.override.yml (SystemD/PM2 deployments). */
  caddyfileOnly: boolean;
}

/** Parses the arguments after the script name. Unknown `--flags` are ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  let proxy = "";
  const positional: string[] = [];
  let caddyfileOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--proxy") proxy = argv[++i] ?? "";
    else if (arg.startsWith("--proxy=")) proxy = arg.slice("--proxy=".length);
    else if (arg === "--caddyfile-only") caddyfileOnly = true;
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  return { proxy, configPath: positional[0], caddyfileOnly };
}

function isProxyKind(value: string): value is ProxyKind {
  return (PROXY_KINDS as readonly string[]).includes(value);
}

/**
 * Runs the generator for `argv` (the arguments after the script name) and
 * returns the process exit code: 1 for a usage error, a missing config file,
 * a config without "domain", or a failed NGINX reload; 0 otherwise.
 */
export function main(argv: string[], ctx: GeneratorContext): number {
  const args = parseArgs(argv);
  if (!isProxyKind(args.proxy)) {
    console.error(USAGE);
    return 1;
  }

  const loaded = loadGeneratorConfig(resolveConfigPath(args.configPath, ctx.generatorDir));
  if (!loaded.ok) {
    console.error(loaded.message);
    return 1;
  }

  switch (args.proxy) {
    case "nginx":
      return generateNginx(loaded.settings, ctx);
    case "traefik":
      generateTraefik(loaded.settings, ctx);
      return 0;
    case "caddy":
      generateCaddy(loaded.settings, ctx, args.caddyfileOnly);
      return 0;
  }
}
