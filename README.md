# Docker Wake-Up Proxy System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.5+-blue.svg)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Compatible-blue.svg)](https://www.docker.com/)

## What's New

- **Caddy support** — generate a Caddyfile or caddy-docker-proxy labels instead of NGINX configs (see [Caddy / caddy-docker-proxy](#3-caddy-generator-caddy-generator))
- **Live startup page** — streams the waking container's logs in the browser, with elapsed time and auto-reload when ready
- **Progress estimate** — "usually ready in ~40s" bar based on the service's previous wake-ups
- **Custom wake pages** — bring your own HTML via `wakePage`, per service or global
- **TCP wake-on-connect** — game servers like Minecraft now wake when a player connects
- **Start/stop hooks** — run your own commands before `docker compose up` and after `docker compose stop`
- **Non-Docker services** — hooks can fully replace Docker Compose for a service
- **Docker deployment** — run DockerWakeUp itself with one `docker compose up -d --build`
- **Update notifications** — daily check that flags when your copy is behind GitHub
- **Log privacy** — `showLogs: false` hides startup logs from public eyes
- **Crash fix** — WebSocket reconnects to a sleeping service no longer kill the proxy
- **Idle-shutdown fixes** — no more stopping services mid-wake or re-stopping sleeping ones

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

**Docker Wake Up** is a lightweight tool designed to help users reverse proxy Dockerized applications (like Immich, Nextcloud, Portainer, etc.) to clean URLs such as `yourdomain.com/photos`.

In addition to proxying, it provides smart container management by:

- **Automatically starting** Docker services when they are accessed.
- **Shutting them down** after a period of inactivity (optional).

This is especially useful for self-hosted environments where you want to conserve resources by running only the services you actually need, while still keeping them easily accessible on demand.

## Table of Contents 📋

- [What's New](#whats-new-)
- [Features](#features-)
- [Quick Start](#quick-start-)
- [SSL Setup](#ssl-setup-)
- [Automated Setup Script](#automated-setup-script-️)
- [Manual Installation](#manual-installation-)
- [Service Management](#service-management-️)
- [Architecture](#️-architecture)
- [Configuration](#configuration-️)
- [Components](#components-)
- [Caddy / caddy-docker-proxy](#3-caddy-generator-caddy-generator)
- [Usage](#usage-)
- [Project Structure](#-project-structure)
- [Requirements](#requirements-)
- [Contributing](#contributing-)
- [License](#license-)
- [Acknowledgments](#acknowledgments-)
- [Support](#support-)

## Quick Start ⚡

Before you start: point DNS at this server (an `A` record for `*.yourdomain.com`
covers every service), and have Docker + Node.js installed.

**1. Get the code and describe your services**

```bash
git clone https://github.com/jelliott2021/docker-wakeup.git
cd docker-wakeup
cp config.json.example config.json
nano config.json      # your domain + one entry per service (see Configuration below)
```

**2. Run the setup script and pick option 1**

```bash
chmod +x setup-service.sh
./setup-service.sh
```

It builds everything, asks which reverse proxy you use, and installs and starts
the `docker-wakeup` SystemD service (auto-starts on boot):

- **NGINX** — the site configs are generated, linked into `sites-enabled` and
  NGINX is reloaded. The only thing left is HTTPS: get the wildcard certificate
  from [SSL Setup](#ssl-setup-) once.
- **Caddy / caddy-docker-proxy** — it asks whether you already run Caddy and
  prints the two or three things left to do for your case (or writes a
  ready-to-run Caddy stack if you don't have one yet). Caddy handles HTTPS
  itself — no certificates to manage.

**3. Use it**

Open `https://jellyfin.yourdomain.com`. If the service is stopped you see a
startup page with its live logs; it reloads into the app as soon as it's ready.
Services that nobody uses for `idleThreshold` seconds (3 days by default) are
stopped again automatically — no cron job needed.

**After the initial setup**

| Want to… | Do this |
|---|---|
| Add or change a service | edit `config.json`, then `./setup-service.sh` → option 4 (regenerates the proxy config) and `sudo systemctl restart docker-wakeup` |
| Update DockerWakeUp | `git pull` then `./setup-service.sh` (it detects and offers the update itself) |
| Watch the logs | `sudo journalctl -u docker-wakeup -f` |
| Check it's alive | `curl localhost:8080/healthz` — also shows whether a newer version exists (checked daily; disable with `"updateCheck": false`) |

**Alternative: run DockerWakeUp itself in Docker**

No Node.js on the host needed. The container uses host networking (Linux only —
not Docker Desktop) so `localhost` targets just work, and mounts your home
directory so your services' compose directories are visible at the same path —
edit the volumes in [docker-compose.yml](docker-compose.yml) if your stacks live
elsewhere (e.g. `/opt/stacks`).

```bash
docker compose run --rm caddy-generator   # only if you use caddy-docker-proxy — writes the labels override
docker compose up -d --build
```

You still need the reverse proxy in front of it: NGINX on the host (generate its
configs with `cd nginx-generator && npm install && npm run generate`, which does
need Node.js) or caddy-docker-proxy (the command above is all it takes — see the
[Caddy section](#3-caddy-generator-caddy-generator)). Update with
`git pull && docker compose up -d --build`.

## SSL Setup 🔒

> Using Caddy? Skip this section — Caddy obtains and renews certificates by
> itself (see [Caddy / caddy-docker-proxy](#3-caddy-generator-caddy-generator)).

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

The included `setup-service.sh` script provides a **one-command installation** that handles all the complex setup automatically.

### Quick Setup

```bash
# Make the script executable and run it
chmod +x setup-service.sh
./setup-service.sh
```

### What the Setup Script Does

**Automated Installation Process:**
1. ✅ **Dependency Installation** - Installs all npm packages for all components
2. ✅ **TypeScript Compilation** - Builds the wake-proxy, nginx-generator and caddy-generator
3. ✅ **Reverse Proxy Configuration Generation** - Creates NGINX configs or Caddy / caddy-docker-proxy configs from your config.json (you pick which)
4. ✅ **SystemD Service Creation** - Generates service file with correct paths
5. ✅ **User & Path Detection** - Automatically configures service for your system
6. ✅ **Security Hardening** - Applies production security settings
7. ✅ **Auto-Start Configuration** - Sets up service to start on boot
8. ✅ **Service Activation** - Immediately starts the service

### Setup Options

The script provides several installation methods:

```
1) SystemD service + reverse proxy configs (recommended for production)
2) PM2 process manager + reverse proxy configs
3) Build project only (no service setup)
4) Generate reverse proxy configs only (NGINX or Caddy)
5) Exit
```

Options 1, 2 and 4 then ask which reverse proxy you use — NGINX (default),
Caddy / caddy-docker-proxy, or none — and generate the matching configs.
Choosing Caddy asks one more question (do you already have Caddy running?) and
prints the short list of things left to do for your case; if you don't have
Caddy yet it also writes a ready-to-run caddy-docker-proxy stack to
`caddy-generator/caddy-stack.yml` with the generated Caddyfile already mounted.

**SystemD + NGINX Features:**
- 🔄 **Auto-restart** on failure or crash
- 🚀 **Boot integration** - starts with your system
- 📊 **Systemd logging** integration with `journalctl`
- 🔒 **Security hardening** with filesystem protections
- ⚡ **Zero-downtime** updates with proper restart handling
- 🌐 **NGINX Integration** - automatically generates SSL-enabled configs
- 🔗 **Symbolic linking** - configs automatically linked to sites-enabled

### Post-Setup Management

After running the setup script, manage your service with:

```bash
# Check service status
sudo systemctl status docker-wakeup

# View live logs  
sudo journalctl -u docker-wakeup -f

# Restart after config changes
sudo systemctl restart docker-wakeup

# Stop/start the service
sudo systemctl stop docker-wakeup
sudo systemctl start docker-wakeup
```

### Why Use the Setup Script?

**Advantages over Manual Installation:**
- ⏱️ **Saves Time** - Complete setup including NGINX configs in under 2 minutes
- 🎯 **Zero Errors** - Eliminates common configuration mistakes
- 🔧 **Production Ready** - Applies best practices automatically
- 🛡️ **Secure by Default** - Includes security hardening
- 📝 **Consistent Setup** - Same configuration every time
- 🌐 **NGINX Integration** - Automatically generates and links SSL configs
- 🔄 **All-in-One** - Handles both service setup AND web server configuration

**Perfect for:**
- First-time installations
- Production deployments  
- Quick testing and demos
- Team onboarding
- Homelab setups requiring an NGINX or Caddy reverse proxy

## Manual Installation 📦

If you prefer manual setup or need custom configuration:

### Prerequisites

- Docker and Docker Compose
- Node.js 16+ and npm
- NGINX or Caddy / caddy-docker-proxy (for production)
- jq (for JSON parsing in bash scripts)
- SSL certificates (Let's Encrypt recommended)

### Step-by-Step Manual Installation

1. **Clone and setup the repository**
   ```bash
   git clone https://github.com/jelliott2021/docker-wakeup.git
   cd docker-wakeup
   ```

2. **Install dependencies for all components**
   ```bash
   # Wake proxy dependencies
   cd wake-proxy && npm install && cd ..
   
   # NGINX generator dependencies
   cd nginx-generator && npm install && cd ..

   # Caddy generator dependencies (only if you use Caddy)
   cd caddy-generator && npm install && cd ..
   ```

3. **Configure your services**
   ```bash
   # Copy and edit the configuration
   cp config.json.example config.json
   nano config.json
   ```

4. **Generate reverse proxy configurations**

   NGINX:
   ```bash
   cd nginx-generator
   npm run generate
   sudo nginx -t  # Test configuration
   sudo systemctl reload nginx
   cd ..
   ```

   Caddy / caddy-docker-proxy (see the [caddy-generator section](#3-caddy-generator-caddy-generator) for how to use the output):
   ```bash
   cd caddy-generator
   npm run generate
   cd ..
   ```

5. **Build the wake proxy**
   ```bash
   cd wake-proxy && npm run build && cd ..
   ```

6. **Create SystemD service manually**
   
   Copy the service template and customize:
   ```bash
   # Copy the example template
   sudo cp docker-wakeup.service.example /etc/systemd/system/docker-wakeup.service
   
   # Edit paths and username
   sudo nano /etc/systemd/system/docker-wakeup.service
   ```
   
   Enable and start the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable docker-wakeup
   sudo systemctl start docker-wakeup
   
   # Check status
   sudo systemctl status docker-wakeup
   ```


### Common SystemD Commands

After installation, use these commands to manage the service:

```bash
# Service control
sudo systemctl start docker-wakeup      # Start the service
sudo systemctl stop docker-wakeup       # Stop the service
sudo systemctl restart docker-wakeup    # Restart the service
sudo systemctl status docker-wakeup     # Check status

# Auto-start management
sudo systemctl enable docker-wakeup     # Enable auto-start on boot
sudo systemctl disable docker-wakeup    # Disable auto-start

# Logging and monitoring
sudo journalctl -u docker-wakeup -f                    # Real-time logs
sudo journalctl -u docker-wakeup -n 100               # Last 100 lines
sudo journalctl -u docker-wakeup --since "1 hour ago" # Recent logs
sudo systemctl is-active docker-wakeup                 # Check if running
```

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
1. **NGINX or Caddy** handles SSL termination and routes requests to the wake proxy
2. **Wake Proxy** manages container lifecycle, proxies requests, and now also monitors/stops unused containers (idle shutdown is integrated)

## Configuration ⚙️

Edit `config.json` to define your services:

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
    },
    {
      "route": "portainer",
      "target": "http://localhost:9000",
      "composeDir": "/path/to/portainer"
    }
  ]
}
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `proxyPort` | Port for the wake proxy service | `8080` |
| `idleThreshold` | Time in seconds before stopping idle containers | `259200` (3 days) |
| `domain` | Your domain name for generating subdomains | `"example.com"` |
| `services` | Array of service configurations | `[]` |
| `wakePage` | Optional path to a custom "starting up" HTML page used for all services (relative to the project root) | built-in page |
| `updateCheck` | Set to `false` to disable the daily check for new DockerWakeUp versions | `true` |
| `caddyUpstream` | Caddy only: address Caddy uses to reach the wake proxy. Use `127.0.0.1:8080` when Caddy runs directly on the host | `host.docker.internal:<proxyPort>` |

### Service Configuration

| Field | Description | Example |
|-------|-------------|---------|
| `route` | Subdomain/route name | `"jellyfin"` |
| `target` | Local URL where the service runs | `"http://localhost:8096"` |
| `composeDir` | Directory containing docker-compose.yml (optional if `startCommand` is set) | `"/path/to/service"` |
| `type` | `"http"` (default) or `"tcp"` for raw TCP services like game servers | `"tcp"` |
| `listenPort` | TCP services only: port the wake proxy listens on for clients | `25566` |
| `wakePage` | Optional per-service custom "starting up" HTML page (overrides the global `wakePage`) | `"examples/custom-wake-page.html"` |
| `showLogs` | Set `false` to hide container logs from the startup page | `true` |
| `startCommand` | Hook run **before** `docker compose up -d` when waking (run in `composeDir`). Without a `composeDir`, it *is* the start command | `"./prepare.sh"` |
| `stopCommand` | Hook run **after** `docker compose stop` on idle shutdown. Without a `composeDir`, it *is* the stop command | `"./backup.sh"` |
| `logsCommand` | Custom command for the startup page's log stream (default: `docker compose logs -f`) | `"journalctl -fu myapp"` |

`startCommand`, `stopCommand`, and `logsCommand` are run via `/bin/sh -c` with
`composeDir` as the working directory, so any shell command line works — a
script, a binary, a pipeline, an `&&` chain. They run as the wake-proxy's own
user (no sudo). If you run DockerWakeUp with Docker, remember the command
executes inside the (Alpine) container: `sh` is available but bash/python are
not, and referenced files must be visible inside the container's mounts.

Some examples of what hooks can do:

```json
"stopCommand": "tar czf backups/world-$(date +%F).tar.gz world/"
```
Back up a game world after the idle shutdown stops the server.

```json
"startCommand": "mount | grep -q /mnt/photos || mount /mnt/photos"
```
Make sure a network share is mounted before the containers come up.

```json
"startCommand": "curl -s -X POST -H 'Content-Type: application/json' -d '{\"content\": \"Jellyfin is waking up\"}' https://discord.com/api/webhooks/..."
```
Notify a Discord webhook when the service wakes (same idea works for `stopCommand`).

```json
"startCommand": "nohup node server.js >> app.log 2>&1 &",
"stopCommand": "pkill -f 'node server.js'",
"logsCommand": "tail -n 50 -f app.log"
```
Run a service that isn't managed by Docker at all — with no `composeDir`, the
hooks *are* the start/stop, and the wake page tails the app's own log file.

### TCP Services 🎮

Services that don't speak HTTP (Minecraft and other game servers, databases,
...) can't go through the HTTP proxy — set `"type": "tcp"` instead:

```json
{
  "route": "minecraft",
  "type": "tcp",
  "listenPort": 25566,
  "target": "localhost:25565",
  "composeDir": "/home/youruser/minecraft"
}
```

The wake proxy listens on `listenPort` and forwards raw bytes to `target`.
When a client connects while the service is stopped, the proxy starts it,
holds the connection until the target port opens (up to 90s), then connects
through — so a Minecraft client's first join attempt wakes the server (clients
that time out can simply retry). Point your port forwarding / DNS at
`listenPort`, and note the service itself must bind a *different* port than
`listenPort`. Idle shutdown works as usual: active connections keep the
service marked as in-use. TCP services bypass NGINX/Caddy entirely (both
generators skip them).

### Startup Page 🕓

When a browser hits a sleeping service, the wake proxy immediately responds with a
startup page instead of leaving the request hanging. The default page shows a
spinner, elapsed time, and the live `docker compose logs -f` output of the waking
service, then reloads automatically once the service answers HTTP. Once a
service has been woken before, the page also shows a progress bar with a
"usually ready in ~40s" estimate based on its last 10 wake-ups. Non-browser
GET requests (APIs, assets) wait for the service and are retried transparently;
non-idempotent requests (POST etc.) get an immediate `503` with a `Retry-After`
header, since their body can't be safely replayed.

Anyone who can reach the service's URL can see the startup logs while it boots —
set `"showLogs": false` on services whose logs shouldn't be public.

To use your own page, set `wakePage` in `config.json` (globally or per-service) to
an HTML file. `{{route}}` inside the file is replaced with the service's route
name. If you run DockerWakeUp with Docker, keep the page in `examples/` (mounted
into the container) or use an absolute path under your home directory. Your page can use two same-origin endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET __wake/status` | JSON: `{ state, ready, startedAt, error, expectedMs, elapsedMs }` — `state` is `idle`/`starting`/`ready`/`failed`; reload the page when `ready` is `true`; `expectedMs` is the typical wake duration (null until the first wake) |
| `GET __wake/logs` | Server-Sent Events stream of `docker compose logs -f` (each event is one JSON-encoded log line) |

See [examples/custom-wake-page.html](examples/custom-wake-page.html) for a
minimal working example, including the URL-prefix handling needed to work both
behind NGINX/Caddy and when accessing the wake proxy directly.

## Components 🧩

### 1. Wake Proxy (`wake-proxy/`)

The heart of the system - a TypeScript Express server that:
- Listens for incoming HTTP requests
- Automatically starts containers using Docker Compose
- Proxies requests to the target services
- Implements cooldown logic to prevent rapid restarts
- Tracks access times for idle management

**Key Features:**
- Smart error handling with automatic retry
- WebSocket support for real-time applications
- Conflict resolution for container naming issues
- Health check monitoring before proxying

### 2. NGINX Generator (`nginx-generator/`)

Automatically generates SSL-enabled NGINX configurations:
- Creates subdomain-based routing (e.g., `jellyfin.yourdomain.com`)
- Sets up SSL certificates with Let's Encrypt
- Configures proper proxy headers
- Creates symbolic links in `/etc/nginx/sites-enabled/`

**Generated Configuration Includes:**
- HTTP to HTTPS redirect
- SSL certificate configuration
- Proxy headers for proper forwarding
- Buffering optimization

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
[nginx-generator/confs/example.conf](nginx-generator/confs/example.conf).

### 3. Caddy Generator (`caddy-generator/`)

Prefer Caddy — or already run [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy)
for your other containers? `caddy-generator` is the Caddy counterpart of the
NGINX generator. It reads the same `config.json` and writes two files:

| File | Use it when |
|------|-------------|
| `docker-compose.override.yml` (repo root) | DockerWakeUp runs with Docker and Caddy is caddy-docker-proxy — a compose override that puts `caddy_N` labels on the `docker-wakeup` container. Docker Compose loads it automatically, so a plain `docker compose up -d --build` includes the labels |
| `caddy-generator/Caddyfile` | DockerWakeUp runs via SystemD/PM2 (hand it to caddy-docker-proxy as its base Caddyfile via `CADDY_DOCKER_CADDYFILE_PATH`), or you run plain Caddy on the host (`import` it) |

Generate them whichever way suits you:

```bash
docker compose run --rm caddy-generator          # no Node.js on the host needed
# or, with Node.js installed:
cd caddy-generator && npm install && npm run generate && cd ..
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
`caddy-generator/caddy-stack.yml` and prints the three commands to start it
(see B) below for what that does).

#### Already running caddy-docker-proxy? The checklist

Your Caddy container, its network, certificates and every other labelled
container stay exactly as they are. Four things change:

1. **Let Caddy reach the wake proxy.** The wake proxy listens on the *host*
   (`proxyPort`, 8080 by default), not on the `caddy` network, and the generated
   config points Caddy at `host.docker.internal:8080`. Add this to your existing
   caddy service and recreate it (`docker compose up -d`):
   ```yaml
   extra_hosts:
     - "host.docker.internal:host-gateway"
   ```
   **Firewall — not optional on Ubuntu with ufw.** A container on a bridge
   network cannot reach *any* host port through ufw: requests time out and Caddy
   answers 502. Allow the wake proxy port from your Caddy network (subnet from
   `docker network inspect caddy`):
   ```bash
   sudo ufw allow from 172.27.0.0/16 to any port 8080 proto tcp
   ```
   Self-test — prints JSON once Caddy will be able to reach the wake proxy:
   ```bash
   docker run --rm --network caddy --add-host host.docker.internal:host-gateway alpine wget -qO- http://host.docker.internal:8080/healthz
   ```
   No firewall rule is needed if Caddy runs with `network_mode: host` — then map
   `host.docker.internal` to loopback instead
   (`extra_hosts: ["host.docker.internal:127.0.0.1"]`), which is what
   [examples/caddy-docker-proxy.yml](examples/caddy-docker-proxy.yml) does. Plain
   Caddy on the host: set `"caddyUpstream": "127.0.0.1:8080"` in `config.json`.

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

Add `import /path/to/DockerWakeUp/caddy-generator/Caddyfile` to
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
[caddy-generator/Caddyfile.example](caddy-generator/Caddyfile.example).

### 4. Idle Shutdown (Integrated)

Idle shutdown is now part of the wake-proxy service:
- Monitors last access times for each service
- Stops containers that have been idle longer than your configured threshold
- Runs automatically every 5 minutes—no cron job or shell script required

## Service Management ⚙️

### SystemD Service Commands

```bash
# Start the service
sudo systemctl start docker-wakeup

# Stop the service
sudo systemctl stop docker-wakeup

# Restart the service
sudo systemctl restart docker-wakeup

# Check service status
sudo systemctl status docker-wakeup

# Enable auto-start on boot
sudo systemctl enable docker-wakeup

# Disable auto-start
sudo systemctl disable docker-wakeup

# View logs (real-time)
sudo journalctl -u docker-wakeup -f

# View logs (last 100 lines)
sudo journalctl -u docker-wakeup -n 100
```

### Service Configuration Updates

When you update the `config.json` file, restart the service:

**SystemD:**
```bash
sudo systemctl restart docker-wakeup
```

**PM2:**
```bash
pm2 restart docker-wakeup
```

### Troubleshooting Service Issues

1. **Check if the service is running:**
   ```bash
   # SystemD
   sudo systemctl is-active docker-wakeup
   
   # PM2
   pm2 status
   ```

2. **Check service logs for errors:**
   ```bash
   # SystemD
   sudo journalctl -u docker-wakeup --since "1 hour ago"
   
   # PM2
   pm2 logs docker-wakeup --lines 50
   ```

3. **Verify configuration file exists and is readable:**
   ```bash
   ls -la /path/to/config.json
   cat /path/to/config.json
   ```

4. **Test the service manually:**
   ```bash
   cd wake-proxy
   node dist/wake-proxy.js
   ```

## Usage 🚀

### Starting Services

Once configured, accessing any subdomain will automatically:
1. Check if the target container is running
2. Start the container if it's stopped
3. Wait for the service to become healthy
4. Proxy the request to the running service

Example: Visiting `https://jellyfin.yourdomain.com` will:
- Start the Jellyfin container if stopped
- Show a "starting up" message during startup
- Redirect to Jellyfin once ready

### Monitoring

The system creates several log files and markers:
- `/tmp/last_access_[route]` - Last access timestamps
- Container startup/shutdown logs via Docker
- Wake proxy logs for debugging

### Manual Container Management

You can still manually manage containers:
```bash
# Start a service manually
docker-compose -f /path/to/service/docker-compose.yml up -d

# Stop a service manually
docker-compose -f /path/to/service/docker-compose.yml down

# View container status
docker ps
```

## 📁 Project Structure

```
docker-wakeup/
├── config.json                 # Main configuration file (Should intially be made by you)
├── config.json.example         # Example configuration
├── README.md                   # This file
├── LICENSE                     # MIT license
├── CONTRIBUTING.md             # Contribution guidelines
├── docker-wakeup.service.example  # SystemD service template
├── docker-compose.yml          # Run DockerWakeUp with Docker (+ caddy-generator one-shot)
├── docker-compose.override.yml # Generated by caddy-generator: caddy-docker-proxy labels
├── ecosystem.config.js         # PM2 configuration template
├── setup-service.sh            # Automated service setup script
├── wake-proxy/                 # Wake proxy service
│   ├── src/
│   │   └── wake-proxy.ts      # Main proxy logic
│   ├── package.json           # Dependencies
│   ├── tsconfig.json          # TypeScript config
│   └── dist/                  # Compiled JavaScript
├── nginx-generator/            # NGINX config generator
│   ├── generate-nginx.ts      # Generator script
│   ├── package.json           # Dependencies
│   ├── tsconfig.json          # TypeScript config
│   └── confs/                 # Generated configs
│       ├── jellyfin.conf
│       ├── portainer.conf
│       └── ...
├── caddy-generator/            # Caddy / caddy-docker-proxy config generator
│   ├── generate-caddy.ts      # Generator script
│   ├── Caddyfile.example      # What the output looks like
│   └── Caddyfile              # Generated (plain Caddy / CDP base Caddyfile)
└── examples/
    ├── custom-wake-page.html  # Custom startup page example
    └── caddy-docker-proxy.yml # caddy-docker-proxy stack fronting DockerWakeUp
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
- **Node.js**: 16.0+
- **NGINX**: 1.18+ — or **Caddy** 2.x / caddy-docker-proxy
- **jq**: 1.6+ (for JSON parsing)

### Optional Dependencies
- **PM2**: For production process management
- **Certbot**: For automatic SSL certificate management
- **UFW**: For firewall configuration

## Contributing 🤝

We welcome contributions! Here's how you can help:

1. **Fork the repository**
2. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes**
4. **Add tests if applicable**
5. **Commit your changes**
   ```bash
   git commit -m "Add: your feature description"
   ```
6. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```
7. **Create a Pull Request**

### Development Guidelines
- Use TypeScript for new features
- Follow existing code style
- Add JSDoc comments for public functions
- Test with multiple Docker services
- Update documentation for new features

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
