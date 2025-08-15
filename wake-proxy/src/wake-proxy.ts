import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import axios from "axios";
import { exec } from 'child_process';
import fs from "fs";
import path from "path";
import { startIdleShutdownChecker } from "./idleShutdown";

interface ServiceConfig {
  route: string;
  target: string;
  composeDir: string;
}

interface Config {
  proxyPort: number;
  services: ServiceConfig[];
  idleThreshold: number;
}

if (!fs.existsSync('/bin/sh')) {
  throw new Error('/bin/sh does not exist or is not accessible');
}

const config: Config = JSON.parse(fs.readFileSync("/home/jelliott/docker-wake-up/config.json", "utf8"));
const app = express();

// Prevent repeated wake-ups for the same service
const cooldown: Record<string, number> = {};
const COOLDOWN_MS = 60_000; // 60 seconds

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

Object.entries(SERVICES).forEach(([route, svc]) => {
  const proxy = createProxyMiddleware({
    target: svc.target,
    changeOrigin: true,
    ws: true,
    pathRewrite: { [`^/proxy/${route}`]: "" },
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
    onError: async (err: any, req: any, res: any, next: any) => {
      console.warn(`Initial proxy to ${route} failed, attempting recovery...`);

      // Cooldown logic to avoid rapid retries
      const now = Date.now();
      if (cooldown[route] && now - cooldown[route] < COOLDOWN_MS) {
        console.log(`Skipping recovery for ${route}: in cooldown.`);
        if (res && !res.headersSent) {
          res.writeHead(503, { "Content-Type": "text/html" });
          res.end(`<h1>${route} is starting up. Try again in a few seconds.</h1>`);
        }
        return;
      }
      cooldown[route] = now;

      try {
        await bringUpService(svc.composeDir);
        await waitForHttpReady(svc.target, 60000);

        // Retry proxy once after startup
        createProxyMiddleware({
          target: svc.target,
          changeOrigin: true,
          ws: true,
          pathRewrite: { [`^/proxy/${route}`]: "" },
        })(req, res, typeof next === "function" ? next : () => { });
      } catch (e) {
        console.error(`Failed to recover service ${route}:`, e);
        if (res && !res.headersSent) {
          res.writeHead(503, { "Content-Type": "text/html" });
          res.end(`<h1>${route} is starting up. Try again shortly.</h1>`);
        }
      }
    },
  });

  app.use(`/proxy/${route}`, proxy);
});


app.listen(config.proxyPort || 8080, () => {
  console.log(`Wake proxy listening on port ${config.proxyPort}`);
});

// Start idle shutdown checker (interval: 5 min)
startIdleShutdownChecker(SERVICES, config.idleThreshold);

async function bringUpService(composeDir: string): Promise<string> {

  return new Promise((resolve, reject) => {
    const cmd = "docker compose -f docker-compose.yml up -d";

    exec(cmd, { cwd: composeDir, env: process.env }, (err: Error | null, stdout: string, stderr: string) => {
      if (!err) {
        return resolve(stdout);
      }

      // Check if /bin/sh is available
      if (!fs.existsSync("/bin/sh")) {
        console.error("/bin/sh does not exist or is not accessible");
      }

      // Check if docker-compose.yml exists in the service directory
      const composeFile = path.join(composeDir, "docker-compose.yml");
      if (!fs.existsSync(composeFile)) {
        console.error(`Missing docker-compose.yml at: ${composeFile}`);
      }

      console.error(stderr);

      // Check for container name conflict
      const match = stderr.match(/container name "(.+?)" is already in use/);
      if (match) {
        const containerName = match[1];
        console.warn(`Container conflict detected: ${containerName}. Attempting to remove...`);

        // Remove the conflicting container
        exec(`docker rm -f ${containerName}`, { env: process.env }, (rmErr: Error | null, rmOut: string, rmStderr: string) => {
          if (rmErr) {
            console.error(`Failed to remove conflicting container: ${rmStderr}`);
            return reject(rmErr);
          }

          console.log(`Removed ${containerName}. Retrying docker compose...`);

          // Retry docker compose
          exec(cmd, { cwd: composeDir, env: process.env }, (retryErr: Error | null, retryOut: string, retryStderr: string) => {
            if (retryErr) {
              console.error(`Retry failed: ${retryStderr}`);
              return reject(retryErr);
            }

            resolve(retryOut);
          });
        });
      } else {
        reject(err);
      }
    });
  });
}

// Wait for service to be reachable
async function waitForHttpReady(url: string, timeoutMs: number = 30000, interval: number = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await axios.get(url, { timeout: 2000 });
      if (res.status >= 200 && res.status < 500) return;
    } catch { }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timeout: ${url} did not become ready`);
}
