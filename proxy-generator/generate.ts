// Generates reverse proxy configuration for the HTTP services in config.json.
// The wake proxy routes by hostname, so every output is a plain pass-through —
// no path rewriting anywhere.
//
//   --proxy nginx   confs/<route>.conf per service, symlinked into
//                   /etc/nginx/sites-enabled and NGINX reloaded (when present)
//   --proxy caddy   Caddyfile (plain Caddy `import`s it; caddy-docker-proxy
//                   mounts it via CADDY_DOCKER_CADDYFILE_PATH) and
//                   ../docker-compose.override.yml (caddy-docker-proxy labels
//                   on the docker-wakeup container, auto-loaded by compose)
//   --proxy traefik traefik-dynamic.yml for Traefik's file provider (point
//                   providers.file at it with watch: true)
//
// Usage: npm run nginx | npm run caddy | npm run traefik  [-- /path/to/config.json] [--caddyfile-only]
//    or: docker compose run --rm caddy-generator   (no Node.js on the host)
//
// --caddyfile-only skips docker-compose.override.yml (used by setup-service.sh:
// SystemD/PM2 deployments have no docker-wakeup container to label).
//
// This file is the entry point (`npm run nginx|caddy|traefik`, and
// `npx ts-node generate.ts --proxy ...` from docker-compose.yml); the work
// lives in src/. Every output is written relative to this directory.
import { main } from "./src/cli";

process.exitCode = main(process.argv.slice(2), { generatorDir: __dirname });
