/**
 * Host-based routing.
 *
 * `<route>.<domain>` (plus any per-service `domains` aliases) resolves to its
 * service, so a reverse proxy only has to forward requests with the Host
 * header intact — no `/proxy/<route>` path rewrite. The prefixed
 * `/proxy/<route>` form keeps working for existing setups.
 */
import { type ServiceMap } from "./config";

/** The subset of an incoming request the router looks at. */
export interface RoutableRequest {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** Matches `/proxy/<route>` at the start of a URL (followed by `/`, `?` or the end). */
export const PROXY_PREFIX_RE = /^\/proxy\/([a-z0-9-]+)(?=\/|\?|$)/i;

export interface HostRouter {
  /** hostname → route, for every hostname the proxy answers for by name */
  readonly hosts: Readonly<Record<string, string>>;
  /**
   * The HTTP service a request's hostname points at, or `null`. X-Forwarded-Host
   * wins over Host so the original hostname survives intermediate proxies. Falls
   * back to matching the first DNS label against route names, which makes host
   * routing work even when `domain` is not set in config.json.
   */
  routeForHost(req: RoutableRequest): string | null;
  /**
   * Route for a WebSocket upgrade: the `/proxy/<route>` prefix first, then the
   * hostname — mirroring the HTTP middleware order. Only routes for which
   * `isProxied` returns true are considered.
   */
  routeForUpgrade(req: RoutableRequest, isProxied: (route: string) => boolean): string | null;
}

/** Build the hostname map and matching functions for a set of services. */
export function createHostRouter(services: ServiceMap, domain?: string): HostRouter {
  const hosts: Record<string, string> = {};
  for (const svc of Object.values(services)) {
    if (svc.type === "tcp") continue;
    if (domain) hosts[`${svc.route}.${domain}`.toLowerCase()] = svc.route;
    for (const alias of svc.domains ?? []) hosts[alias.toLowerCase()] = svc.route;
  }

  function routeForHost(req: RoutableRequest): string | null {
    const raw = firstValue(req.headers["x-forwarded-host"] ?? req.headers.host)
      .split(",")[0]
      .trim()
      .toLowerCase();
    if (!raw) return null;
    const host = raw.replace(/:\d+$/, "");
    if (hosts[host]) return hosts[host];
    const label = host.split(".")[0];
    if (services[label] && services[label].type !== "tcp") return label;
    return null;
  }

  function routeForUpgrade(
    req: RoutableRequest,
    isProxied: (route: string) => boolean,
  ): string | null {
    const prefixed = PROXY_PREFIX_RE.exec(req.url ?? "");
    if (prefixed && isProxied(prefixed[1])) return prefixed[1];
    const route = routeForHost(req);
    return route && isProxied(route) ? route : null;
  }

  return { hosts, routeForHost, routeForUpgrade };
}

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
