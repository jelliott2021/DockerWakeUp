/**
 * config.json: types, loading and validation.
 *
 * Every option is documented in CONFIGURATION.md; the comments here only
 * summarise what the code relies on.
 */
import fs from "fs";
import path from "path";
import { errorMessage } from "./util";

/** One entry of the `services` array. */
export interface ServiceConfig {
  /** Service name and subdomain label — letters, digits and dashes only */
  route: string;
  /** Where the service listens once awake: `http://host:port`, or `host:port` for TCP */
  target: string;
  /** Directory with the service's compose file; waking runs `docker compose up -d` here */
  composeDir?: string;
  /** `false` exempts the service from idle shutdown */
  autoOff?: boolean;
  /** `"tcp"` proxies raw bytes (game servers etc.); default `"http"` */
  type?: "http" | "tcp";
  /** TCP only: port the wake proxy listens on for clients */
  listenPort?: number;
  /** Custom "starting up" HTML page (absolute, or relative to the project root) */
  wakePage?: string;
  /** Opt-in: stream container logs on the wake page while the service starts */
  showLogs?: boolean;
  /** Hook run before `docker compose up -d`, or the whole start when there is no composeDir */
  startCommand?: string;
  /** Hook run after `docker compose stop`, or the whole stop when there is no composeDir */
  stopCommand?: string;
  /** Command producing the wake page's log stream (default: `docker compose logs -f`) */
  logsCommand?: string;
  /** Extra hostnames that resolve to this service */
  domains?: string[];
}

/** A `"type": "tcp"` service whose `listenPort` has been validated. */
export interface TcpServiceConfig extends ServiceConfig {
  type: "tcp";
  listenPort: number;
}

/** Top-level shape of config.json. */
export interface Config {
  /** Port the HTTP wake proxy listens on (default 8080) */
  proxyPort?: number;
  /** Address the HTTP proxy binds to (default 0.0.0.0); TCP services always bind all interfaces */
  bindHost?: string;
  /** Base domain for host-based routing: `<route>.<domain>` resolves to the service */
  domain?: string;
  /** Seconds without a successful request before a service is stopped; unset disables idle shutdown */
  idleThreshold?: number;
  /** Default custom wake page for all services */
  wakePage?: string;
  /** `false` disables the daily update check */
  updateCheck?: boolean;
  services: ServiceConfig[];
}

/** Services indexed by route name. */
export type ServiceMap = Record<string, ServiceConfig>;

export const DEFAULT_PROXY_PORT = 8080;
export const DEFAULT_BIND_HOST = "0.0.0.0";

/**
 * Project root (the directory holding config.json). Resolved from this file's
 * location so it works for both `dist/` (production) and `src/` (ts-node).
 */
export const PROJECT_ROOT = path.resolve(__dirname, "../..");

/**
 * Routes end up in file names, RegExps, hostnames and generated configs —
 * fail closed on anything but a plain name.
 */
export const ROUTE_RE = /^[a-z0-9-]+$/i;

/**
 * Path of the config file: `$WAKEUP_CONFIG` when set (tests, alternative
 * layouts), otherwise `config.json` in the project root.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.WAKEUP_CONFIG
    ? path.resolve(env.WAKEUP_CONFIG)
    : path.join(PROJECT_ROOT, "config.json");
}

/** Read and parse config.json, checking only the shape the proxy cannot live without. */
export function loadConfig(configPath: string): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read ${configPath}: ${errorMessage(e)}`, { cause: e });
  }
  if (!isObject(parsed) || !Array.isArray(parsed.services)) {
    throw new Error(`${configPath} must be a JSON object with a "services" array`);
  }
  return parsed as unknown as Config;
}

/** `true` for `"type": "tcp"` services (their listenPort is validated by `indexServices`). */
export function isTcpService(svc: ServiceConfig): svc is TcpServiceConfig {
  return svc.type === "tcp";
}

/**
 * Validate the services and index them by route. Entries the proxy could not
 * serve safely are logged and skipped rather than crashing the whole proxy.
 */
export function indexServices(services: ServiceConfig[]): ServiceMap {
  const map: ServiceMap = {};
  for (const svc of services) {
    if (!ROUTE_RE.test(svc.route ?? "")) {
      console.error(
        `Service route ${JSON.stringify(svc.route ?? null)} is invalid (letters, digits and dashes only) — skipping`,
      );
      continue;
    }
    if (typeof svc.target !== "string" || svc.target.length === 0) {
      console.error(`Service ${svc.route}: "target" is required — skipping`);
      continue;
    }
    if (
      svc.type === "tcp" &&
      !(Number.isInteger(svc.listenPort) && (svc.listenPort as number) > 0)
    ) {
      console.error(`Service ${svc.route}: type "tcp" requires a listenPort — skipping`);
      continue;
    }
    if (!svc.composeDir && !svc.startCommand) {
      console.warn(
        `Service ${svc.route}: no composeDir or startCommand configured — it cannot be woken`,
      );
    }
    if (map[svc.route]) {
      console.warn(`Service ${svc.route}: duplicate route in config.json — the later entry wins`);
    }
    map[svc.route] = svc;
  }
  return map;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
