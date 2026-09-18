// Traefik output: traefik-dynamic.yml for Traefik's file provider (point
// providers.file at it with watch: true) — a catch-all router for
// *.<domain> plus one router per service with extra `domains`.
import fs from "fs";
import path from "path";
import { type GeneratorSettings, type ServiceConfig } from "./config";
import { type GeneratorContext } from "./context";
import { GENERATED_HEADER, MANUAL_MARKER } from "./markers";

const BT = "`"; // backtick, used inside Traefik rule expressions

/**
 * The router entries of the `http.routers` map: a catch-all for
 * `^.+\.<domain>$` first, then one `docker-wakeup-<route>-aliases` router per
 * service that lists extra `domains` (aliases don't match the regexp). Each
 * router carries a `tls` block naming `certResolver` when one is set, else a
 * comment explaining that TLS comes from the entrypoint.
 */
export function renderTraefikRouters(opts: {
  domain: string;
  services: ServiceConfig[];
  entrypoint: string;
  certResolver?: string;
}): string[] {
  const tlsBlock = opts.certResolver
    ? `      tls: { certResolver: ${JSON.stringify(opts.certResolver)} }\n`
    : `      # TLS comes from the entrypoint (examples/traefik.yml enables it there);\n` +
      `      # or set "traefikCertResolver" in config.json to add one per router\n`;

  // One catch-all router covers every <route>.<domain>; services with extra
  // `domains` get their own router, since aliases don't match the regexp
  const escapedDomain = opts.domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const routers: string[] = [];
  routers.push(
    `    docker-wakeup:\n` +
      `      rule: HostRegexp(${BT}^.+\\.${escapedDomain}$${BT})\n` +
      `      entryPoints: [${JSON.stringify(opts.entrypoint)}]\n` +
      tlsBlock +
      `      service: docker-wakeup\n`,
  );
  for (const svc of opts.services) {
    const aliases = svc.domains ?? [];
    if (aliases.length === 0) continue;
    const rule = aliases.map((d) => `Host(${BT}${d}${BT})`).join(" || ");
    routers.push(
      `    docker-wakeup-${svc.route}-aliases:\n` +
        `      rule: ${rule}\n` +
        `      entryPoints: [${JSON.stringify(opts.entrypoint)}]\n` +
        tlsBlock +
        `      service: docker-wakeup\n`,
    );
  }
  return routers;
}

/** The complete dynamic configuration file: header, the `routers` entries and the single docker-wakeup service. */
export function renderTraefikConfig(opts: {
  configName: string;
  routers: string[];
  upstream: string;
}): string {
  return (
    `${GENERATED_HEADER} from ${opts.configName} — re-running the\n` +
    `# generator overwrites this file. Add a comment line saying wakeup:manual to\n` +
    `# take it out of the generator's hands.\n` +
    `#\n` +
    `# Dynamic configuration for Traefik's file provider. Point Traefik at it:\n` +
    `#   --providers.file.filename=/etc/traefik/docker-wakeup.yml\n` +
    `#   --providers.file.watch=true\n` +
    `# (mount this file there — see examples/traefik.yml for a complete stack.)\n` +
    `# The wake proxy routes by hostname, so this file only changes when the\n` +
    `# domain or per-service domains aliases change.\n` +
    `http:\n` +
    `  routers:\n` +
    opts.routers.join("") +
    `  services:\n` +
    `    docker-wakeup:\n` +
    `      loadBalancer:\n` +
    `        servers:\n` +
    `          - url: ${JSON.stringify(`http://${opts.upstream}`)}\n`
  );
}

/**
 * Writes `<generatorDir>/traefik-dynamic.yml` unless the existing file
 * carries the manual marker.
 */
export function generateTraefik(settings: GeneratorSettings, ctx: GeneratorContext): void {
  const { config, configPath, domain, proxyPort, services } = settings;
  const outPath = path.join(ctx.generatorDir, "traefik-dynamic.yml");
  const upstream: string = config.traefikUpstream || `host.docker.internal:${proxyPort}`;
  const entrypoint: string = config.traefikEntrypoint || "websecure";

  if (fs.existsSync(outPath) && fs.readFileSync(outPath, "utf8").includes(MANUAL_MARKER)) {
    console.log(`Kept as-is (${MANUAL_MARKER}): ${outPath}`);
    return;
  }

  const routers = renderTraefikRouters({
    domain,
    services,
    entrypoint,
    certResolver: config.traefikCertResolver,
  });
  fs.writeFileSync(
    outPath,
    renderTraefikConfig({ configName: path.basename(configPath), routers, upstream }),
  );
  console.log(
    `Generated: ${outPath} (catch-all *.${domain}` +
      (routers.length > 1 ? ` + ${routers.length - 1} alias router(s)` : "") +
      `)`,
  );
  console.log(
    `\nUpstream for Traefik: http://${upstream}` +
      (config.traefikUpstream ? "" : ` (default — set "traefikUpstream" in config.json to change)`),
  );
}
