# Changelog

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
