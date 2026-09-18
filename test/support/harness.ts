/**
 * Boots the built wake proxy (`wake-proxy/dist`) as a child process on free
 * ports, in front of throwaway services, for the API (Postman/newman) and
 * end-to-end (Playwright) suites. Nothing here touches Docker: services that
 * must be "woken" are started by their `startCommand` as child processes
 * running test/support/mock-backend.js, exactly like the documented
 * non-Docker service setup.
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const PROXY_ENTRY = path.join(REPO_ROOT, "wake-proxy", "dist", "wake-proxy.js");
export const MOCK_BACKEND = path.join(__dirname, "mock-backend.js");
/** Every service answers on `<route>.<DOMAIN>` */
export const DOMAIN = "test.local";

export interface HarnessService {
  route: string;
  port: number;
  host: string;
}

export interface Harness {
  /** `http://127.0.0.1:<proxyPort>` */
  baseUrl: string;
  proxyPort: number;
  domain: string;
  /** Always running (in-process backend) */
  up: HarnessService;
  /** Asleep until the first request; woken by a startCommand (JSON API tests) */
  sleepy: HarnessService;
  /** Asleep until the first request; woken by a startCommand, with log streaming (browser tests) */
  dozy: HarnessService;
  /** Asleep, uses the example custom wake page */
  custom: HarnessService;
  /** Its startCommand always fails, so every wake ends in the failed state */
  never: HarnessService;
  /** Everything the proxy printed so far */
  proxyOutput(): string;
  stop(): Promise<void>;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function startInProcessBackend(port: number, name: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (
          req.method === "GET" &&
          req.url === "/" &&
          String(req.headers.accept).includes("text/html")
        ) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<!DOCTYPE html><html><head><title>${name} is up</title></head><body><h1 id="app">${name} service is running</h1></body></html>`,
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ name, method: req.method, url: req.url, headers: req.headers, body }),
        );
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function waitForHealth(url: string, timeoutMs: number, output: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`wake proxy did not become healthy at ${url}. Output so far:\n${output()}`);
}

/** Start the proxy and its services. Requires `npm run build` to have produced wake-proxy/dist. */
export async function startHarness(): Promise<Harness> {
  if (!fs.existsSync(PROXY_ENTRY)) {
    throw new Error(`${PROXY_ENTRY} not found — run "npm run build" first`);
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wakeup-harness-"));
  const stateDir = path.join(workDir, "state");
  const proxyPort = await getFreePort();
  const service = async (route: string): Promise<HarnessService> => ({
    route,
    port: await getFreePort(),
    host: `${route}.${DOMAIN}`,
  });
  const [up, sleepy, dozy, custom, never] = await Promise.all(
    ["up", "sleepy", "dozy", "custom", "never"].map(service),
  );
  const upServer = await startInProcessBackend(up.port, "up");

  // Woken services are started the way CONFIGURATION.md describes for
  // non-Docker services: a detached background process whose pid is kept
  // so stopCommand (and the harness teardown) can end it
  const pidFile = (svc: HarnessService) => path.join(workDir, `${svc.route}.pid`);
  const wakeCommand = (svc: HarnessService) =>
    `nohup node ${MOCK_BACKEND} ${svc.port} ${svc.route} >/dev/null 2>&1 & echo $! > ${pidFile(svc)}`;
  const stopCommand = (svc: HarnessService) =>
    `kill $(cat ${pidFile(svc)}) 2>/dev/null; rm -f ${pidFile(svc)}`;

  const config = {
    proxyPort,
    bindHost: "127.0.0.1",
    domain: DOMAIN,
    updateCheck: false,
    services: [
      { route: up.route, target: `http://127.0.0.1:${up.port}`, startCommand: "true" },
      {
        route: sleepy.route,
        target: `http://127.0.0.1:${sleepy.port}`,
        startCommand: wakeCommand(sleepy),
        stopCommand: stopCommand(sleepy),
      },
      {
        route: dozy.route,
        target: `http://127.0.0.1:${dozy.port}`,
        startCommand: wakeCommand(dozy),
        stopCommand: stopCommand(dozy),
        showLogs: true,
        logsCommand: "printf 'dozy | booting\\ndozy | ready\\n'; sleep 30",
      },
      {
        route: custom.route,
        target: `http://127.0.0.1:${custom.port}`,
        startCommand: wakeCommand(custom),
        stopCommand: stopCommand(custom),
        wakePage: "examples/custom-wake-page.html",
      },
      { route: never.route, target: `http://127.0.0.1:${never.port}`, startCommand: "false" },
    ],
  };
  const configPath = path.join(workDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  let output = "";
  const proxy: ChildProcess = spawn(process.execPath, [PROXY_ENTRY], {
    cwd: workDir,
    env: {
      ...process.env,
      WAKEUP_CONFIG: configPath,
      WAKEUP_STATE_DIR: stateDir,
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxy.stdout?.on("data", (chunk) => (output += chunk));
  proxy.stderr?.on("data", (chunk) => (output += chunk));
  const exited = new Promise<void>((resolve) => proxy.on("exit", () => resolve()));

  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  try {
    await waitForHealth(`${baseUrl}/healthz`, 15_000, () => output);
  } catch (e) {
    proxy.kill("SIGKILL");
    upServer.close();
    throw e;
  }

  const killWoken = () => {
    for (const svc of [sleepy, dozy, custom]) {
      try {
        const pid = Number(fs.readFileSync(pidFile(svc), "utf8").trim());
        if (pid > 0) process.kill(pid, "SIGTERM");
      } catch {
        // not started, or already gone
      }
    }
  };

  return {
    baseUrl,
    proxyPort,
    domain: DOMAIN,
    up,
    sleepy,
    dozy,
    custom,
    never,
    proxyOutput: () => output,
    stop: async () => {
      proxy.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (proxy.exitCode === null) proxy.kill("SIGKILL");
      killWoken();
      upServer.closeAllConnections();
      await new Promise<void>((resolve) => upServer.close(() => resolve()));
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}
