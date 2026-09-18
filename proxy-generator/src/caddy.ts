// Caddy output: a Caddyfile with one site block per HTTP service (plain Caddy
// `import`s it; caddy-docker-proxy mounts it via CADDY_DOCKER_CADDYFILE_PATH)
// and ../docker-compose.override.yml with caddy-docker-proxy labels on the
// docker-wakeup container, which compose loads automatically.
import fs from "fs";
import path from "path";
import { hostsFor, type GeneratorSettings } from "./config";
import { type GeneratorContext } from "./context";
import {
  CUSTOM_END,
  CUSTOM_START,
  GENERATED_HEADER,
  MANUAL_MARKER,
  extractCaddyfileCustomLines,
  extractCustomLines,
} from "./markers";

/** One Caddyfile site block: its address line and the lines carried over from the previous file. */
export interface CaddySite {
  /** The hostnames, comma separated (e.g. "photos.example.com, pics.example.net"). */
  address: string;
  customLines: string[];
}

/** YAML double-quoted scalars accept JSON string escaping. */
const yamlStr = (s: string): string => JSON.stringify(s);

/** The complete Caddyfile: a header naming `configName` and the import path, then one block per site. */
export function renderCaddyfile(opts: {
  configName: string;
  caddyfilePath: string;
  upstream: string;
  sites: CaddySite[];
}): string {
  const blocks = opts.sites.map(({ address, customLines }) => {
    const customBlock = customLines.length > 0 ? customLines.join("\n") + "\n" : "";
    return `
${address} {
\t${CUSTOM_START} (lines between these markers survive regeneration)
${customBlock}\t${CUSTOM_END}

\t# The wake proxy routes by hostname; Caddy adds X-Forwarded-For/-Proto/-Host
\t# and passes WebSockets and SSE through as-is.
\treverse_proxy ${opts.upstream}
}`.trimStart();
  });

  return (
    `${GENERATED_HEADER} from ${opts.configName} — re-running the\n` +
    `# generator overwrites this file except for the custom-start/custom-end regions.\n` +
    `# Add a comment line saying wakeup:manual to take the file out of the generator's hands.\n` +
    `#\n` +
    `# Plain Caddy:          import ${opts.caddyfilePath}\n` +
    `# caddy-docker-proxy:   mount this file and set CADDY_DOCKER_CADDYFILE_PATH to it\n` +
    `\n` +
    blocks.join("\n\n") +
    "\n"
  );
}

/**
 * The caddy-docker-proxy label lines (indented for the compose file), one
 * caddy_<i> / caddy_<i>.reverse_proxy pair per entry of `hostLists`, or an
 * empty mapping when there are none.
 */
export function renderCaddyLabels(hostLists: string[], upstream: string): string {
  // caddy-docker-proxy only accepts numeric suffixes (caddy_0, caddy_1, ...),
  // so the index follows the order of services in config.json
  const labelLines = hostLists.map((hosts, i) =>
    [
      `      caddy_${i}: ${yamlStr(hosts)}`,
      `      caddy_${i}.reverse_proxy: ${yamlStr(upstream)}`,
    ].join("\n"),
  );
  return labelLines.length > 0 ? labelLines.join("\n") + "\n" : "      {}\n";
}

/** The complete docker-compose.override.yml with the labels for `hostLists` and the preserved `customLines`. */
export function renderComposeOverride(opts: {
  configName: string;
  upstream: string;
  hostLists: string[];
  customLines: string[];
}): string {
  const customBlock = opts.customLines.length > 0 ? opts.customLines.join("\n") + "\n" : "";
  return (
    `${GENERATED_HEADER} from ${opts.configName} — re-running the\n` +
    `# generator overwrites this file except for the custom-start/custom-end region.\n` +
    `# Add a comment line saying wakeup:manual to take the file out of the generator's hands.\n` +
    `#\n` +
    `# Adds caddy-docker-proxy labels to the docker-wakeup container. Docker Compose\n` +
    `# loads this override automatically next to docker-compose.yml, so a plain\n` +
    `#\n` +
    `#   docker compose up -d --build\n` +
    `#\n` +
    `# includes the labels. The labels point Caddy at ${opts.upstream}; the Caddy\n` +
    `# container must be able to reach the wake proxy on the host (see\n` +
    `# examples/caddy-docker-proxy.yml). Not using Caddy? Just delete this file.\n` +
    `services:\n` +
    `  docker-wakeup:\n` +
    `    labels:\n` +
    `      ${CUSTOM_START} (lines between these markers survive regeneration)\n` +
    customBlock +
    `      ${CUSTOM_END}\n` +
    renderCaddyLabels(opts.hostLists, opts.upstream)
  );
}

/**
 * Writes `<generatorDir>/Caddyfile` and `<generatorDir>/../docker-compose.override.yml`
 * (the latter skipped with `caddyfileOnly`), honouring the manual marker and
 * the custom regions of the existing files, and never overwriting an override
 * file that this generator did not write.
 */
export function generateCaddy(
  settings: GeneratorSettings,
  ctx: GeneratorContext,
  caddyfileOnly = false,
): void {
  const { config, configPath, domain, proxyPort, services } = settings;
  const configName = path.basename(configPath);
  const caddyfilePath = path.join(ctx.generatorDir, "Caddyfile");
  const composePath = path.join(ctx.generatorDir, "../docker-compose.override.yml");
  const upstream: string = config.caddyUpstream || `host.docker.internal:${proxyPort}`;

  // ----- Caddyfile -----
  let existingCaddyfile = "";
  if (fs.existsSync(caddyfilePath)) existingCaddyfile = fs.readFileSync(caddyfilePath, "utf8");

  if (existingCaddyfile.includes(MANUAL_MARKER)) {
    console.log(`Kept as-is (${MANUAL_MARKER}): ${caddyfilePath}`);
  } else {
    const customBySite = extractCaddyfileCustomLines(existingCaddyfile);
    const sites = services.map((svc): CaddySite => {
      const address = hostsFor(svc, domain).join(", ");
      const customLines = customBySite.get(address) ?? [];
      if (customLines.length > 0) {
        console.log(`Preserving ${customLines.length} custom line(s) for ${address}`);
      }
      return { address, customLines };
    });

    fs.writeFileSync(
      caddyfilePath,
      renderCaddyfile({ configName, caddyfilePath, upstream, sites }),
    );
    console.log(`Generated: ${caddyfilePath} (${sites.length} site block(s))`);
  }

  // ----- docker-compose override with caddy-docker-proxy labels -----
  if (caddyfileOnly) {
    console.log("Skipped docker-compose.override.yml (--caddyfile-only)");
  } else {
    const hostLists = services.map((svc) => hostsFor(svc, domain).join(" "));

    let existingCompose = "";
    if (fs.existsSync(composePath)) existingCompose = fs.readFileSync(composePath, "utf8");

    if (existingCompose.includes(MANUAL_MARKER)) {
      console.log(`Kept as-is (${MANUAL_MARKER}): ${composePath}`);
    } else if (existingCompose.length > 0 && !existingCompose.startsWith(GENERATED_HEADER)) {
      // The user has their own override (e.g. different volume mounts) — never
      // clobber it. Show what to merge instead.
      console.warn(
        `\n${composePath} exists and was not written by this generator — left untouched.\n` +
          `Add these labels to its docker-wakeup service yourself:\n\n` +
          `services:\n  docker-wakeup:\n    labels:\n${renderCaddyLabels(hostLists, upstream)}`,
      );
    } else {
      const customLines = extractCustomLines(existingCompose);
      if (customLines.length > 0) {
        console.log(
          `Preserving ${customLines.length} custom label line(s) in ${path.basename(composePath)}`,
        );
      }

      fs.writeFileSync(
        composePath,
        renderComposeOverride({ configName, upstream, hostLists, customLines }),
      );
      console.log(`Generated: ${composePath} (${hostLists.length} site(s))`);
    }
  }

  console.log(
    `\nUpstream for Caddy: ${upstream}` +
      (config.caddyUpstream ? "" : ` (default — set "caddyUpstream" in config.json to change)`),
  );
}
