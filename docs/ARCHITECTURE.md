# Architecture

How a request travels through DockerWakeUp, and which part of the code is
responsible for each step. The user-facing documentation is in the
[README](../README.md) and [CONFIGURATION.md](../CONFIGURATION.md).

## The big picture

```
browser ──HTTPS──▶ reverse proxy ──HTTP, Host intact──▶ wake proxy ──▶ service container
                   (NGINX, Caddy,                       (wake-proxy/,   (docker compose up/stop)
                    Traefik, cloudflared)                port 8080)
                          ▲
                          │ generated once from config.json
                     proxy-generator/
```

Two independent packages:

- **`wake-proxy/`** is the long-running service. It proxies HTTP (and raw TCP)
  to the configured services, starts a service when a request arrives while it
  is down, serves the "starting up" page meanwhile, and stops services that
  have been idle for too long.
- **`proxy-generator/`** is a one-shot CLI that turns `config.json` into
  reverse proxy configuration (NGINX vhosts, a Caddyfile plus caddy-docker-proxy
  labels, or a Traefik file-provider config). It never runs at request time.

`config.json` is the single source of truth for both.

## The wake proxy (`wake-proxy/src`)

| Module             | Responsibility                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `wake-proxy.ts`    | Entry point (`node dist/wake-proxy.js`): load the config, start the server, log unhandled rejections instead of crashing            |
| `config.ts`        | Config types, `loadConfig`, and `indexServices` (validation: route names, targets, TCP listen ports; invalid entries are skipped)   |
| `server.ts`        | Process wiring: HTTP listener, one TCP listener per TCP service, the idle checker and the update checker; `close()` for tests        |
| `app.ts`           | The Express app: `/healthz`, the wake endpoints, one proxy per HTTP service, and the WebSocket `upgrade` handler                     |
| `routing.ts`       | Hostname → route resolution (`<route>.<domain>`, `domains` aliases, first-label fallback) and the `/proxy/<route>` prefix           |
| `proxy.ts`         | The http-proxy-middleware instance per service, and `handleProxyError`: what happens when the backend does not answer                |
| `wakeEndpoints.ts` | `__wake/status` (JSON readiness poll) and `__wake/logs` (Server-Sent Events)                                                          |
| `wakePage.ts`      | The built-in "starting up" page (HTML + inline script) and custom page loading                                                       |
| `wakeManager.ts`   | The wake state machine, `docker compose up -d` (with container-conflict recovery), hooks, readiness probes, startup-log streaming     |
| `idleShutdown.ts`  | The periodic idle check, `docker compose stop` and the `stopCommand` hook                                                            |
| `lastAccess.ts`    | State on disk: last-access timestamps (write-throttled) and the wake-duration history behind the "usually ready in ~Xs" estimate     |
| `tcpProxy.ts`      | Wake-on-connect for `"type": "tcp"` services                                                                                         |
| `updateChecker.ts` | The daily comparison of the local commit with GitHub                                                                                 |
| `shell.ts`         | Promise wrappers around `child_process` (`runShell` for command lines, `runFile` for argument lists)                                 |
| `util.ts`          | `errorMessage`, `sleep`                                                                                                              |

### An HTTP request, step by step

1. The reverse proxy forwards the request with the `Host` header intact (or
   `X-Forwarded-Host`, which wins). Nothing DockerWakeUp-specific is needed
   in front of the wake proxy.
2. `app.ts` matches, in order: `/healthz` (answered locally unless the
   hostname belongs to a service), the wake endpoints (`/proxy/<route>/__wake/…`
   and `/__wake/…`), the `/proxy/<route>` prefix, and finally the hostname
   via `routing.ts`. Anything unmatched is a 404.
3. The service's proxy (`proxy.ts`) forwards the request to `target`,
   preserving `X-Forwarded-Host`/`-Proto`. A 2xx/3xx answer counts as
   activity and refreshes the service's last-access timestamp.
4. When the backend does not answer, `handleProxyError` runs:
   - `triggerWake` is called (deduplicated: a wake already in progress, or a
     failure less than 15 seconds old, is not repeated);
   - a browser navigation (`GET` with `Accept: text/html`) immediately gets
     the wake page with status 503;
   - a non-idempotent request (`POST`, …) gets an immediate 503 with
     `Retry-After: 15`, because its body was consumed by the failed attempt
     and cannot be replayed;
   - a safe request (`GET`/`HEAD` from an API client) is held for up to 60
     seconds until the service answers, then replayed once.
5. The wake page polls `__wake/status` every two seconds, streams
   `__wake/logs` while the service starts (only if the service opted in with
   `showLogs`), shows a progress estimate based on previous wakes, and reloads
   itself once `ready` is true.

WebSocket upgrades never pass through Express. `server.ts` hands them to
`app.handleUpgrade`, which resolves the route the same way (prefix, then
hostname) and passes the socket to exactly one service proxy. A sleeping
backend makes the handshake fail, which triggers the wake and closes the
socket so the client's reconnect logic retries.

### The wake state machine (`wakeManager.ts`)

```
idle ──triggerWake──▶ starting ──ready──▶ ready
                          │
                          └──error/timeout──▶ failed ──(15 s later, next request)──▶ starting
```

A wake runs the `startCommand` hook (if any), then `docker compose up -d` in
`composeDir` (if any), then polls the target — HTTP for HTTP services, a TCP
connect for TCP services — until it answers or two minutes pass. Services
without a `composeDir` use the hook as their entire start. On success the
duration is recorded (the median of the last ten is the page's estimate) and
the last-access timestamp is refreshed so the idle checker does not undo the
wake.

### Idle shutdown (`idleShutdown.ts`)

Every five minutes, every service that is not exempt (`autoOff: false`) and
not mid-wake is compared against `idleThreshold`. Idle services get
`docker compose stop` followed by the `stopCommand` hook (or only the hook
without a `composeDir`). Without a positive `idleThreshold` the checker is
disabled. Timestamps live on disk so they survive restarts; writes are
throttled to one per ten seconds per service because busy services produce
many successful responses per second.

### TCP services (`tcpProxy.ts`)

A `"type": "tcp"` service gets its own listener on `listenPort`. A connection
while the backend port is closed triggers the wake and is held for up to 90
seconds until the port opens, then bytes are piped both ways. Active sessions
refresh the idle timestamp once a minute.

## The generator (`proxy-generator/src`)

| Module        | Responsibility                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`      | Argument parsing and dispatch; `main` returns the exit code (`generate.ts` is the thin entry point used by the npm scripts)       |
| `config.ts`   | Loading and validating `config.json` for generation; the hostnames each service answers to                                       |
| `context.ts`  | Every side effect (output directory, environment, command runner, root check) goes through one context so tests can replace it   |
| `markers.ts`  | The `# custom-start` / `# custom-end` regions that survive regeneration and the `# wakeup:manual` opt-out                          |
| `nginx.ts`    | One vhost per service, symlinks into `sites-enabled`, `nginx -t` and reload                                                       |
| `caddy.ts`    | The Caddyfile and the `docker-compose.override.yml` with caddy-docker-proxy labels                                                |
| `traefik.ts`  | The file-provider configuration with a catch-all router plus routers for `domains` aliases                                        |

Rendering is separated from writing: each backend has pure `render…`
functions that produce file contents, and a `generate…` function that reads
what exists, preserves custom regions, writes, and (for NGINX) installs.

## Deployments

The same build runs in three ways, all documented in the README:

- **Docker**: the image built from `Dockerfile` with `config.json`, the host's
  Docker socket and the compose directories mounted (`docker-compose.yml`).
- **SystemD**: `setup-service.sh` writes a unit that runs `node dist/wake-proxy.js`
  from `wake-proxy/`.
- **PM2**: `setup-service.sh` writes `ecosystem.config.js`.

In every case the config file is `config.json` in the repository root
(override with `WAKEUP_CONFIG`) and the state directory is `wake-proxy/tmp`
(override with `WAKEUP_STATE_DIR`).
