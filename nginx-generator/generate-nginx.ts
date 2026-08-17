import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const configPath = path.resolve(__dirname, "../config.json");
const outputDir = path.resolve(__dirname, "./confs");
const targetDir = "/etc/nginx/sites-enabled";

// Run as a regular user; privileged operations use sudo explicitly so
// generated conf files stay owned by the user, not root
const sudo = typeof process.getuid === "function" && process.getuid() === 0 ? "" : "sudo ";
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

if (!fs.existsSync(configPath)) {
  console.error("config.json not found.");
  process.exit(1);
}

interface ServiceConfig {
  route: string;
  target: string;
  type?: "http" | "tcp";
}

interface Config {
  proxyPort: number;
  idleThreshold?: number;
  domain?: string;
  services: ServiceConfig[];
}

const config: Config = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (!config.domain) {
  console.error('No "domain" set in config.json — add e.g. "domain": "example.com" and re-run.');
  process.exit(1);
}
const domain: string = config.domain;
const proxyPort: number = config.proxyPort || 8080;

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const sitesEnabledExists = fs.existsSync(targetDir);
if (!sitesEnabledExists) {
  console.warn(`${targetDir} not found — skipping symlink installation and NGINX reload.`);
  console.warn(`Copy the generated confs from ${outputDir} into your NGINX setup manually.`);
}

// Clean up broken symlinks in targetDir
if (sitesEnabledExists) {
  for (const file of fs.readdirSync(targetDir)) {
    const dest = path.join(targetDir, file);
    try {
      if (fs.lstatSync(dest).isSymbolicLink()) {
        const target = fs.readlinkSync(dest);
        if (!fs.existsSync(target)) {
          execSync(`${sudo}rm -- ${shellQuote(dest)}`);
          console.log(`Removed broken symlink: ${dest}`);
        }
      }
    } catch {
      // ignore
    }
  }
}

// Markers that let users keep hand edits across regenerations:
// - a file containing MANUAL_MARKER anywhere is never touched
// - lines between CUSTOM_START and CUSTOM_END are carried over into the
//   regenerated file (e.g. auth_basic, extra headers, rate limits)
const MANUAL_MARKER = "# wakeup:manual";
const CUSTOM_START = "# custom-start";
const CUSTOM_END = "# custom-end";

function extractCustomLines(conf: string): string[] {
  const lines = conf.split("\n");
  const start = lines.findIndex((l) => l.includes(CUSTOM_START));
  const end = lines.findIndex((l) => l.includes(CUSTOM_END));
  if (start === -1 || end === -1 || end <= start) return [];
  return lines.slice(start + 1, end);
}

// Create NGINX config files for each service
for (const svc of config.services) {
  // Raw TCP services (game servers etc.) are proxied directly by the wake
  // proxy's TCP listener — no HTTP server block applies
  if (svc.type === "tcp") {
    console.log(`Skipped ${svc.route}: type "tcp" services don't use an HTTP NGINX config`);
    continue;
  }

  const outputPath = path.join(outputDir, `${svc.route}.conf`);

  let customLines: string[] = [];
  if (fs.existsSync(outputPath)) {
    const existing = fs.readFileSync(outputPath, "utf8");
    if (existing.includes(MANUAL_MARKER)) {
      console.log(`Kept as-is (${MANUAL_MARKER}): ${outputPath}`);
      continue;
    }
    customLines = extractCustomLines(existing);
    if (customLines.length > 0) {
      console.log(`Preserving ${customLines.length} custom line(s) in ${svc.route}.conf`);
    }
  }

  const customBlock = customLines.length > 0 ? customLines.join("\n") + "\n" : "";
  const fullDomain = `${svc.route}.${domain}`;
  const nginxConf = `
server {
    listen 80;
    server_name ${fullDomain};

    location / {
        ${CUSTOM_START} (lines between these markers survive regeneration)
${customBlock}        ${CUSTOM_END}

        proxy_pass http://127.0.0.1:${proxyPort}/proxy/${svc.route}/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}`.trim();

  try {
    fs.writeFileSync(outputPath, nginxConf + "\n");
    console.log(`Generated: ${outputPath}`);
  } catch (e: any) {
    console.error(
      `Failed to write ${outputPath}: ${e?.message ?? e}\n` +
      `  (If it's owned by root from an older version, fix with: sudo chown $USER ${outputPath})`
    );
  }
}

if (sitesEnabledExists) {
  // Safely create symlinks in /etc/nginx/sites-enabled
  fs.readdirSync(outputDir).forEach(file => {
    if (file === "example.conf") return; // documentation only
    if (file.endsWith(".conf")) {
      const src = path.join(outputDir, file);
      const dest = path.join(targetDir, file);
      try {
        if (fs.existsSync(dest)) {
          const stat = fs.lstatSync(dest);
          if (stat.isSymbolicLink() && fs.readlinkSync(dest) === src) {
            return; // Correct symlink already exists
          }
          execSync(`${sudo}rm -- ${shellQuote(dest)}`); // Wrong symlink or regular file
        }
        execSync(`${sudo}ln -s -- ${shellQuote(src)} ${shellQuote(dest)}`);
        console.log(`Symlinked: ${dest} → ${src}`);
      } catch (e) {
        console.error(`Failed to link ${file}:`, e);
      }
    }
  });

  // === Reload NGINX ===
  try {
    console.log("\nValidating NGINX config...");
    execSync(`${sudo}nginx -t`, { stdio: "inherit" });

    console.log("Reloading NGINX...");
    execSync(`${sudo}systemctl reload nginx`, { stdio: "inherit" });

    console.log("NGINX reloaded successfully!");
  } catch (error) {
    console.error("NGINX reload failed. Check the configuration above.");
    process.exit(1);
  }
}
