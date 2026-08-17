import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import fs from "fs";
import path from "path";
import { startIdleShutdownChecker } from "./idleShutdown";
import {
  triggerWake,
  getWakeStatus,
  streamComposeLogs,
  isHttpReady,
  waitForHttpReady,
} from "./wakeManager";
import { renderWakePage } from "./wakePage";
import { startUpdateChecker, getUpdateInfo } from "./updateChecker";

interface ServiceConfig {
  route: string;
  target: string;
  composeDir: string;
  autoOff?: boolean;
  wakePage?: string; // optional custom "starting up" page (path to an HTML file)
}

interface Config {
  proxyPort: number;
  services: ServiceConfig[];
  idleThreshold: number;
  wakePage?: string; // default custom wake page for all services
  updateCheck?: boolean; // set false to disable the daily update check
}

if (!fs.existsSync('/bin/sh')) {
  throw new Error('/bin/sh does not exist or is not accessible');
}

const config: Config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), "utf8"));
const app = express();

// tmp folder inside the service's working directory
const tmpDir = path.join(process.cwd(), "tmp");

// create the tmp folder if it doesn't exist
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

const SERVICES: Record<string, ServiceConfig> = {};
config.services.forEach((svc) => {
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
  const ready = await isHttpReady(svc.target);
  res.json({
    state: status.state,
    ready,
    startedAt: status.startedAt,
    error: status.error,
  });
});

// Live docker compose logs streamed as Server-Sent Events
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

  const stopLogs = streamComposeLogs(svc.composeDir, (line) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  });

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
          try {
            // write the last access file inside tmp
            const filePath = path.join(tmpDir, `last_access_${route}`);
            fs.writeFileSync(filePath, Date.now().toString());
          } catch (e) {
            console.error(`Failed to write last access file for ${route}:`, e);
          }
        }
      },
      onError: (err: any, req: any, res: any, next: any) => handleProxyError(route, svc, req, res, next),
    } : {}),
  };
}

async function handleProxyError(route: string, svc: ServiceConfig, req: any, res: any, next: any) {
  console.warn(`Proxy to ${route} failed, waking service...`);

  // Fire-and-forget; deduped inside the wake manager
  triggerWake(route, svc.composeDir, svc.target);

  const wantsHtml =
    req.method === "GET" && String(req.headers.accept || "").includes("text/html");

  if (wantsHtml) {
    // Browser navigation: show the startup page immediately. It polls
    // /__wake/status and reloads once the service is up.
    if (res && !res.headersSent) {
      res.writeHead(503, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Retry-After": "5",
      });
      res.end(renderWakePage(route, svc.wakePage ?? config.wakePage));
    }
    return;
  }

  // API/asset requests: wait for the service, then retry the proxy once
  try {
    await waitForHttpReady(svc.target, 60000);
    createProxyMiddleware(proxyOptions(route, svc, false))(
      req, res, typeof next === "function" ? next : () => { }
    );
  } catch (e) {
    console.error(`Failed to recover service ${route}:`, e);
    if (res && !res.headersSent) {
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
      res.end(JSON.stringify({ error: `${route} is starting up. Try again shortly.` }));
    }
  }
}

Object.entries(SERVICES).forEach(([route, svc]) => {
  app.use(`/proxy/${route}`, createProxyMiddleware(proxyOptions(route, svc, true)));
});


app.listen(config.proxyPort || 8080, () => {
  console.log(`Wake proxy listening on port ${config.proxyPort}`);
});

// Start idle shutdown checker (interval: 5 min)
startIdleShutdownChecker(SERVICES, config.idleThreshold);

// Check for new DockerWakeUp versions on startup and daily
if (config.updateCheck !== false) {
  startUpdateChecker();
}
