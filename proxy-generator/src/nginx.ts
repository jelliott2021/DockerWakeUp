// NGINX output: confs/<route>.conf per HTTP service, symlinked into the
// sites-enabled directory and — for the standard /etc/nginx/sites-enabled —
// followed by `nginx -t` and a reload.
import fs from "fs";
import path from "path";
import { hostsFor, type GeneratorSettings } from "./config";
import { resolveContext, type GeneratorContext } from "./context";
import { CUSTOM_END, CUSTOM_START, MANUAL_MARKER, extractCustomLines } from "./markers";

/** Where the symlinks go unless NGINX_SITES_DIR says otherwise. */
export const STANDARD_SITES_DIR = "/etc/nginx/sites-enabled";

/** Single-quotes `s` for /bin/sh, escaping any single quotes it contains. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * One vhost that hands every request for `serverNames` to the wake proxy on
 * `proxyPort`, with `customLines` placed between the custom markers.
 * Returns the complete file content (trailing newline included).
 */
export function renderNginxConf(
  serverNames: string[],
  proxyPort: number,
  customLines: string[],
): string {
  const customBlock = customLines.length > 0 ? customLines.join("\n") + "\n" : "";
  const nginxConf = `
server {
    listen 80;
    server_name ${serverNames.join(" ")};

    location / {
        ${CUSTOM_START} (lines between these markers survive regeneration)
${customBlock}        ${CUSTOM_END}

        # The wake proxy routes by hostname — pass the request through untouched
        proxy_pass http://127.0.0.1:${proxyPort};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # https on purpose: TLS is terminated in front of this vhost (443
        # server block or a tunnel), and apps should generate https URLs
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        # WebSocket support: pass the upgrade handshake through to the wake proxy
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_read_timeout 3600s;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}`.trim();
  return nginxConf + "\n";
}

/** The `message` of an Error-like value, else the value itself (what the write failure message shows). */
function errorDetail(e: unknown): unknown {
  return (e as { message?: unknown } | null | undefined)?.message ?? e;
}

/**
 * Writes confs/<route>.conf for every HTTP service under `ctx.generatorDir`,
 * symlinks the confs into the sites directory and reloads NGINX. Returns the
 * exit code: 1 when `nginx -t` or the reload fails, 0 otherwise.
 */
export function generateNginx(settings: GeneratorSettings, context: GeneratorContext): number {
  const { generatorDir, env, runCommand, isRoot } = resolveContext(context);
  const { domain, proxyPort, services } = settings;
  const outputDir = path.join(generatorDir, "./confs");
  // NGINX_SITES_DIR overrides the symlink target for tests or non-standard
  // layouts; the nginx -t / reload step only runs for the standard location.
  const targetDir = env.NGINX_SITES_DIR || STANDARD_SITES_DIR;
  const isStandardTarget = !env.NGINX_SITES_DIR;

  // Privileged operations use sudo explicitly (and only when the target isn't
  // writable) so generated conf files stay owned by the user, not root
  const targetWritable = (() => {
    try {
      fs.accessSync(targetDir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  const sudo = isRoot || targetWritable ? "" : "sudo ";

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // One-time migration from the pre-merge layout: carry existing confs (and
  // their custom-marker edits / .htpasswd files) over from nginx-generator/
  const legacyDir = path.join(generatorDir, "../nginx-generator/confs");
  const haveConfs = fs
    .readdirSync(outputDir)
    .some((f) => f.endsWith(".conf") && f !== "example.conf");
  if (!haveConfs && fs.existsSync(legacyDir)) {
    for (const file of fs.readdirSync(legacyDir)) {
      if (file === "example.conf") continue;
      fs.copyFileSync(path.join(legacyDir, file), path.join(outputDir, file));
      console.log(`Migrated from nginx-generator/confs: ${file}`);
    }
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
            runCommand(`${sudo}rm -- ${shellQuote(dest)}`);
            console.log(`Removed broken symlink: ${dest}`);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  for (const svc of services) {
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

    try {
      fs.writeFileSync(outputPath, renderNginxConf(hostsFor(svc, domain), proxyPort, customLines));
      console.log(`Generated: ${outputPath}`);
    } catch (e) {
      console.error(
        `Failed to write ${outputPath}: ${errorDetail(e)}\n` +
          `  (If it's owned by root from an older version, fix with: sudo chown $USER ${outputPath})`,
      );
    }
  }

  if (!sitesEnabledExists) return 0;

  // Safely create symlinks in /etc/nginx/sites-enabled
  for (const file of fs.readdirSync(outputDir)) {
    if (file === "example.conf") continue; // documentation only
    if (!file.endsWith(".conf")) continue;
    const src = path.join(outputDir, file);
    const dest = path.join(targetDir, file);
    try {
      if (fs.existsSync(dest)) {
        const stat = fs.lstatSync(dest);
        if (stat.isSymbolicLink() && fs.readlinkSync(dest) === src) {
          continue; // Correct symlink already exists
        }
        runCommand(`${sudo}rm -- ${shellQuote(dest)}`); // Wrong symlink or regular file
      }
      runCommand(`${sudo}ln -s -- ${shellQuote(src)} ${shellQuote(dest)}`);
      console.log(`Symlinked: ${dest} → ${src}`);
    } catch (e) {
      console.error(`Failed to link ${file}:`, e);
    }
  }

  if (!isStandardTarget) {
    console.log(`\nSymlinked into ${targetDir} (custom NGINX_SITES_DIR) — reload NGINX yourself.`);
    return 0;
  }
  try {
    console.log("\nValidating NGINX config...");
    runCommand(`${sudo}nginx -t`, { stdio: "inherit" });
    console.log("Reloading NGINX...");
    runCommand(`${sudo}systemctl reload nginx`, { stdio: "inherit" });
    console.log("NGINX reloaded successfully!");
  } catch {
    console.error("NGINX reload failed. Check the configuration above.");
    return 1;
  }
  return 0;
}
