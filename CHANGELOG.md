# Changelog

## 2026-08-24

### Added

- **Host-based routing — works with any reverse proxy.** The wake proxy now
  resolves services from the request's hostname (`<route>.<domain>`, per-service
  `domains` aliases, or a first-label match), so the proxy in front only has to
  forward requests with the Host header intact: NGINX, Caddy, Traefik, a
  Cloudflare Tunnel, anything. No more `/proxy/<route>` path rewrites — though
  the old prefixed form still works, so existing configs don't break. The
  `__wake/status` and `__wake/logs` endpoints are also available at the root of
  each service's hostname.
- **Caddy / caddy-docker-proxy support.** The generator produces a `Caddyfile`
  (for plain Caddy, or caddy-docker-proxy's `CADDY_DOCKER_CADDYFILE_PATH`) and a
  `docker-compose.override.yml` that puts `caddy_N` labels on the docker-wakeup
  container — Compose loads it automatically, so `docker compose up -d --build`
  is all it takes. Run it with `docker compose run --rm caddy-generator` (no
  Node.js on the host) or `npm run caddy`. New optional `caddyUpstream` config
  key (default `host.docker.internal:<proxyPort>`). The bundled
  caddy-docker-proxy example stack runs Caddy with host networking because ufw
  on stock Ubuntu drops bridge-network → host traffic; the README checklist and
  setup script print the exact ufw rule and a self-test for bridge setups.
- **`setup-service.sh`** now asks which reverse proxy you use (NGINX, Caddy, or
  skip), prints tailored next steps — including a ready-to-run Caddy stack at
  `proxy-generator/caddy-stack.yml` if you have no Caddy yet — and offers to
  enable + start the SystemD service.
- **Traefik support** — `npm run traefik` (or the Traefik choice in
  `setup-service.sh`) writes `proxy-generator/traefik-dynamic.yml` for
  Traefik's file provider: one catch-all router per domain plus routers for
  `domains` aliases, hot-reloaded via `providers.file.watch`. New optional
  `traefikUpstream`, `traefikEntrypoint` and `traefikCertResolver` config keys,
  and a ready-to-run stack in `examples/traefik.yml`.
- New per-service `domains` option: extra hostnames that resolve to a service.
- `CONFIGURATION.md` — complete `config.json` reference (every option, defaults,
  hook recipes, TCP services, custom wake pages).

### Security

- `__wake/logs` now only streams while a wake is in progress (or has just
  failed, so startup errors stay diagnosable). Previously it was an
  always-open live tap into any service's logs for anyone who could reach the
  service's URL.
- **`showLogs` now defaults to `false`** — startup-log streaming on the wake
  page is opt-in per service (`"showLogs": true`), so sensitive boot logs
  can't be exposed by accident.
- Dependencies updated to clear all `npm audit` findings (axios, express/qs,
  http-proxy-middleware, form-data, path-to-regexp, …), and the unused
  `docker-compose` npm package was removed entirely.
- New `bindHost` option: bind the HTTP proxy to `127.0.0.1` when the reverse
  proxy runs on the host, so LAN clients can't bypass it and reach backends
  directly.
- `/healthz` only returns commit hashes and the service count to local
  requests; anything arriving through a proxy gets `{ ok: true }`.
- Service route names are validated at startup (letters, digits, dashes).
- The container-conflict recovery now passes the container name via
  `execFile` instead of interpolating it into a shell command.
- The SystemD unit gains `PrivateTmp=true`; the trust model is documented in
  `SECURITY.md`.

### Changed

- **`proxy-generator/` replaces `nginx-generator/`** — one package generates
  both NGINX (`npm run nginx`) and Caddy (`npm run caddy`) configs, with the
  same `# custom-start`/`# custom-end` and `# wakeup:manual` edit preservation.
  Existing confs (hand edits and `.htpasswd` included) are migrated from
  `nginx-generator/confs/` automatically on first run.
- Generated NGINX confs are now host-based pass-throughs (no `/proxy/<route>`
  in `proxy_pass`) and set `X-Forwarded-Host`, aligning app-facing headers with
  the Caddy behavior.
  **When upgrading, restart the wake proxy before (or right after) regenerating
  configs** — the new confs need the new build's host-based routing.

## 2026-08-17

### Added

- **Live startup page** — browsers hitting a sleeping service now instantly get a
  "starting server" page with the service's live `docker compose logs` streaming in,
  an elapsed timer, and a progress bar with a "usually ready in ~Xs" estimate based
  on the service's last 10 wake-ups. The page reloads into the app the moment it's
  ready.
- **Custom wake pages** — point `wakePage` (global or per-service) at your own HTML
  file; `{{route}}` is templated in, and the page can use the new `__wake/status`
  (JSON readiness + ETA) and `__wake/logs` (SSE log stream) endpoints. See
  `examples/custom-wake-page.html`.
- **TCP services** — `"type": "tcp"` + `"listenPort"` adds wake-on-connect for
  non-HTTP services (Minecraft and other game servers): the proxy holds the client's
  connection while the service starts, then pipes bytes through. Active connections
  keep the service marked as in-use.
- **Start/stop hooks** — `startCommand` runs before `docker compose up -d` when
  waking, `stopCommand` runs after `docker compose stop` on idle shutdown, and
  `logsCommand` customizes the startup page's log stream. Services without a
  `composeDir` use the hooks as their entire start/stop, so non-Docker services can
  participate too.
- **Docker deployment** — `docker compose up -d --build` now works out of the box:
  multi-stage image with the compose plugin included, host networking, same-path
  home mount for compose dirs, persisted idle timers, and a `/healthz` healthcheck.
- **Update notifications** — the proxy checks GitHub daily and logs a banner (also
  visible at `/healthz`) when your copy is behind; disable with
  `"updateCheck": false`.
- `config.json.example` and a tracked `docker-wakeup.service.example` (your real
  service file is now gitignored).
- `showLogs: false` per-service option to keep startup logs private.

### Fixed

- **Proxy crash on WebSocket reconnects** — a websocket connecting to a sleeping
  service (Portainer/Dozzle/Jellyfin tabs left open) killed the whole proxy about
  60 seconds later.
- **Idle shutdown races** — a service could be stopped mid-wake because its
  last-access timestamp only updated on a successful proxied response; wakes now
  refresh the timestamp and mid-wake services are never stopped. Already-stopped
  services are also no longer re-issued `docker compose stop` every 5 minutes.
- **Lost request bodies** — POSTs that triggered a wake were retried with an empty
  body after a 60s hang; they now get an immediate `503` + `Retry-After` so clients
  can retry safely. GETs keep the transparent wait-and-retry.
- **Misleading ENOENT errors** — a missing `composeDir` now produces a clear
  "compose directory not found" message instead of `spawn /bin/sh ENOENT`.
- **nginx-generator** — no longer crashes on systems without
  `/etc/nginx/sites-enabled`, errors clearly when `domain` is unset instead of
  falling back to a hardcoded personal domain, respects `proxyPort`, skips TCP
  services, and no longer leaves root-owned files in the repo.
