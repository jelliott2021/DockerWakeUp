import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import fs from "fs";
import path from "path";
import { startIdleShutdownChecker } from "./idleShutdown";
import {
  triggerWake,
  getWakeStatus,
  getExpectedWakeMs,
  streamServiceLogs,
  isServiceReady,
  waitForReady,
} from "./wakeManager";
import { startTcpProxy, TcpServiceConfig } from "./tcpProxy";
import { renderWakePage } from "./wakePage";
import { startUpdateChecker, getUpdateInfo } from "./updateChecker";
import { touchLastAccess } from "./lastAccess";

interface ServiceConfig {
  route: string;
  target: string;
  composeDir?: string;
  autoOff?: boolean;
  type?: "http" | "tcp"; // default "http"; "tcp" proxies raw bytes (game servers etc.)
  listenPort?: number;   // tcp only: port the TCP wake proxy listens on
  wakePage?: string;     // optional custom "starting up" page (path to an HTML file)
  showLogs?: boolean;    // opt-in: set true to stream container logs on the wake page
  startCommand?: string; // hook run BEFORE docker compose up -d (or the whole start if no composeDir)
  stopCommand?: string;  // hook run AFTER docker compose stop (or the whole stop if no composeDir)
  logsCommand?: string;  // custom startup-log command (default: docker compose logs -f)
  domains?: string[];    // extra hostnames that resolve to this service (host-based routing)
}

interface Config {
  proxyPort: number;
  services: ServiceConfig[];
  idleThreshold: number;
  domain?: string;       // host-based routing: <route>.<domain> resolves to the service
  wakePage?: string;     // default custom wake page for all services
  updateCheck?: boolean; // set false to disable the daily update check
}

if (!fs.existsSync('/bin/sh')) {
  throw new Error('/bin/sh does not exist or is not accessible');
}

const config: Config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), "utf8"));
const app = express();

// A proxy fronting every service must not die because one request hit an
// unexpected error path — log loudly instead of crashing
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection in wake-proxy:", reason);
});

const SERVICES: Record<string, ServiceConfig> = {};
config.services.forEach((svc) => {
  if (!svc.composeDir && !svc.startCommand) {
    console.warn(`Service ${svc.route}: no composeDir or startCommand configured — it cannot be woken`);
  }
  SERVICES[svc.route] = svc;
});

// ---------------------------------------------------------------------------
// Host-based routing. <route>.<domain> (plus any per-service `domains`
// aliases) resolves to its service, so a reverse proxy only has to forward
// requests with the Host header intact — no /proxy/<route> path rewrite.
// The prefixed /proxy/<route> form keeps working for existing setups.
// ---------------------------------------------------------------------------
const HOSTS: Record<string, string> = {};
config.services.forEach((svc) => {
  if (svc.type === "tcp") return;
  if (config.domain) HOSTS[`${svc.route}.${config.domain}`.toLowerCase()] = svc.route;
  (svc.domains ?? []).forEach((d) => { HOSTS[d.toLowerCase()] = svc.route; });
});

/**
 * The service a request's hostname points at, or null. X-Forwarded-Host wins
 * over Host so the original hostname survives any intermediate proxies.
 * Falls back to matching the first DNS label against route names, which
 * makes host routing work even when `domain` isn't set in config.json.
 */
function routeForHost(req: { headers: Record<string, unknown> }): string | null {
  const raw = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
    .split(",")[0].trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/:\d+$/, "");
  if (HOSTS[host]) return HOSTS[host];
  const label = host.split(".")[0];
  if (SERVICES[label] && SERVICES[label].type !== "tcp") return label;
  return null;
}

// ---------------------------------------------------------------------------
// Wake status endpoints (must be registered BEFORE the proxy middleware).
// Behind nginx, the browser requests /__wake/... which nginx rewrites to
// /proxy/<route>/__wake/...; direct access uses the full path.
// ---------------------------------------------------------------------------

// Liveness probe (used by the docker-compose healthcheck). On a hostname that
// belongs to a service, fall through so the service's own /healthz is proxied.
app.get("/healthz", (req, res, next) => {
  if (routeForHost(req)) return next();
  res.json({ ok: true, services: Object.keys(SERVICES).length, update: getUpdateInfo() });
});

// JSON readiness poll used by the wake page
async function wakeStatusHandler(svc: ServiceConfig, res: express.Response): Promise<void> {
  const status = getWakeStatus(svc.route);
  const ready = await isServiceReady(svc);
  res.json({
    state: status.state,
    ready,
    startedAt: status.startedAt,
    error: status.error,
    // For the "usually ready in ~Xs" progress estimate
    expectedMs: getExpectedWakeMs(svc.route),
    elapsedMs: status.state === "starting" && status.startedAt ? Date.now() - status.startedAt : null,
  });
}

// Live startup logs streamed as Server-Sent Events
function wakeLogsHandler(svc: ServiceConfig, req: express.Request, res: express.Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering for this response
  });
  res.write("retry: 3000\n\n");

  // Logs exist for the startup page only. Streaming is limited to an active
  // (or just-failed) wake — otherwise this endpoint would be a public live
  // tap into any running service's logs, and `--tail` would expose the
  // previous run's logs for sleeping ones.
  const state = getWakeStatus(svc.route).state;
  let stopLogs = () => { };
  if (svc.showLogs !== true) {
    // Off by default: startup logs often contain config/connection details,
    // and anyone who can reach the URL can read this stream during a wake.
    res.write(`data: ${JSON.stringify('[wake-proxy] log streaming is disabled for this service (set "showLogs": true in config.json to enable)')}\n\n`);
  } else if (state !== "starting" && state !== "failed") {
    res.write(`data: ${JSON.stringify("[wake-proxy] log streaming is only available while the service is starting")}\n\n`);
  } else {
    stopLogs = streamServiceLogs(svc, (line) => {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    });
  }

  // Keep intermediaries from closing an otherwise-quiet connection
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(ping);
    stopLogs();
  });
}

// Path-prefixed form (direct access / legacy reverse proxy configs)
app.get("/proxy/:route/__wake/status", (req, res) => {
  const svc = SERVICES[req.params.route];
  if (!svc) return void res.status(404).json({ error: "unknown service" });
  wakeStatusHandler(svc, res);
});
app.get("/proxy/:route/__wake/logs", (req, res) => {
  const svc = SERVICES[req.params.route];
  if (!svc) return void res.sendStatus(404);
  wakeLogsHandler(svc, req, res);
});

// Host-resolved form (reverse proxies that just forward the request)
app.get("/__wake/status", (req, res, next) => {
  const route = routeForHost(req);
  if (!route) return next();
  wakeStatusHandler(SERVICES[route], res);
});
app.get("/__wake/logs", (req, res, next) => {
  const route = routeForHost(req);
  if (!route) return next();
  wakeLogsHandler(SERVICES[route], req, res);
});

// ---------------------------------------------------------------------------
// Service proxies
// ---------------------------------------------------------------------------

function proxyOptions(route: string, svc: ServiceConfig, withHandlers: boolean) {
  return {
    target: svc.target,
    changeOrigin: true,
    ws: true,
    pathRewrite: { [`^/proxy/${route}`]: "" },
    onProxyReq: (proxyReq: any, req: any, res: any) => {
      // Preserve original headers for proper CORS/CSRF handling
      if (req.headers['x-forwarded-host']) {
        proxyReq.setHeader('X-Forwarded-Host', req.headers['x-forwarded-host']);
        proxyReq.setHeader('Host', req.headers['x-forwarded-host']);
      }
      if (req.headers['x-forwarded-proto']) {
        proxyReq.setHeader('X-Forwarded-Proto', req.headers['x-forwarded-proto']);
      }
    },
    ...(withHandlers ? {
      onProxyRes: (proxyRes: any, req: any, res: any) => {
        if (proxyRes.statusCode && proxyRes.statusCode >= 200 && proxyRes.statusCode < 400) {
          touchLastAccess(route);
        }
      },
      onError: (err: any, req: any, res: any, next: any) => handleProxyError(route, svc, req, res, next),
    } : {}),
  };
}

async function handleProxyError(route: string, svc: ServiceConfig, req: any, res: any, next: any) {
  console.warn(`Proxy to ${route} failed, waking service...`);

  // Fire-and-forget; deduped inside the wake manager
  triggerWake(route, svc);

  // Failed WebSocket upgrades hand us a raw socket, not a response object —
  // treating it as a response crashes the process. Close it and let the
  // client's reconnect logic retry once the service is awake.
  if (!res || typeof res.writeHead !== "function") {
    if (res && typeof res.destroy === "function") {
      res.on("error", () => { });
      res.destroy();
    }
    return;
  }

  const method = String(req.method || "").toUpperCase();
  const wantsHtml = method === "GET" && String(req.headers.accept || "").includes("text/html");

  if (wantsHtml) {
    // Browser navigation: show the startup page immediately. It polls
    // /__wake/status and reloads once the service is up.
    if (!res.headersSent) {
      res.writeHead(503, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "5",
      });
      res.end(renderWakePage(route, svc.wakePage ?? config.wakePage));
    }
    return;
  }

  // The failed proxy attempt already consumed the request stream, so a retry
  // would replay non-idempotent requests with an empty body. Only wait-and-
  // retry safe methods; everything else gets an immediate 503 + Retry-After.
  if (method !== "GET" && method !== "HEAD") {
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "15" });
      res.end(JSON.stringify({ error: `${route} is starting up. Retry shortly.` }));
    }
    return;
  }

  // Safe methods (API/asset GETs): wait for the service, then retry once
  try {
    await waitForReady(svc, 60000);
    createProxyMiddleware(proxyOptions(route, svc, false))(
      req, res, typeof next === "function" ? next : () => { }
    );
  } catch (e) {
    console.error(`Failed to recover service ${route}:`, e);
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
      res.end(JSON.stringify({ error: `${route} is starting up. Try again shortly.` }));
    }
  }
}

const HTTP_PROXIES: Record<string, ReturnType<typeof createProxyMiddleware>> = {};
Object.entries(SERVICES).forEach(([route, svc]) => {
  if (svc.type === "tcp") {
    if (!svc.listenPort) {
      console.error(`Service ${route}: type "tcp" requires a listenPort — skipping`);
      return;
    }
    startTcpProxy(svc as TcpServiceConfig);
    return;
  }
  HTTP_PROXIES[route] = createProxyMiddleware(proxyOptions(route, svc, true));
  app.use(`/proxy/${route}`, HTTP_PROXIES[route]);
});

// Host-routed requests reuse the same per-service middleware — its
// pathRewrite only strips /proxy/<route> when the prefix is actually there,
// so unprefixed paths pass through unchanged.
app.use((req, res, next) => {
  const route = routeForHost(req);
  if (!route) return next();
  HTTP_PROXIES[route](req, res, next);
});


app.listen(config.proxyPort || 8080, () => {
  console.log(`Wake proxy listening on port ${config.proxyPort || 8080}`);
});

// Start idle shutdown checker (interval: 5 min)
startIdleShutdownChecker(SERVICES, config.idleThreshold);

// Check for new DockerWakeUp versions on startup and daily
if (config.updateCheck !== false) {
  startUpdateChecker();
}
