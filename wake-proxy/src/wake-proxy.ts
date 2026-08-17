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
  showLogs?: boolean;    // set false to hide container logs from the wake page
  startCommand?: string; // hook run BEFORE docker compose up -d (or the whole start if no composeDir)
  stopCommand?: string;  // hook run AFTER docker compose stop (or the whole stop if no composeDir)
  logsCommand?: string;  // custom startup-log command (default: docker compose logs -f)
}

interface Config {
  proxyPort: number;
  services: ServiceConfig[];
  idleThreshold: number;
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
// Wake status endpoints (must be registered BEFORE the proxy middleware).
// Behind nginx, the browser requests /__wake/... which nginx rewrites to
// /proxy/<route>/__wake/...; direct access uses the full path.
// ---------------------------------------------------------------------------

// Liveness probe (used by the docker-compose healthcheck)
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, services: Object.keys(SERVICES).length, update: getUpdateInfo() });
});

// JSON readiness poll used by the wake page
app.get("/proxy/:route/__wake/status", async (req, res) => {
  const svc = SERVICES[req.params.route];
  if (!svc) {
    res.status(404).json({ error: "unknown service" });
    return;
  }
  const status = getWakeStatus(req.params.route);
  const ready = await isServiceReady(svc);
  res.json({
    state: status.state,
    ready,
    startedAt: status.startedAt,
    error: status.error,
    // For the "usually ready in ~Xs" progress estimate
    expectedMs: getExpectedWakeMs(req.params.route),
    elapsedMs: status.state === "starting" && status.startedAt ? Date.now() - status.startedAt : null,
  });
});

// Live startup logs streamed as Server-Sent Events
app.get("/proxy/:route/__wake/logs", (req, res) => {
  const svc = SERVICES[req.params.route];
  if (!svc) {
    res.sendStatus(404);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering for this response
  });
  res.write("retry: 3000\n\n");

  let stopLogs = () => { };
  if (svc.showLogs === false) {
    res.write(`data: ${JSON.stringify("[wake-proxy] log streaming is disabled for this service")}\n\n`);
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

Object.entries(SERVICES).forEach(([route, svc]) => {
  if (svc.type === "tcp") {
    if (!svc.listenPort) {
      console.error(`Service ${route}: type "tcp" requires a listenPort — skipping`);
      return;
    }
    startTcpProxy(svc as TcpServiceConfig);
    return;
  }
  app.use(`/proxy/${route}`, createProxyMiddleware(proxyOptions(route, svc, true)));
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
