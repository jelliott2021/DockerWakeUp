import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const configPath = path.resolve(__dirname, "../config.json");
const outputDir = path.resolve(__dirname, "./confs");
const targetDir = "/etc/nginx/sites-enabled";

if (!fs.existsSync(configPath)) {
  console.error("config.json not found.");
  process.exit(1);
}

interface ServiceConfig {
  route: string;
  container: string;
  target: string;
}

interface Config {
  proxyPort: number;
  idleThreshold?: number;
  domain?: string;
  services: ServiceConfig[];
}

const config: Config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const domain: string = config.domain || "boozebrawl.com";

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Clean up broken symlinks in targetDir
for (const file of fs.readdirSync(targetDir)) {
  const dest = path.join(targetDir, file);
  try {
    if (fs.lstatSync(dest).isSymbolicLink()) {
      const target = fs.readlinkSync(dest);
      if (!fs.existsSync(target)) {
        fs.unlinkSync(dest);
        console.log(`Removed broken symlink: ${dest}`);
      }
    }
  } catch {
    // ignore
  }
}

// Create NGINX config files for each service
for (const { route } of config.services) {
  const fullDomain = `${route}.${domain}`;
  const nginxConf = `
server {
    listen 80;
    server_name ${fullDomain};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ${fullDomain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:8080/proxy/${route}/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}`.trim();

  const outputPath = path.join(outputDir, `${route}.conf`);
  fs.writeFileSync(outputPath, nginxConf + "\n");
  console.log(`Generated: ${outputPath}`);
}

// Safely create symlinks in /etc/nginx/sites-enabled
fs.readdirSync(outputDir).forEach(file => {
  if (file.endsWith(".conf")) {
    const src = path.join(outputDir, file);
    const dest = path.join(targetDir, file);
    try {
      if (fs.existsSync(dest)) {
        const stat = fs.lstatSync(dest);
        if (stat.isSymbolicLink()) {
          const existingTarget = fs.readlinkSync(dest);
          if (existingTarget === src) {
            return; // Correct symlink already exists
          } else {
            fs.unlinkSync(dest); // Wrong symlink, remove it
          }
        } else {
          fs.unlinkSync(dest); // Regular file, remove it
        }
      }
      fs.symlinkSync(src, dest);
      console.log(`Symlinked: ${dest} → ${src}`);
    } catch (e) {
      console.error(`Failed to link ${file}:`, e);
    }
  }
});

// === Reload NGINX ===
try {
  console.log("\nValidating NGINX config...");
  execSync("sudo nginx -t", { stdio: "inherit" });

  console.log("Reloading NGINX...");
  execSync("sudo systemctl reload nginx", { stdio: "inherit" });

  console.log("NGINX reloaded successfully!");
} catch (error) {
  console.error("NGINX reload failed. Check the configuration above.");
  process.exit(1);
}