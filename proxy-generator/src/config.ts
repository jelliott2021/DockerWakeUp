// config.json as the generators see it: locating and loading the file, the
// validation the CLI reports on, the proxyPort default, and the hostnames
// each service answers to.
import fs from "fs";
import path from "path";

export interface ServiceConfig {
  route: string;
  target: string;
  type?: "http" | "tcp";
  domains?: string[]; // extra hostnames the wake proxy also answers for
}

export interface Config {
  proxyPort?: number;
  domain?: string;
  // Address Caddy uses to reach the wake proxy. Defaults to
  // host.docker.internal:<proxyPort> (what a caddy-docker-proxy container
  // needs). Use 127.0.0.1:<proxyPort> for a Caddy running directly on the host.
  caddyUpstream?: string;
  // Traefik equivalents: upstream the router points at, the entrypoint name,
  // and (optionally) a certresolver for the routers' tls block. Without a
  // resolver no tls key is emitted — enable TLS at the entrypoint instead
  // (like examples/traefik.yml) or set traefikCertResolver.
  traefikUpstream?: string;
  traefikEntrypoint?: string;
  traefikCertResolver?: string;
  services: ServiceConfig[];
}

/** What every generator consumes, resolved once from config.json by the CLI. */
export interface GeneratorSettings {
  /** Absolute path of the config file; its basename appears in generated headers. */
  configPath: string;
  config: Config;
  domain: string;
  /** Port the wake proxy listens on: config.proxyPort or DEFAULT_PROXY_PORT. */
  proxyPort: number;
  /** The HTTP services in config order — tcp services are left out. */
  services: ServiceConfig[];
}

/** Outcome of loadGeneratorConfig: the settings, or the message the CLI prints before exiting 1. */
export type LoadResult = { ok: true; settings: GeneratorSettings } | { ok: false; message: string };

/** Used when config.json has no (truthy) proxyPort. */
export const DEFAULT_PROXY_PORT = 8080;

/**
 * Absolute path of the config file: the CLI's positional argument (resolved
 * against the current directory), else ../config.json next to the generator.
 */
export function resolveConfigPath(positional: string | undefined, generatorDir: string): string {
  return path.resolve(positional ?? path.join(generatorDir, "../config.json"));
}

/**
 * Reads and validates config.json. A missing file or a missing "domain" comes
 * back as `{ ok: false }` with the message to print; malformed JSON throws
 * like any other unexpected error. Logs one line per skipped tcp service.
 */
export function loadGeneratorConfig(configPath: string): LoadResult {
  if (!fs.existsSync(configPath)) return { ok: false, message: `${configPath} not found.` };
  const config: Config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.domain) {
    return {
      ok: false,
      message: 'No "domain" set in config.json — add e.g. "domain": "example.com" and re-run.',
    };
  }
  return {
    ok: true,
    settings: {
      configPath,
      config,
      domain: config.domain,
      proxyPort: config.proxyPort || DEFAULT_PROXY_PORT,
      services: httpServices(config),
    },
  };
}

/** The services that get an HTTP reverse proxy config; every tcp service is skipped with a message. */
export function httpServices(config: Config): ServiceConfig[] {
  return config.services.filter((svc) => {
    // Raw TCP services (game servers etc.) are proxied directly by the wake
    // proxy's TCP listener — no HTTP reverse proxy config applies
    if (svc.type === "tcp") {
      console.log(
        `Skipped ${svc.route}: type "tcp" services don't use an HTTP reverse proxy config`,
      );
      return false;
    }
    return true;
  });
}

/** All hostnames that should reach this service. */
export function hostsFor(svc: ServiceConfig, domain: string): string[] {
  return [`${svc.route}.${domain}`, ...(svc.domains ?? [])];
}
