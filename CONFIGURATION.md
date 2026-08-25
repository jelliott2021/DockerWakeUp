# Configuration Reference — `config.json`

Everything DockerWakeUp does is driven by one file: `config.json` in the
project root (start from `config.json.example`). This is the complete
reference; the [README](README.md) covers getting started.

**Applying changes:** restart the wake proxy after editing —
`sudo systemctl restart docker-wakeup` (SystemD) or
`docker compose up -d --build` (Docker) — and re-run the reverse proxy
generator when you added/removed services or changed hostnames
(`./setup-service.sh` → option 4). Check `jq . config.json` if you're unsure
the JSON is valid; `curl localhost:8080/healthz` shows how many services were
loaded (full detail is only returned to local requests).

## Full example

```json
{
  "proxyPort": 8080,
  "idleThreshold": 259200,
  "domain": "example.com",
  "wakePage": "examples/custom-wake-page.html",
  "updateCheck": true,
  "caddyUpstream": "host.docker.internal:8080",
  "services": [
    {
      "route": "jellyfin",
      "target": "http://localhost:8096",
      "composeDir": "/home/youruser/jellyfin"
    },
    {
      "route": "portainer",
      "target": "http://localhost:9000",
      "composeDir": "/home/youruser/portainer",
      "autoOff": false
    },
    {
      "route": "photos",
      "target": "http://localhost:2283",
      "composeDir": "/home/youruser/immich-app",
      "domains": ["photos.example.org"],
      "wakePage": "examples/custom-wake-page.html",
      "showLogs": false
    },
    {
      "route": "minecraft",
      "type": "tcp",
      "listenPort": 25566,
      "target": "localhost:25565",
      "composeDir": "/home/youruser/minecraft"
    },
    {
      "route": "myapp",
      "target": "http://localhost:3000",
      "startCommand": "nohup node server.js >> app.log 2>&1 &",
      "stopCommand": "pkill -f 'node server.js'",
      "logsCommand": "tail -n 50 -f app.log"
    }
  ]
}
```

## Global options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `proxyPort` | number | `8080` | Port the wake proxy listens on. Your reverse proxy forwards here. |
| `bindHost` | string | `0.0.0.0` | Address the HTTP proxy binds to. Set `"127.0.0.1"` when your reverse proxy runs on the host (NGINX, host-network Caddy/Traefik, cloudflared) so nothing else on the network can bypass it and reach your backends directly. Leave the default only when a bridge-network proxy container must reach the wake proxy. TCP services always bind all interfaces. |
| `domain` | string | — | Base domain: each service answers on `<route>.<domain>`. Required by the config generators; the wake proxy itself can also match any hostname whose first label equals a route name, so host routing works even without it. |
| `idleThreshold` | number (seconds) | *unset = idle shutdown disabled* | Stop a service after this much time without a successful request. The example's `259200` is 3 days. The checker runs every 5 minutes, never stops a service mid-wake, and starts each service's idle clock the first time it sees it. |
| `wakePage` | string (path) | built-in page | Custom "starting up" HTML page for all services, relative to the project root (see [Custom wake pages](#custom-wake-pages)). |
| `updateCheck` | boolean | `true` | Daily check against GitHub; logs a banner (and reports on `/healthz`) when your copy is behind. Set `false` to disable. |
| `caddyUpstream` | string | `host.docker.internal:<proxyPort>` | Caddy generator only: the address Caddy uses to reach the wake proxy. Use `127.0.0.1:<proxyPort>` when Caddy runs directly on the host (or with `network_mode: host`). |
| `traefikUpstream` | string | `host.docker.internal:<proxyPort>` | Traefik generator only: the address the Traefik router points at. Use `127.0.0.1:<proxyPort>` for a host-network Traefik. |
| `traefikEntrypoint` | string | `"websecure"` | Traefik generator only: the entrypoint name the routers attach to. |
| `traefikCertResolver` | string | — | Traefik generator only: when set, each router gets `tls: { certResolver: … }`. When unset no `tls` key is emitted — enable TLS at the entrypoint instead (the example stack does: `--entrypoints.websecure.http.tls.certresolver=…`). |

## Per-service options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `route` | string | *required* | The service's name and subdomain: `jellyfin` → `jellyfin.<domain>`. Letters, digits and dashes only (validated at startup). Also used for the `/proxy/<route>/…` path form and the idle-timer files. |
| `target` | string | *required* | Where the service listens once awake — `http://localhost:8096` for HTTP, `host:port` for `"type": "tcp"`. Must be reachable from the wake proxy (publish container ports on the host, `127.0.0.1:` bindings are fine). |
| `composeDir` | string (path) | — | Directory containing the service's `docker-compose.yml`. Waking runs `docker compose up -d` here; idle shutdown runs `docker compose stop`. Optional when `startCommand` fully replaces Docker. Docker deployments of DockerWakeUp must be able to see this path inside the container at the same location (the default home-directory mount usually covers it). |
| `domains` | string[] | `[]` | Extra hostnames that also resolve to this service, e.g. `["jf.example.org"]`. Add them to your reverse proxy / DNS too — the generators include them automatically. |
| `type` | `"http"` \| `"tcp"` | `"http"` | `"tcp"` proxies raw bytes with wake-on-connect (game servers, databases). TCP services bypass the HTTP reverse proxy entirely — the generators skip them. |
| `listenPort` | number | — | **TCP only, required**: port the wake proxy listens on for clients. Point port forwarding/DNS here; must differ from the service's own port in `target`. |
| `autoOff` | boolean | `true` | Set `false` to exempt this service from idle shutdown (it still wakes on demand, it just never gets stopped). |
| `wakePage` | string (path) | global `wakePage` | Per-service startup page, overrides the global one. |
| `showLogs` | boolean | `false` | **Opt-in**: set `true` to stream the container's logs on the startup page while it wakes. Off by default because anyone who can reach the URL can read the stream, and boot logs often contain config details. (Streaming is only ever possible during a wake — running and sleeping services never stream logs.) |
| `startCommand` | string | — | Hook run **before** `docker compose up -d` when waking. Without a `composeDir` it *is* the start command (non-Docker services). |
| `stopCommand` | string | — | Hook run **after** `docker compose stop` on idle shutdown. Without a `composeDir` it *is* the stop command. |
| `logsCommand` | string | — | Custom command for the startup page's log stream (default: `docker compose logs -f`). |

## Hooks (`startCommand`, `stopCommand`, `logsCommand`)

Hooks run via `/bin/sh -c` with `composeDir` as the working directory, so any
shell command line works — a script, a binary, a pipeline, an `&&` chain. They
run as the wake proxy's own user (no sudo). With the Docker deployment they
execute inside the (Alpine) container: `sh` is available but bash/python are
not, and referenced files must be visible inside the container's mounts.

Some things hooks can do:

```json
"stopCommand": "tar czf backups/world-$(date +%F).tar.gz world/"
```
Back up a game world after idle shutdown stops the server.

```json
"startCommand": "mount | grep -q /mnt/photos || mount /mnt/photos"
```
Make sure a network share is mounted before the containers come up.

```json
"startCommand": "curl -s -X POST -H 'Content-Type: application/json' -d '{\"content\": \"Jellyfin is waking up\"}' https://discord.com/api/webhooks/..."
```
Notify a Discord webhook on wake (same idea works for `stopCommand`).

```json
"startCommand": "nohup node server.js >> app.log 2>&1 &",
"stopCommand": "pkill -f 'node server.js'",
"logsCommand": "tail -n 50 -f app.log"
```
Run a service that isn't managed by Docker at all — with no `composeDir`, the
hooks *are* the start/stop, and the wake page tails the app's own log file.

## TCP services

Services that don't speak HTTP can't go through the HTTP proxy — set
`"type": "tcp"` and a `listenPort`. The wake proxy listens on `listenPort` and
forwards raw bytes to `target`. When a client connects while the service is
stopped, the proxy starts it, holds the connection until the target port opens
(up to 90s), then connects through — a Minecraft client's first join attempt
wakes the server (clients that time out simply retry). Active connections keep
the service marked as in-use for idle shutdown.

## Custom wake pages

When a browser hits a sleeping service it immediately gets a "starting up"
page: spinner, elapsed time, live `docker compose logs -f`, a "usually ready in
~Xs" estimate once the service has woken before, and an automatic reload when
the service answers. Non-browser GETs wait and are retried transparently;
non-idempotent requests (POST etc.) get an immediate `503` + `Retry-After`.

To bring your own page, point `wakePage` (global or per-service) at an HTML
file — `{{route}}` inside it is replaced with the route name. Two same-origin
endpoints are available (see
[examples/custom-wake-page.html](examples/custom-wake-page.html)); they exist
both at the root of each service's hostname and under `/proxy/<route>/`:

| Endpoint | Description |
|----------|-------------|
| `GET __wake/status` | JSON: `{ state, ready, startedAt, error, expectedMs, elapsedMs }` — `state` is `idle`/`starting`/`ready`/`failed`; reload when `ready` is `true`; `expectedMs` is the typical wake duration (null until the first wake) |
| `GET __wake/logs` | Server-Sent Events stream of `docker compose logs -f` (each event one JSON-encoded log line). Only streams while a wake is in progress or has just failed — for running or sleeping services it sends a single notice instead |

Docker deployments: keep custom pages in `examples/` (mounted into the
container) or use an absolute path under your home directory.

## State on disk

The wake proxy keeps small marker files in `wake-proxy/tmp/` (a named volume
for Docker deployments): `last_access_<route>` for the idle timers and
`wake_history_<route>` for the startup-time estimates. Deleting them is safe —
timers restart and estimates rebuild.
