# Docker Wake-Up Proxy System

[![CI](https://github.com/jelliott2021/DockerWakeUp/actions/workflows/ci.yml/badge.svg)](https://github.com/jelliott2021/DockerWakeUp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Compatible-blue.svg)](https://www.docker.com/)

## What's New

- **Works with any reverse proxy** — the wake proxy now routes by hostname, so NGINX, Caddy, Traefik, a Cloudflare Tunnel, ... only need to forward requests with the Host header intact (see [Works With Any Reverse Proxy](#works-with-any-reverse-proxy-))
- **Caddy support** — generate a Caddyfile or caddy-docker-proxy labels instead of NGINX configs (see [Caddy / caddy-docker-proxy](#3-caddy-generator-proxy-generator))
- **One generator** — `proxy-generator/` replaces `nginx-generator/` (existing confs and hand edits are migrated automatically)
- **Live startup page** — streams the waking container's logs in the browser and auto-reloads when the service is ready; bring your own page with `wakePage`
- **TCP wake-on-connect** — game servers like Minecraft wake when a player connects
- **Start/stop hooks & non-Docker services** — run your own commands around wake/sleep, or replace Docker Compose entirely
- **Docker deployment** — run DockerWakeUp itself with one `docker compose up -d --build`

Full details in the [CHANGELOG](CHANGELOG.md).

## Features 🚀

- **On-Demand Container Startup**: Automatically starts Docker containers when they receive HTTP requests
- **Intelligent Idle Management**: Monitors container usage and stops idle containers after configurable timeout
- **Automatic Reverse Proxy Configuration**: Generates NGINX site configs, or a Caddyfile / caddy-docker-proxy labels if you prefer Caddy
- **Zero-Downtime Experience**: Seamless proxying with startup loading pages
- **Live Startup Page**: Browsers see a "starting server" page with live `docker compose` logs and a progress estimate that auto-reloads when the service is ready — or bring your own custom HTML page
- **TCP Services**: Wake-on-connect for non-HTTP services like Minecraft and other game servers
- **Start/Stop Hooks**: Run your own commands before a service starts and after it stops — or manage non-Docker services entirely with custom commands
- **Resource Efficient**: Only runs containers when needed, saving CPU and memory
- **Easy Configuration**: Single JSON file configuration for all services
- **Automated Setup**: One-command installation with setup script

## Overview

**Docker Wake Up** is a lightweight tool designed to help users reverse proxy Dockerized applications (like Immich, Nextcloud, Portainer, etc.) to clean subdomains such as `photos.yourdomain.com`.

In addition to proxying, it provides smart container management by:

- **Automatically starting** Docker services when they are accessed.
- **Shutting them down** after a period of inactivity (optional).

This is especially useful for self-hosted environments where you want to conserve resources by running only the services you actually need, while still keeping them easily accessible on demand.

## Table of Contents 📋

- [What's New](#whats-new)
- [Features](#features-)
- [Quick Start](#quick-start-)
- [SSL Setup](#ssl-setup-)
- [Automated Setup Script](#automated-setup-script-️)
- [Manual Installation](#manual-installation-)
- [Architecture](#️-architecture)
- [Works With Any Reverse Proxy](#works-with-any-reverse-proxy-)
- [Configuration](#configuration-️)
- [Components](#components-)
- [Caddy / caddy-docker-proxy](#3-caddy-generator-proxy-generator)
  - [Traefik](#4-traefik-proxy-generator)
- [Service Management](#service-management-️)
- [Project Structure](#-project-structure)
- [Requirements](#requirements-)
- [Development & Testing](#development--testing-)
- [Contributing](#contributing-)
- [License](#license-)
- [Acknowledgments](#acknowledgments-)
- [Support](#support-)

## Quick Start ⚡

Before you start: point DNS at this server (an `A` record for `*.yourdomain.com`
covers every service) and have Docker installed.

**1. Get the code and describe your services**

```bash
git clone https://github.com/jelliott2021/docker-wakeup.git
cd docker-wakeup
cp config.json.example config.json
nano config.json      # your domain + one entry per service (see Configuration below)
```

**2. Run the setup script and pick how to deploy**

```bash
chmod +x setup-service.sh
./setup-service.sh
```

The first menu choice is the deployment — both are first-class, pick whichever
fits your host:

| | **1) Docker container** | **2) SystemD service** |
|---|---|---|
| Needs | Docker only — no Node.js | Node.js 16+ |
| The wake proxy runs as | the `docker-wakeup` container | a systemd unit |
| Update later with | `git pull && docker compose up -d --build` | `git pull` + re-run the script |
| Good when | you run everything in containers anyway | you prefer a host service / use PM2 |

Either way, the script then asks which reverse proxy you use and finishes the
job:

- **NGINX** — site configs are generated, symlinked into `sites-enabled`, and
  NGINX is reloaded (with Docker deployments this works even without Node.js —
  the configs are generated in a throwaway container). HTTPS: do
  [SSL Setup](#ssl-setup-) once.
- **Caddy / caddy-docker-proxy** — it asks whether you already run Caddy and
  prints the short list of steps for exactly your case (or writes a
  ready-to-run Caddy stack if you don't have one). Caddy handles HTTPS itself.
- **Traefik** — writes a file-provider config Traefik hot-reloads, and prints
  the steps for your case (a ready-to-run stack lives in
  [examples/traefik.yml](examples/traefik.yml)).

Docker notes: the container uses host networking (Linux only — not Docker
Desktop) so `localhost` targets just work, and mounts your home directory so
your services' compose directories are visible at the same path — edit the
volumes in [docker-compose.yml](docker-compose.yml) if your stacks live
elsewhere (e.g. `/opt/stacks`). Prefer plain commands over the script?
`docker compose run --rm caddy-generator` (Caddy only) then
`docker compose up -d --build`.

**3. Use it**

Open `https://jellyfin.yourdomain.com`. If the service is stopped you see a
startup page with its live logs; it reloads into the app as soon as it's ready.
Services that nobody uses for `idleThreshold` seconds (3 days by default) are
stopped again automatically — no cron job needed.

**After the initial setup**

| Want to… | Docker deployment | SystemD deployment |
|---|---|---|
| Add or change a service | edit `config.json` → `./setup-service.sh` → option 4, then `docker compose up -d --build` | same, then `sudo systemctl restart docker-wakeup` |
| Update DockerWakeUp | `git pull && docker compose up -d --build` | `git pull` + `./setup-service.sh` (it offers the update) |
| Watch the logs | `docker logs -f docker-wakeup` | `sudo journalctl -u docker-wakeup -f` |
| Check it's alive | `curl localhost:8080/healthz` — also shows whether a newer version exists | same |

## SSL Setup 🔒

> Using Caddy? Skip this section — Caddy obtains and renews certificates by
> itself (see [Caddy / caddy-docker-proxy](#3-caddy-generator-proxy-generator)).

For HTTPS access with NGINX, set up a wildcard SSL certificate to cover all subdomains:

### Quick SSL Setup

```bash
# Install Certbot with DNS plugin (example: Cloudflare)
sudo apt update
sudo apt install certbot python3-certbot-dns-cloudflare

# Create credentials file
sudo mkdir -p /etc/letsencrypt
sudo nano /etc/letsencrypt/cloudflare.ini
# Add: dns_cloudflare_api_token = your_api_token_here
sudo chmod 600 /etc/letsencrypt/cloudflare.ini

# Generate wildcard certificate (run from your project directory)
cd /path/to/docker-wakeup
DOMAIN=$(jq -r '.domain' config.json)
sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d $DOMAIN -d "*.$DOMAIN"

# Reload NGINX to use certificates
sudo systemctl reload nginx
```

### DNS Requirements

Add these DNS records:
```
A    yourdomain.com    YOUR_SERVER_IP
A    *                 YOUR_SERVER_IP
```

**Other DNS Providers:**
- DigitalOcean: `sudo apt install python3-certbot-dns-digitalocean`
- Route53: `sudo apt install python3-certbot-dns-route53`
- Google Cloud: `sudo apt install python3-certbot-dns-google`

The wildcard certificate (`*.yourdomain.com`) covers all current and future subdomains automatically.

## Automated Setup Script 🛠️

```bash
chmod +x setup-service.sh
./setup-service.sh
```

One command for the whole install: it asks how you want to deploy (Docker or
on the host), which reverse proxy you use, generates the config, and starts
everything.

```
1) Docker container + reverse proxy configs (easiest — no Node.js needed)
2) SystemD service + reverse proxy configs (runs on the host via Node.js)
3) PM2 process manager + reverse proxy configs
4) Generate reverse proxy configs only (NGINX, Caddy or Traefik)
5) Build project only (no service setup)
6) Exit
```

- **Docker** — checks `docker compose`, generates the reverse proxy config
  (in a throwaway container when the host has no Node.js), then
  `docker compose up -d --build` and a health check.
- **SystemD/PM2** — builds the wake-proxy, generates configs, installs the
  service and offers to enable + start it (auto-start on boot included).

The reverse proxy question offers NGINX (default), Caddy / caddy-docker-proxy,
Traefik, or skip:

- **NGINX** — configs are generated, symlinked into `sites-enabled`, and NGINX
  is reloaded. Nothing else to do (besides [SSL](#ssl-setup-), once).
- **Caddy** — it asks whether you already have Caddy running and prints the
  short list of remaining steps for exactly your case; with no Caddy yet it
  also writes a ready-to-run caddy-docker-proxy stack to
  `proxy-generator/caddy-stack.yml` (Caddyfile already mounted).
- **Traefik** — same idea: generates `proxy-generator/traefik-dynamic.yml` and
  prints the mount/provider lines for an existing Traefik, or points you at
  the ready-to-run stack in `examples/traefik.yml`.

Re-run the script any time: it detects updates from GitHub, regenerates configs
(your `# custom-start`/`# custom-end` edits survive), and restarts the service.
Day-to-day commands are in [Service Management](#service-management-️).


## Manual Installation 📦

Prefer to do what the setup script does yourself?

1. **Install dependencies and build**
   ```bash
   cd wake-proxy && npm install && npm run build && cd ..
   cd proxy-generator && npm install && cd ..
   ```

2. **Configure**
   ```bash
   cp config.json.example config.json
   nano config.json
   ```

3. **Generate the reverse proxy config**
   ```bash
   cd proxy-generator
   npm run nginx     # NGINX: generates, symlinks into sites-enabled, reloads
   npm run caddy     # or Caddy — see the Caddy section for using the output
   cd ..
   ```
   Using something else? See [Works With Any Reverse Proxy](#works-with-any-reverse-proxy-).

4. **Install the SystemD service**
   ```bash
   sudo cp docker-wakeup.service.example /etc/systemd/system/docker-wakeup.service
   sudo nano /etc/systemd/system/docker-wakeup.service   # fix paths + username
   sudo systemctl daemon-reload
   sudo systemctl enable --now docker-wakeup
   ```

Or skip SystemD entirely and run it with Docker — see [Quick Start](#quick-start-).


## 🏗️ Architecture

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│  NGINX / Caddy  │───▶│  Wake Proxy  │───▶│ Docker Services │
│  (Port 80/443)  │    │  (Port 8080) │    │   (Various)     │
└─────────────────┘    └──────────────┘    └─────────────────┘
         │                       │                    │
         │              ┌────────▼────────┐          │
         │              │ Idle Shutdown   │          │
         │              │ (Integrated)    │          │
         │              └─────────────────┘          │
         │                                           │
         └───────────────── Config.json ─────────────┘
```

The system works in three layers:
1. **The reverse proxy** (NGINX, Caddy, ...) terminates SSL and forwards requests to the wake proxy with the Host header intact
2. **Wake Proxy** manages container lifecycle, proxies requests, and now also monitors/stops unused containers (idle shutdown is integrated)

## Works With Any Reverse Proxy 🔀

The wake proxy routes by **hostname**: a request for `jellyfin.yourdomain.com`
is matched to the service with route `jellyfin` (`<route>.<domain>`, plus any
extra names in the service's `domains` list — and, as a fallback, any hostname
whose first label equals a route name). So the proxy in front needs nothing
DockerWakeUp-specific — no path rewrites, no per-service plumbing. It only has
to:

1. Forward requests to the wake proxy (`http://127.0.0.1:8080` by default)
   with the `Host` header intact (or set `X-Forwarded-Host`, which wins).
2. Ideally set `X-Forwarded-Proto`, so apps generate correct absolute URLs.
3. Pass WebSocket upgrades through. Caddy, Traefik and cloudflared do this on
   their own; NGINX needs `proxy_set_header Upgrade $http_upgrade;` and
   `proxy_set_header Connection $http_connection;` (the generator adds them),
   and nginx-proxy-manager has a "Websockets Support" toggle per proxy host.

The generators below produce ready-made NGINX and Caddy configs, but anything
that can do the two things above works. Two examples that need no generator at
all:

**Cloudflare Tunnel** (`cloudflared`) — one catch-all ingress rule:

```yaml
ingress:
  - hostname: "*.yourdomain.com"
    service: http://localhost:8080
  - service: http_status:404
```

**Traefik** — fully supported by the generator (see
[Traefik](#4-traefik-proxy-generator)): `npm run traefik` writes a
file-provider config that boils down to one catch-all router:

```yaml
http:
  routers:
    docker-wakeup:
      rule: HostRegexp(`^.+\.yourdomain\.com$`)
      entryPoints: [websecure]
      service: docker-wakeup
  services:
    docker-wakeup:
      loadBalancer:
        servers: [{ url: "http://host.docker.internal:8080" }]
```

**Containerised proxies** (Traefik, caddy-docker-proxy, ...) need two things
to reach the wake proxy on the host:

1. A name for the host: `extra_hosts: ["host.docker.internal:host-gateway"]` —
   or run the proxy container with `network_mode: host` and use `127.0.0.1`.
2. The firewall opened — **on a stock Ubuntu with ufw this is not optional**:
   containers on a bridge network can't reach *any* host port; requests time
   out and the proxy answers 502. Allow the wake proxy port from the proxy's
   Docker network (subnet from `docker network inspect <network>`):
   ```bash
   sudo ufw allow from 172.27.0.0/16 to any port 8080 proto tcp
   ```
   Self-test — prints JSON once the container can reach the wake proxy:
   ```bash
   docker run --rm --network <network> --add-host host.docker.internal:host-gateway alpine wget -qO- http://host.docker.internal:8080/healthz
   ```
   A host-networking proxy container avoids the rule entirely — the bundled
   Caddy stack ([examples/caddy-docker-proxy.yml](examples/caddy-docker-proxy.yml))
   does exactly that.

Configs from earlier DockerWakeUp versions keep working — the old
path-prefixed form (`/proxy/<route>/…`) is still routed. `"type": "tcp"`
services are the exception to all of this: they bypass HTTP entirely and use
their own `listenPort`.

## Configuration ⚙️

One JSON file drives everything. The essentials:

```json
{
  "proxyPort": 8080,
  "idleThreshold": 259200,
  "domain": "yourdomain.com",
  "services": [
    {
      "route": "jellyfin",
      "target": "http://localhost:8096",
      "composeDir": "/path/to/jellyfin"
    }
  ]
}
```

Each service gets a `route` (its subdomain), a `target` (where it listens once
awake) and a `composeDir` (where its `docker-compose.yml` lives). Beyond that
there are optional keys for extra hostnames (`domains`), exempting a service
from idle shutdown (`autoOff`), custom start/stop/log commands for hooks or
non-Docker services, custom wake pages, log privacy, and the Caddy upstream —
**the full reference with every option, defaults and recipes is in
[CONFIGURATION.md](CONFIGURATION.md).**

After editing: restart the wake proxy, and re-run the generator if routes or
hostnames changed (see [Service Management](#service-management-️)).

### TCP Services 🎮

Non-HTTP services (Minecraft and other game servers, databases, ...) get
wake-on-connect instead: set `"type": "tcp"` and a `listenPort`, and the wake
proxy holds the first connection while the service starts, then pipes bytes
through. TCP services bypass NGINX/Caddy entirely. Details in
[CONFIGURATION.md](CONFIGURATION.md#tcp-services).

### Startup Page 🕓

Browsers hitting a sleeping service instantly get a startup page with a
spinner, a progress estimate, and an auto-reload when the service is ready —
or bring your own HTML via `wakePage`
([example](examples/custom-wake-page.html)). Live `docker compose` logs on the
page are **opt-in** (`"showLogs": true` per service) since anyone who can reach
the URL could read them, and they only ever stream while the service is
actually waking. Endpoints and details in
[CONFIGURATION.md](CONFIGURATION.md#custom-wake-pages).

## Components 🧩

### 1. Wake Proxy (`wake-proxy/`)

The heart of the system - a TypeScript Express server that:
- Listens for incoming HTTP requests and routes them by hostname (or `/proxy/<route>`)
- Automatically starts containers using Docker Compose
- Proxies requests to the target services
- Implements cooldown logic to prevent rapid restarts
- Tracks access times for idle management

**Key Features:**
- Smart error handling with automatic retry
- WebSocket support for real-time applications
- Conflict resolution for container naming issues
- Health check monitoring before proxying

The code is split into small modules (`config`, `routing`, `app`, `proxy`,
`wakeManager`, `idleShutdown`, `tcpProxy`, …); [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
walks through a request step by step and says which module does what.

### 2. NGINX Generator (`proxy-generator/`)

Generates one NGINX site per service (`npm run nginx`):
- Subdomain-based routing (e.g., `jellyfin.yourdomain.com`) — a plain
  pass-through to the wake proxy, no path rewriting
- Proper proxy headers (`Host`, `X-Forwarded-Host/-For/-Proto`, `X-Real-IP`)
- Symbolic links in `/etc/nginx/sites-enabled/`, then `nginx -t` and reload
- Upgrading from the old `nginx-generator/`? Existing confs (hand edits and
  `.htpasswd` included) are migrated over automatically on the first run

**Keeping hand edits across regenerations:**

Every generated conf contains a marker region inside the `location` block:

```nginx
# custom-start (lines between these markers survive regeneration)
auth_basic "Restricted";
auth_basic_user_file /etc/nginx/.htpasswd;
# custom-end
```

Anything you put between the markers (basic auth, extra headers, rate limits,
...) is carried over the next time the generator runs. To take a conf out of
the generator's hands entirely, add a line containing `# wakeup:manual`
anywhere in the file — it will never be overwritten. See
[proxy-generator/confs/example.conf](proxy-generator/confs/example.conf).

### 3. Caddy Generator (`proxy-generator/`)

Prefer Caddy — or already run [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy)
for your other containers? The generator's Caddy side (`npm run caddy`) reads
the same `config.json` and writes two files:

| File | Use it when |
|------|-------------|
| `docker-compose.override.yml` (repo root) | DockerWakeUp runs with Docker and Caddy is caddy-docker-proxy — a compose override that puts `caddy_N` labels on the `docker-wakeup` container. Docker Compose loads it automatically, so a plain `docker compose up -d --build` includes the labels |
| `proxy-generator/Caddyfile` | DockerWakeUp runs via SystemD/PM2 (hand it to caddy-docker-proxy as its base Caddyfile via `CADDY_DOCKER_CADDYFILE_PATH`), or you run plain Caddy on the host (`import` it) |

Generate them whichever way suits you:

```bash
docker compose run --rm caddy-generator          # no Node.js on the host needed
# or, with Node.js installed:
cd proxy-generator && npm install && npm run caddy && cd ..
# or pick "Caddy" when ./setup-service.sh asks
```

Each HTTP service becomes one site, `jellyfin.yourdomain.com` → `/proxy/jellyfin/…`
on the wake proxy, exactly like the NGINX configs (TCP services are skipped).
Nothing is installed or reloaded for you — unlike NGINX, Caddy picks the config
up itself.

#### Starting from scratch (no Caddy yet)

Nothing in DockerWakeUp starts a Caddy for you, so bring one up first. The
example stack is a complete caddy-docker-proxy already wired for DockerWakeUp
(ports 80/443 must be free — i.e. no NGINX on them):

```bash
mkdir ~/caddy && cp examples/caddy-docker-proxy.yml ~/caddy/docker-compose.yml
docker network create caddy
(cd ~/caddy && docker compose up -d)

cp config.json.example config.json        # domain + services
docker compose run --rm caddy-generator
docker compose up -d --build
```

That's it: caddy-docker-proxy notices the labelled `docker-wakeup` container,
adds one site per service and issues certificates for the new subdomains (DNS
for them must point at the server — a wildcard `A *` record is enough). Later
containers you want Caddy to serve just get `caddy.*` labels of their own on the
`caddy` network, as in the caddy-docker-proxy docs.

The stack runs Caddy with **host networking** on purpose: it binds 80/443
directly and talks to the wake proxy over loopback, so there is nothing to open
in the firewall — a Caddy on a bridge network is blocked by ufw on a stock
Ubuntu (see step 1 of the checklist below). It still reaches labelled containers
over the `caddy` network.

Running DockerWakeUp via SystemD/PM2 instead of Docker? Run `setup-service.sh`,
choose "Caddy" and answer "no" to "already have Caddy?" — it writes the same
stack with the generated Caddyfile already mounted to
`proxy-generator/caddy-stack.yml` and prints the three commands to start it
(see B) below for what that does).

#### Already running caddy-docker-proxy? The checklist

Your Caddy container, its network, certificates and every other labelled
container stay exactly as they are. Four things change:

1. **Let Caddy reach the wake proxy** (it listens on the *host*, port 8080 by
   default — the generated config points Caddy at `host.docker.internal:8080`).
   Add this to your existing caddy service and recreate it (`docker compose up -d`):
   ```yaml
   extra_hosts:
     - "host.docker.internal:host-gateway"
   ```
   Then open the firewall for the proxy port — the ufw rule and a self-test
   command are in [Works With Any Reverse Proxy](#works-with-any-reverse-proxy-).
   If your Caddy runs with `network_mode: host` (or is plain Caddy on the
   host), skip all of this and set `"caddyUpstream": "127.0.0.1:8080"` in
   `config.json` instead.

2. **Remove the `caddy.*` labels from every service you hand over to
   DockerWakeUp.** If `jellyfin` keeps `caddy: jellyfin.example.com` /
   `caddy.reverse_proxy: {{upstreams 8096}}`, caddy-docker-proxy merges that with
   DockerWakeUp's block for the same hostname and the site ends up with two
   `reverse_proxy` directives. And once idle shutdown stops the container, its
   labels disappear with it — exactly when the wake-up should happen.
   DockerWakeUp's labels must be the *only* route for those hostnames.

3. **Publish each managed service's port on the host.** caddy-docker-proxy
   setups usually publish no ports at all — Caddy reaches containers over the
   shared network. The wake proxy reaches them via `target`
   (`http://localhost:8096`), so add a `ports:` mapping to each managed service.
   Binding to loopback keeps it private:
   ```yaml
   ports:
     - "127.0.0.1:8096:8096"
   ```

4. **Configure, generate, start:**
   ```bash
   cp config.json.example config.json   # domain + services; targets are the localhost ports from step 3
   docker compose run --rm caddy-generator
   docker compose up -d --build
   ```
   caddy-docker-proxy notices the labelled `docker-wakeup` container and adds one
   site per service; Caddy issues certificates for the new subdomains as usual
   (their DNS must already point at the server — a wildcard record covers it).

After changing `config.json`, re-run the generator and `docker compose up -d`
(labels only change when the container is recreated). Already have a
`docker-compose.override.yml` of your own? The generator leaves it untouched
and prints the labels for you to merge.

**B) caddy-docker-proxy + SystemD/PM2 deployment (base Caddyfile)**

There is no DockerWakeUp container to label, so mount the generated Caddyfile
into the caddy-docker-proxy container and point `CADDY_DOCKER_CADDYFILE_PATH`
at it (both lines are in the example stack, commented out). caddy-docker-proxy
re-reads the file every time it regenerates its config (on Docker events and
every 30s by default), so `npm run generate` is all you need after changes.
Steps 1–3 of the checklist apply here too (with `caddyUpstream` per step 1).

**C) Plain Caddy on the host**

Add `import /path/to/DockerWakeUp/proxy-generator/Caddyfile` to
`/etc/caddy/Caddyfile`, set `"caddyUpstream": "127.0.0.1:8080"`, and
`sudo systemctl reload caddy` after each regeneration.

**TLS:** Caddy obtains a certificate per subdomain automatically (ports 80/443
must be reachable from the internet), so the wildcard certificate from the SSL
Setup section is not needed. A wildcard needs a Caddy build with your DNS
provider's module — see the Caddy docs.

**Keeping hand edits:** the same `# custom-start` / `# custom-end` markers and
`# wakeup:manual` escape hatch as the NGINX generator apply — every site block in
the Caddyfile has its own marker pair (for `basic_auth`, extra headers, ...),
and `docker-compose.override.yml` has one region inside `labels:` (label indices
`caddy_0`, `caddy_1`, … follow the order of services in `config.json`). See
[proxy-generator/Caddyfile.example](proxy-generator/Caddyfile.example).

### 4. Traefik (`proxy-generator/`)

`npm run traefik` (or picking Traefik in `setup-service.sh`) writes
`proxy-generator/traefik-dynamic.yml` for Traefik's
[file provider](https://doc.traefik.io/traefik/providers/file/): one catch-all
router (`HostRegexp` on `*.<domain>`) pointing at the wake proxy, plus a router
per service that has extra `domains` aliases. Because routing is host-based,
the file only changes when your domain or aliases change — and Traefik re-reads
it automatically (`providers.file.watch`).

- **No Traefik yet?** [examples/traefik.yml](examples/traefik.yml) is a
  complete stack: host networking (see the firewall notes in
  [Works With Any Reverse Proxy](#works-with-any-reverse-proxy-)), 80→443
  redirect, and entrypoint-level TLS via Let's Encrypt — set your ACME email
  and the volume path, then start it.
- **Already running Traefik?** Mount the generated file, enable the file
  provider (`--providers.file.filename=… --providers.file.watch=true`), and
  make sure Traefik can reach the wake proxy (same reachability/firewall notes
  as above). Three config keys adapt the output to your setup:
  `traefikEntrypoint` (default `websecure`), `traefikCertResolver` (adds
  `tls.certResolver` to each router; without it TLS is expected to come from
  the entrypoint), and `traefikUpstream` (default
  `host.docker.internal:<proxyPort>`; use `127.0.0.1:<proxyPort>` for a
  host-network Traefik). The same rules as Caddy apply: remove Traefik labels
  from services you hand over, and publish their ports on the host.

### 5. Idle Shutdown (Integrated)

Idle shutdown is now part of the wake-proxy service:
- Monitors last access times for each service
- Stops containers that have been idle longer than your configured threshold
- Runs automatically every 5 minutes—no cron job or shell script required

## Service Management ⚙️

```bash
sudo systemctl start|stop|restart|status docker-wakeup
sudo systemctl enable|disable docker-wakeup     # auto-start on boot
sudo journalctl -u docker-wakeup -f             # live logs
curl localhost:8080/healthz                     # liveness + update check
```

After changing `config.json`: restart the service, and re-run the generator if
routes or domains changed (`cd proxy-generator && npm run nginx` / `npm run caddy`).
PM2 deployments use `pm2 restart docker-wakeup` and `pm2 logs docker-wakeup`;
Docker deployments use `docker compose up -d --build` and `docker logs docker-wakeup`.

**If something's wrong:** check `sudo systemctl is-active docker-wakeup` and the
logs above, make sure `config.json` is valid JSON (`jq . config.json`), or run
the proxy by hand to see the error directly: `cd wake-proxy && node dist/wake-proxy.js`.


## 📁 Project Structure

```
DockerWakeUp/
├── config.json                 # Your configuration (created from the example)
├── config.json.example         # Example configuration
├── CONFIGURATION.md            # Full config.json reference (every option + recipes)
├── README.md                   # This file
├── CHANGELOG.md / SECURITY.md / CONTRIBUTING.md / LICENSE
├── docs/ARCHITECTURE.md        # How a request flows through the code
├── docker-wakeup.service.example  # SystemD service template
├── docker-compose.yml          # Run DockerWakeUp with Docker (+ one-shot generator)
├── docker-compose.override.yml # Generated: caddy-docker-proxy labels override
├── Dockerfile                  # Image for the Docker deployment
├── ecosystem.config.js         # PM2 configuration template
├── setup-service.sh            # Automated setup script
├── wake-proxy/                 # The wake proxy service (own package.json)
│   ├── src/                    # TypeScript sources, one module per concern
│   │   ├── wake-proxy.ts       #   entry point → dist/wake-proxy.js
│   │   ├── config.ts, routing.ts, app.ts, proxy.ts, wakeEndpoints.ts, wakePage.ts
│   │   ├── wakeManager.ts, idleShutdown.ts, tcpProxy.ts, lastAccess.ts
│   │   └── updateChecker.ts, shell.ts, util.ts, server.ts
│   ├── test/                   # Jest unit + integration tests (100% coverage)
│   ├── dist/                   # Compiled JavaScript (npm run build)
│   └── tmp/                    # Idle timers + wake history (state on disk)
├── proxy-generator/            # Reverse proxy config generator (own package.json)
│   ├── generate.ts             # Entry point (npm run nginx | caddy | traefik)
│   ├── src/                    # cli, config, context, markers, nginx, caddy, traefik
│   ├── test/                   # Jest tests incl. byte-for-byte golden outputs
│   ├── confs/                  # Generated NGINX configs (jellyfin.conf, ...)
│   ├── Caddyfile               # Generated (plain Caddy / CDP base Caddyfile)
│   ├── traefik-dynamic.yml     # Generated Traefik file-provider config
│   └── Caddyfile.example       # What the Caddy output looks like
├── examples/
│   ├── custom-wake-page.html  # Custom startup page example
│   ├── caddy-docker-proxy.yml # caddy-docker-proxy stack fronting DockerWakeUp
│   └── traefik.yml            # Traefik stack fronting DockerWakeUp
├── test/                       # Cross-package test suites (see Development & Testing)
│   ├── api/                    #   Postman collection + newman runner
│   ├── e2e/                    #   Playwright browser tests of the wake page
│   ├── setup-service/          #   bats tests for setup-service.sh
│   └── support/                #   the harness that starts a proxy for both
├── .github/workflows/ci.yml    # CI: lint, types, tests, Docker build for every PR
└── package.json                # Development tooling only (lint, tests) — not deployed
```

## Requirements 🔧

### System Requirements
- **Operating System**: Linux (Ubuntu 20.04+ recommended)
- **Memory**: 512MB+ RAM
- **Storage**: 100MB+ for the application itself
- **Network**: Public IP with domain name for SSL

### Software Dependencies
- **Docker**: 20.10+
- **Docker Compose**: 2.0+
- **Node.js**: 20+ (SystemD/PM2 deployments; the Docker image ships its own)
- **NGINX**: 1.18+ — or **Caddy** 2.x / caddy-docker-proxy — or **Traefik** v3
- **jq**: 1.6+ (for JSON parsing)

### Optional Dependencies
- **PM2**: For production process management
- **Certbot**: For automatic SSL certificate management
- **UFW**: For firewall configuration

## Development & Testing 🧪

```bash
npm run install:all              # root tooling + both packages
npm run test:all                 # lint, types, shellcheck, unit/integration, API, e2e, setup script
```

| Layer | What | Command |
|-------|------|---------|
| Unit & integration | Jest suites for both packages, 100% coverage enforced; the wake page's browser script runs under jsdom | `npm run test:coverage` |
| API | A Postman collection ([test/api](test/api)) run with newman against a proxy started on free ports | `npm run test:api` |
| End-to-end | Playwright drives Chromium through the wake page: live logs, auto-reload, custom pages, failures | `npm run test:e2e` |
| Setup script | bats tests for `setup-service.sh` with `sudo`/`docker`/`git` shimmed | `npm run test:setup-script` |

The same checks run in GitHub Actions for every pull request to `main`
(plus a Docker image build and `/healthz` smoke test). Setup details,
conventions and how the tests are organised: [CONTRIBUTING.md](CONTRIBUTING.md);
how the code fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing 🤝

Contributions are welcome — fork, branch, add tests, run `npm run test:all`
and open a pull request. [CONTRIBUTING.md](CONTRIBUTING.md) has the details
(setup, checks, code style).

### Reporting Issues
- Use the GitHub issue tracker
- Include system information
- Provide configuration examples
- Include relevant logs

## License 📄

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments 🙏

- Built with [Express.js](https://expressjs.com/) and [TypeScript](https://www.typescriptlang.org/)
- Uses [http-proxy-middleware](https://github.com/chimurai/http-proxy-middleware) for proxying
- Inspired by the need for efficient resource management in homelab environments

## Support 📞

- **Documentation**: Check this README and inline code comments
- **Issues**: Use GitHub Issues for bug reports and feature requests
- **Discussions**: Use GitHub Discussions for questions and community support

---

⭐ **Star this repository if you find it useful!** ⭐
