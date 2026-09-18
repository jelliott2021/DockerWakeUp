#!/bin/bash
#
# DockerWakeUp setup: builds the wake proxy, generates the reverse proxy
# configuration and installs DockerWakeUp as a Docker container, a SystemD
# service or a PM2 process. Interactive — run it from the repository as your
# regular user (sudo is used only where needed):
#
#     ./setup-service.sh
#
# Every step is a function; main() runs the menu. Sourcing the file (as the
# bats tests in test/setup-service do) only defines the functions.

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

CANONICAL_REMOTE="https://github.com/jelliott2021/DockerWakeUp.git"

# Repository root (where this script lives) and the wake proxy package
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAKE_PROXY_DIR="$SCRIPT_DIR/wake-proxy"

# Set by the menu and generate_proxy_configs; read by the "next steps" summary
DEPLOY_MODE="host"   # host (SystemD/PM2) or docker
PROXY_CHOICE="nginx" # nginx | caddy | traefik | none
SERVICE_SETUP=""     # "" (nothing installed), 1 (SystemD/PM2) or docker
GIT_STATUS="none"    # see git_update_status

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# True when running as root (a function so the tests can override it)
is_root() {
    [[ $EUID -eq 0 ]]
}

# The wake proxy port from config.json (8080 when unset or unreadable)
config_proxy_port() {
    local port
    port=$(sed -n 's/.*"proxyPort"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$SCRIPT_DIR/config.json" 2>/dev/null | head -1)
    echo "${port:-8080}"
}

# Create config.json from the example when it's missing
ensure_config() {
    if [ ! -f "$SCRIPT_DIR/config.json" ]; then
        echo -e "${YELLOW}config.json not found. Creating from example...${NC}"
        if [ -f "$SCRIPT_DIR/config.json.example" ]; then
            cp "$SCRIPT_DIR/config.json.example" "$SCRIPT_DIR/config.json"
            echo -e "${RED}⚠️  Edit config.json with your actual service details before the generated configs will work!${NC}"
            echo -e "${YELLOW}   (All options are documented in CONFIGURATION.md)${NC}"
        else
            echo -e "${RED}Error: No config.json.example found. Please create config.json manually.${NC}"
            return 1
        fi
    fi
}

# Compare HEAD with the canonical remote. Sets GIT_STATUS to one of
#   latest | behind | ahead | diverged | offline | none (not a git checkout)
git_update_status() {
    GIT_STATUS="none"
    [ -d "$SCRIPT_DIR/.git" ] || return 0
    if ! git -C "$SCRIPT_DIR" fetch "$CANONICAL_REMOTE" HEAD:refs/remotes/origin-upstream 2>/dev/null; then
        GIT_STATUS="offline"
        return 0
    fi
    local local_rev remote_rev base_rev
    local_rev=$(git -C "$SCRIPT_DIR" rev-parse HEAD)
    remote_rev=$(git -C "$SCRIPT_DIR" rev-parse refs/remotes/origin-upstream)
    base_rev=$(git -C "$SCRIPT_DIR" merge-base HEAD refs/remotes/origin-upstream)
    if [ "$local_rev" = "$remote_rev" ]; then
        GIT_STATUS="latest"
    elif [ "$local_rev" = "$base_rev" ]; then
        GIT_STATUS="behind"
    elif [ "$remote_rev" = "$base_rev" ]; then
        GIT_STATUS="ahead"
    else
        GIT_STATUS="diverged"
    fi
}

# Update to the latest code from the canonical remote (menu option 7)
update_from_git() {
    if [ ! -d "$SCRIPT_DIR/.git" ]; then
        echo -e "${RED}Not a git repository. Cannot update from remote.${NC}"
        return 0
    fi
    echo -e "${YELLOW}Checking for latest code from canonical git remote...${NC}"
    git_update_status
    case "$GIT_STATUS" in
        latest)
            echo -e "${GREEN}You are already on the latest version of the code.${NC}"
            ;;
        behind)
            echo -e "${YELLOW}Your local code is behind the canonical remote. Updating now...${NC}"
            git -C "$SCRIPT_DIR" pull "$CANONICAL_REMOTE" HEAD
            echo -e "${GREEN}Code updated. Please re-run this script if you want to continue setup.${NC}"
            exit 0
            ;;
        ahead)
            echo -e "${YELLOW}Your local code is ahead of the canonical remote. (Local changes not pushed)${NC}"
            ;;
        offline)
            echo -e "${YELLOW}Could not reach GitHub to check for updates.${NC}"
            ;;
        *)
            echo -e "${RED}Your local and canonical remote branches have diverged. Please resolve manually.${NC}"
            exit 1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Building and installing the wake proxy
# ---------------------------------------------------------------------------

# Install dependencies and compile both packages
build_project() {
    echo -e "${YELLOW}Building project dependencies...${NC}"

    if [ -d "$WAKE_PROXY_DIR" ]; then
        echo -e "${BLUE}Building wake-proxy...${NC}"
        (cd "$WAKE_PROXY_DIR" && npm install && npm run build) || return 1
    fi

    # proxy-generator (NGINX, Caddy and Traefik config generation)
    if [ -d "$SCRIPT_DIR/proxy-generator" ]; then
        echo -e "${BLUE}Building proxy-generator...${NC}"
        (cd "$SCRIPT_DIR/proxy-generator" && npm install) || return 1
    fi

    echo -e "${GREEN}Build completed!${NC}"
}

# Build the wake proxy if dist/ is missing (SystemD and PM2 setups)
ensure_built() {
    if [ ! -f "$WAKE_PROXY_DIR/dist/wake-proxy.js" ]; then
        echo -e "${YELLOW}Building wake-proxy...${NC}"
        (cd "$WAKE_PROXY_DIR" && npm run build) || return 1
    fi
}

# Install and (optionally) start the SystemD unit
setup_systemd() {
    echo -e "${YELLOW}Setting up SystemD service...${NC}"
    ensure_built || return 1

    local current_user service_file
    current_user=$(whoami)
    service_file="/tmp/docker-wakeup.service"
    cat > "$service_file" << EOF
[Unit]
Description=Docker Wake-Up Proxy
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$current_user
Group=docker
WorkingDirectory=$WAKE_PROXY_DIR
ExecStart=/usr/bin/node dist/wake-proxy.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=docker-wakeup

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
# Where the proxy stores last-access timestamps for idle shutdown
ReadWritePaths=$WAKE_PROXY_DIR/tmp

[Install]
WantedBy=multi-user.target
EOF

    sudo cp "$service_file" /etc/systemd/system/docker-wakeup.service
    sudo systemctl daemon-reload

    echo -e "${GREEN}SystemD service created successfully!${NC}"
    echo ""
    local start_now
    read -r -p "Enable auto-start on boot and (re)start docker-wakeup now? (Y/n): " start_now
    if [[ ! "$start_now" =~ ^[Nn] ]]; then
        sudo systemctl enable docker-wakeup >/dev/null 2>&1 || true
        if sudo systemctl restart docker-wakeup && sudo systemctl is-active --quiet docker-wakeup; then
            echo -e "${GREEN}✅ docker-wakeup is running and will start on boot${NC}"
        else
            echo -e "${RED}❌ docker-wakeup failed to start — check: sudo journalctl -u docker-wakeup -n 50${NC}"
        fi
    else
        echo -e "${YELLOW}To enable and start it later:${NC}"
        echo "  sudo systemctl enable --now docker-wakeup"
    fi
    echo ""
    echo -e "${YELLOW}Service control:${NC}"
    echo "  sudo systemctl stop docker-wakeup"
    echo "  sudo systemctl restart docker-wakeup"
    echo ""
    echo -e "${YELLOW}To check status:${NC}"
    echo "  sudo systemctl status docker-wakeup"
    echo ""
    echo -e "${YELLOW}To view logs:${NC}"
    echo "  sudo journalctl -u docker-wakeup -f"
}

# Install and start under PM2 (installs PM2 itself when missing)
setup_pm2() {
    echo -e "${YELLOW}Setting up PM2 service...${NC}"

    if ! command -v pm2 &> /dev/null; then
        echo -e "${YELLOW}Installing PM2...${NC}"
        npm install -g pm2
    fi
    ensure_built || return 1

    cat > "$SCRIPT_DIR/ecosystem.config.js" << EOF
module.exports = {
  apps: [
    {
      name: 'docker-wakeup',
      script: 'dist/wake-proxy.js',
      cwd: '$WAKE_PROXY_DIR',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      merge_logs: true
    }
  ]
};
EOF

    mkdir -p "$SCRIPT_DIR/logs"
    (cd "$SCRIPT_DIR" && pm2 start ecosystem.config.js && pm2 save) || return 1

    echo -e "${GREEN}PM2 service created successfully!${NC}"
    echo -e "${YELLOW}To setup PM2 to start on boot:${NC}"
    echo "  pm2 startup"
    echo "  # Follow the instructions provided by the command above"
    echo ""
    echo -e "${YELLOW}To check status:${NC}"
    echo "  pm2 status"
    echo ""
    echo -e "${YELLOW}To view logs:${NC}"
    echo "  pm2 logs docker-wakeup"
}

# Run DockerWakeUp itself as a Docker container: generate configs (Node-free
# via the one-shot container when needed), then build + start + health check
setup_docker() {
    echo -e "${YELLOW}Setting up the Docker deployment...${NC}"
    if ! docker compose version >/dev/null 2>&1; then
        echo -e "${RED}Error: docker compose not found — install Docker first (https://docs.docker.com/engine/install/)${NC}"
        return 1
    fi
    ensure_config || return 1
    generate_proxy_configs

    echo -e "${YELLOW}Building and starting the docker-wakeup container...${NC}"
    (cd "$SCRIPT_DIR" && docker compose up -d --build) || return 1

    local port
    port=$(config_proxy_port)
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        curl -sf "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
        sleep 2
    done
    if curl -sf "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
        echo -e "${GREEN}✅ docker-wakeup container is running (wake proxy on port $port)${NC}"
    else
        echo -e "${RED}Container started but /healthz isn't answering yet — check: docker logs docker-wakeup${NC}"
    fi
    SERVICE_SETUP=docker
}

# ---------------------------------------------------------------------------
# Reverse proxy configuration
# ---------------------------------------------------------------------------

# Generate the NGINX vhosts, symlink them into sites-enabled and reload NGINX
generate_nginx_configs() {
    echo -e "${YELLOW}Generating NGINX configurations...${NC}"
    ensure_config || return 1

    if [ ! -d "$SCRIPT_DIR/proxy-generator" ]; then
        echo -e "${RED}Error: proxy-generator directory not found${NC}"
        return 1
    fi

    if [ "$DEPLOY_MODE" = "docker" ] && ! command -v npm >/dev/null 2>&1; then
        # No Node.js on the host: generate the confs in a container, then do
        # the host-side part (symlinks + reload) here in bash
        echo -e "${BLUE}Generating NGINX configs in a container (no Node.js on the host)...${NC}"
        if ! (cd "$SCRIPT_DIR" && WAKEUP_PROXY=nginx docker compose run --rm caddy-generator </dev/null); then
            echo -e "${RED}❌ Failed to generate NGINX configurations${NC}"
            return 1
        fi
        install_nginx_confs
        return
    fi

    echo -e "${BLUE}Generating NGINX configuration files...${NC}"
    # Run as the regular user — the generator uses sudo itself only for
    # the symlink/reload steps, so conf files stay user-owned
    if (cd "$SCRIPT_DIR/proxy-generator" && { [ -d node_modules ] || npm install; } && npm run nginx); then
        echo -e "${GREEN}✅ NGINX configurations generated successfully!${NC}"
        echo -e "${YELLOW}Note: the confs rely on the wake proxy's host-based routing — if an older${NC}"
        echo -e "${YELLOW}build of docker-wakeup is still running, restart it: sudo systemctl restart docker-wakeup${NC}"
    else
        echo -e "${RED}❌ Failed to generate NGINX configurations${NC}"
        echo -e "${YELLOW}Please check your config.json file and try again${NC}"
    fi
}

# Host-side install of generated confs when the generator ran in a container:
# symlink into sites-enabled, validate, reload
install_nginx_confs() {
    local sites="${NGINX_SITES_DIR:-/etc/nginx/sites-enabled}"
    if [ ! -d "$sites" ]; then
        echo -e "${YELLOW}$sites not found — copy proxy-generator/confs/ into your NGINX setup manually.${NC}"
        return 0
    fi
    local -a privileged=()
    [ -w "$sites" ] || privileged=(sudo)
    local f base
    for f in "$SCRIPT_DIR"/proxy-generator/confs/*.conf; do
        [ -e "$f" ] || continue
        base=$(basename "$f")
        [ "$base" = "example.conf" ] && continue
        "${privileged[@]}" ln -sf "$f" "$sites/$base"
    done
    echo -e "${GREEN}Symlinked confs into $sites${NC}"
    if [ -z "$NGINX_SITES_DIR" ]; then
        if sudo nginx -t && sudo systemctl reload nginx; then
            echo -e "${GREEN}✅ NGINX reloaded${NC}"
        else
            echo -e "${RED}NGINX reload failed. Check the configuration above.${NC}"
        fi
    else
        echo -e "${YELLOW}(custom NGINX_SITES_DIR — reload NGINX yourself)${NC}"
    fi
}

# Generate the Caddyfile (and, for Docker deployments, the labels override)
generate_caddy_configs() {
    echo -e "${YELLOW}Generating Caddy configurations...${NC}"
    ensure_config || return 1

    if [ "$DEPLOY_MODE" = "docker" ]; then
        # Full output (Caddyfile + labels override) via the one-shot container —
        # works without Node.js on the host, and the override is exactly what a
        # Docker deployment needs
        if (cd "$SCRIPT_DIR" && docker compose run --rm caddy-generator </dev/null); then
            echo -e "${GREEN}✅ Caddy configuration generated (Caddyfile + docker-compose.override.yml)${NC}"
            print_caddy_next_steps
        else
            echo -e "${RED}❌ Failed to generate Caddy configurations${NC}"
        fi
        return
    fi

    if [ ! -d "$SCRIPT_DIR/proxy-generator" ]; then
        echo -e "${RED}Error: proxy-generator directory not found${NC}"
        return 1
    fi

    echo -e "${BLUE}Generating Caddy configuration files...${NC}"
    # Nothing here needs sudo: the generator only writes files in
    # proxy-generator/ — Caddy picks them up itself. This path runs the
    # wake proxy via SystemD/PM2, so only the Caddyfile is needed (the
    # compose labels override is for Docker deployments).
    if (cd "$SCRIPT_DIR/proxy-generator" && { [ -d node_modules ] || npm install; } && npm run caddy -- --caddyfile-only); then
        echo -e "${GREEN}✅ Caddy configuration generated: $SCRIPT_DIR/proxy-generator/Caddyfile${NC}"
        print_caddy_next_steps
    else
        echo -e "${RED}❌ Failed to generate Caddy configurations${NC}"
        echo -e "${YELLOW}Please check your config.json file and try again${NC}"
    fi
}

# Turn examples/caddy-docker-proxy.yml into a ready-to-run stack with the
# generated Caddyfile already mounted (the two "B)" lines uncommented).
# Prints the path of the written file.
write_caddy_stack() {
    local example="$SCRIPT_DIR/examples/caddy-docker-proxy.yml"
    local out="$SCRIPT_DIR/proxy-generator/caddy-stack.yml"
    [ -f "$example" ] || { echo -e "${RED}$example not found${NC}" >&2; return 1; }
    if [ "$DEPLOY_MODE" = "docker" ]; then
        # Docker deployment: the labels override feeds Caddy, no base Caddyfile
        {
            echo "# Written by setup-service.sh from examples/caddy-docker-proxy.yml."
            echo "# The DockerWakeUp sites reach Caddy via labels on the docker-wakeup container."
            cat "$example"
        } > "$out"
    else
        # SystemD/PM2: enable the base-Caddyfile lines with the real path
        {
            echo "# Written by setup-service.sh from examples/caddy-docker-proxy.yml with the"
            echo "# DockerWakeUp Caddyfile already mounted. Safe to edit; re-running the script overwrites it."
            sed -e 's|label). The two CADDY_DOCKER_CADDYFILE_PATH lines below must be enabled|label). The two CADDY_DOCKER_CADDYFILE_PATH lines below are already enabled|' \
                -e 's|^      # - CADDY_DOCKER_CADDYFILE_PATH=|      - CADDY_DOCKER_CADDYFILE_PATH=|' \
                -e "s|^      # - /path/to/DockerWakeUp/proxy-generator/Caddyfile:|      - $SCRIPT_DIR/proxy-generator/Caddyfile:|" \
                "$example"
        } > "$out"
    fi
    echo "$out"
}

# Print what the user still has to do by hand for Caddy — short enough to
# follow without the README. Asks whether a Caddy already exists because the
# two cases need different things.
print_caddy_next_steps() {
    local caddyfile="$SCRIPT_DIR/proxy-generator/Caddyfile"
    local port have_caddy
    port=$(config_proxy_port)
    echo ""
    read -r -p "Do you already have Caddy / caddy-docker-proxy running on this machine? (y/N): " have_caddy || have_caddy=""
    echo ""
    if [[ "$have_caddy" =~ ^[Yy] ]]; then
        local subnet
        subnet=$(docker network inspect caddy -f '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || true)
        echo -e "${BLUE}Caddy is already running — here's what's left to do:${NC}"
        echo ""
        echo -e "${YELLOW}1. Let Caddy reach the wake proxy on this host (port $port).${NC}"
        echo "   caddy-docker-proxy — add to your caddy service, then recreate it (docker compose up -d):"
        echo "       extra_hosts:"
        echo "         - \"host.docker.internal:host-gateway\""
        if systemctl is-active --quiet ufw 2>/dev/null; then
            echo "   ufw is ACTIVE on this machine: containers on a bridge network cannot reach host"
            echo "   ports until you allow the wake proxy port from your Caddy network:"
            echo "       sudo ufw allow from ${subnet:-172.16.0.0/12} to any port $port proto tcp"
            [ -n "$subnet" ] && echo "       (${subnet} is the subnet of the 'caddy' network — adjust if yours is named differently)"
        else
            echo "   If a firewall filters Docker → host traffic, allow port $port from your Caddy network"
            echo "   (ufw example: sudo ufw allow from ${subnet:-172.16.0.0/12} to any port $port proto tcp)."
        fi
        local netname="bridge"
        [ -n "$subnet" ] && netname="caddy"
        echo "   Self-test once the wake proxy runs — prints JSON when Caddy will be able to reach it:"
        echo "       docker run --rm --network $netname --add-host host.docker.internal:host-gateway alpine wget -qO- http://host.docker.internal:$port/healthz"
        echo "   (No firewall rule needed if your Caddy runs with network_mode: host — then map"
        echo "    host.docker.internal to 127.0.0.1 with extra_hosts instead, see examples/caddy-docker-proxy.yml.)"
        echo ""
        if [ "$DEPLOY_MODE" = "docker" ]; then
            echo -e "${YELLOW}2. That's the plumbing — the sites themselves need nothing:${NC} the generated"
            echo "   docker-compose.override.yml puts labels on the docker-wakeup container and"
            echo "   caddy-docker-proxy picks them up automatically."
        else
            echo -e "${YELLOW}2. Hand Caddy the generated sites.${NC}"
            echo "   caddy-docker-proxy — add to your caddy service, then recreate it:"
            echo "       environment:"
            echo "         - CADDY_DOCKER_CADDYFILE_PATH=/etc/caddy/docker-wakeup.Caddyfile"
            echo "       volumes:"
            echo "         - $caddyfile:/etc/caddy/docker-wakeup.Caddyfile:ro"
            echo "   Plain Caddy on the host — add to /etc/caddy/Caddyfile:"
            echo "       import $caddyfile"
            echo "     set \"caddyUpstream\": \"127.0.0.1:$port\" in config.json, re-run this script, then: sudo systemctl reload caddy"
        fi
        echo ""
        echo -e "${YELLOW}3. Remove the caddy.* labels from the services DockerWakeUp now manages.${NC}"
        echo "   Otherwise the hostname has two owners, and the site disappears whenever"
        echo "   idle shutdown stops the container — exactly when it should wake it."
        echo ""
        echo -e "${YELLOW}4. Make sure each of those services publishes its port on this host, e.g.${NC}"
        echo "       ports:"
        echo "         - \"127.0.0.1:8096:8096\""
        echo "   so the \"target\" in config.json (http://localhost:8096) is reachable."
        echo ""
    else
        local stack
        stack=$(write_caddy_stack) || return 0
        echo -e "${BLUE}No Caddy yet — a ready-to-run caddy-docker-proxy stack was written to:${NC}"
        echo "   $stack"
        if [ "$DEPLOY_MODE" = "docker" ]; then
            echo "   (it picks the sites up from the docker-wakeup container's labels — nothing to edit)"
        else
            echo "   (the DockerWakeUp Caddyfile is already mounted; nothing to edit)"
        fi
        echo ""
        echo -e "${YELLOW}1. Start it — it binds ports 80 and 443 on this host, so they must be free (no NGINX):${NC}"
        echo "       mkdir -p ~/caddy && cp $stack ~/caddy/docker-compose.yml"
        echo "       docker network create caddy"
        echo "       docker compose -f ~/caddy/docker-compose.yml up -d"
        echo ""
        echo -e "${YELLOW}2. Point DNS at this server:${NC} an A record for *.yourdomain (or one per subdomain)."
        echo "   Caddy obtains the HTTPS certificates itself — no certbot needed."
        echo ""
        echo -e "${YELLOW}3. Your services must publish their ports on this host${NC} (the \"target\" in"
        echo "   config.json, e.g. http://localhost:8096). Binding to 127.0.0.1 keeps them private."
        echo ""
    fi
    if [ "$DEPLOY_MODE" = "docker" ]; then
        echo "After editing config.json: re-run this script, or: docker compose run --rm caddy-generator && docker compose up -d"
    else
        echo "After editing config.json: re-run this script (or: cd proxy-generator && npm run caddy)."
        echo "caddy-docker-proxy re-reads the Caddyfile by itself; plain Caddy needs: sudo systemctl reload caddy"
        echo "(Upgrading? The config relies on host-based routing — restart an older docker-wakeup first.)"
    fi
}

# Generate the Traefik file-provider configuration
generate_traefik_configs() {
    echo -e "${YELLOW}Generating Traefik configuration...${NC}"
    ensure_config || return 1

    if [ "$DEPLOY_MODE" = "docker" ] && ! command -v npm >/dev/null 2>&1; then
        if ! (cd "$SCRIPT_DIR" && WAKEUP_PROXY=traefik docker compose run --rm caddy-generator </dev/null); then
            echo -e "${RED}❌ Failed to generate Traefik configuration${NC}"
            return 1
        fi
    elif ! (cd "$SCRIPT_DIR/proxy-generator" && { [ -d node_modules ] || npm install; } && npm run traefik); then
        echo -e "${RED}❌ Failed to generate Traefik configuration${NC}"
        return 1
    fi
    echo -e "${GREEN}✅ Traefik configuration generated: $SCRIPT_DIR/proxy-generator/traefik-dynamic.yml${NC}"
    print_traefik_next_steps
}

# What's left to do by hand for Traefik — short enough to skip the README
print_traefik_next_steps() {
    local dyn="$SCRIPT_DIR/proxy-generator/traefik-dynamic.yml"
    local port have_traefik
    port=$(config_proxy_port)
    echo ""
    read -r -p "Do you already have Traefik running on this machine? (y/N): " have_traefik || have_traefik=""
    echo ""
    if [[ "$have_traefik" =~ ^[Yy] ]]; then
        echo -e "${BLUE}Traefik is already running — here's what's left to do:${NC}"
        echo ""
        echo -e "${YELLOW}1. Hand Traefik the generated file.${NC} Mount it and enable the file provider:"
        echo "       volumes:"
        echo "         - $dyn:/etc/traefik/docker-wakeup.yml:ro"
        echo "       command (or static config):"
        echo "         - --providers.file.filename=/etc/traefik/docker-wakeup.yml"
        echo "         - --providers.file.watch=true"
        echo "   Already using a file provider directory? Just copy/mount the file into it."
        echo "   If your entrypoint isn't called 'websecure', set \"traefikEntrypoint\" in config.json;"
        echo "   if your routers need a certresolver, set \"traefikCertResolver\". Re-run after changes."
        echo ""
        echo -e "${YELLOW}2. Let Traefik reach the wake proxy on this host (port $port).${NC}"
        echo "   Bridge-network Traefik: extra_hosts \"host.docker.internal:host-gateway\" AND a"
        echo "   firewall rule (ufw blocks bridge→host traffic — rule + self-test in the README's"
        echo "   'Works With Any Reverse Proxy' section). Host-network Traefik: extra_hosts"
        echo "   \"host.docker.internal:127.0.0.1\" (or set \"traefikUpstream\": \"127.0.0.1:$port\")."
        echo ""
        echo -e "${YELLOW}3. Remove traefik router labels from the services DockerWakeUp now manages${NC}"
        echo "   (one hostname, one owner — and labels vanish when idle shutdown stops the container)."
        echo ""
        echo -e "${YELLOW}4. Make sure each managed service publishes its port on this host${NC} (the"
        echo "   \"target\" in config.json), e.g. ports: [\"127.0.0.1:8096:8096\"]."
    else
        echo -e "${BLUE}No Traefik yet — a ready-to-run stack is in examples/traefik.yml:${NC}"
        echo ""
        echo -e "${YELLOW}1. Copy it, fix the volume path to $dyn,${NC}"
        echo "   and set your ACME email, then (ports 80/443 must be free):"
        echo "       mkdir -p ~/traefik && cp $SCRIPT_DIR/examples/traefik.yml ~/traefik/docker-compose.yml"
        echo "       nano ~/traefik/docker-compose.yml"
        echo "       docker compose -f ~/traefik/docker-compose.yml up -d"
        echo ""
        echo -e "${YELLOW}2. Point DNS at this server${NC} (A records for the subdomains, or a wildcard)."
        echo "   The stack gets certificates itself via Let's Encrypt (HTTP challenge)."
        echo ""
        echo -e "${YELLOW}3. Your services must publish their ports on this host${NC} (the \"target\" in config.json)."
    fi
    echo ""
    if [ "$DEPLOY_MODE" = "docker" ]; then
        echo "After editing config.json: re-run this script, or: WAKEUP_PROXY=traefik docker compose run --rm caddy-generator"
    else
        echo "After editing config.json: re-run this script (or: cd proxy-generator && npm run traefik)."
    fi
    echo "Traefik re-reads the file automatically (providers.file.watch)."
}

# Ask which reverse proxy fronts the wake proxy and generate its configs
generate_proxy_configs() {
    local proxy_choice
    echo ""
    echo "Which reverse proxy do you use in front of DockerWakeUp?"
    echo "1) NGINX (default)"
    echo "2) Caddy / caddy-docker-proxy"
    echo "3) Traefik"
    echo "4) Skip reverse proxy config generation"
    read -r -p "Enter your choice (1-4) [1]: " proxy_choice
    case "${proxy_choice:-1}" in
        1) PROXY_CHOICE="nginx"; generate_nginx_configs ;;
        2) PROXY_CHOICE="caddy"; generate_caddy_configs ;;
        3) PROXY_CHOICE="traefik"; generate_traefik_configs ;;
        4) PROXY_CHOICE="none"; echo -e "${YELLOW}Skipping reverse proxy config generation${NC}" ;;
        *) echo -e "${RED}Invalid choice, defaulting to NGINX${NC}"; PROXY_CHOICE="nginx"; generate_nginx_configs ;;
    esac
}

# ---------------------------------------------------------------------------
# The menu
# ---------------------------------------------------------------------------

# Report the git status computed by git_update_status. Prints "1" when an
# update should be offered as a menu option.
print_git_status() {
    case "$GIT_STATUS" in
        latest)
            echo -e "${GREEN}You are already on the latest version of the code.${NC}" >&2
            ;;
        behind)
            echo -e "${YELLOW}Your local code is behind the canonical remote. You should update to the latest version!${NC}" >&2
            echo 1
            ;;
        ahead)
            echo -e "${YELLOW}Your local code is ahead of the canonical remote. (Local changes not pushed)${NC}" >&2
            ;;
        diverged)
            echo -e "${RED}Your local and canonical remote branches have diverged. Please resolve manually.${NC}" >&2
            echo 1
            ;;
        offline)
            echo -e "${YELLOW}Could not reach GitHub to check for updates — continuing with the local code.${NC}" >&2
            ;;
    esac
}

# The "what to do now" summary printed after a successful menu action
print_next_steps() {
    local service_hint
    echo ""
    echo -e "${GREEN}Setup completed!${NC}"
    echo -e "${YELLOW}Next steps:${NC}"
    if [ "$SERVICE_SETUP" = "docker" ]; then
        service_hint="The docker-wakeup container is running — manage it with docker compose"
    elif [ -n "$SERVICE_SETUP" ]; then
        service_hint="Your wake-proxy service should now be running!"
    else
        service_hint="Start the wake proxy: re-run this script with option 1 or 2 (or: cd wake-proxy && npm start)"
    fi

    if [ ! -f "$SCRIPT_DIR/config.json" ] || { [ -f "$SCRIPT_DIR/config.json.example" ] && cmp -s "$SCRIPT_DIR/config.json" "$SCRIPT_DIR/config.json.example"; }; then
        echo "1. ⚠️  IMPORTANT: Edit config.json with your actual service details"
        if [ "$PROXY_CHOICE" = "caddy" ]; then
            echo "2. Re-run the script or manually regenerate: cd proxy-generator && npm run caddy   (or npm run traefik)"
            echo "3. Follow the steps printed above"
        else
            echo "2. Re-run the script or manually generate NGINX configs: cd proxy-generator && npm run nginx"
            echo "   (the generator symlinks and reloads NGINX by itself)"
        fi
    elif [ "$PROXY_CHOICE" = "caddy" ]; then
        echo "1. ✅ Caddy configuration generated: proxy-generator/Caddyfile"
        echo "2. Follow the Caddy steps printed above (details: README → Caddy Generator)"
        echo "3. $service_hint"
    elif [ "$PROXY_CHOICE" = "traefik" ]; then
        echo "1. ✅ Traefik configuration generated: proxy-generator/traefik-dynamic.yml"
        echo "2. Follow the Traefik steps printed above"
        echo "3. $service_hint"
    elif [ "$PROXY_CHOICE" = "none" ]; then
        echo "1. ⏭️  Reverse proxy config generation was skipped"
        echo "2. Generate later with: cd proxy-generator && npm run nginx  (or npm run caddy)"
        echo "3. $service_hint"
    else
        echo "1. ✅ NGINX configurations generated, symlinked and NGINX reloaded"
        echo "2. Nothing else to do for routing — set up SSL once if you haven't (see README)"
        echo "3. $service_hint"
    fi

    echo ""
    echo -e "${BLUE}Useful commands:${NC}"
    if [ "$SERVICE_SETUP" = "docker" ]; then
        echo "• Check status: docker compose ps"
        echo "• View logs: docker logs -f docker-wakeup"
        echo "• Apply config/code changes: docker compose up -d --build"
    else
        echo "• Check service status: sudo systemctl status docker-wakeup"
        echo "• View logs: sudo journalctl -u docker-wakeup -f"
        echo "• Restart service: sudo systemctl restart docker-wakeup"
    fi
}

main() {
    set -e

    echo -e "${BLUE}Docker Wake-Up Service Setup${NC}"
    echo "================================"

    # Don't run as root for systemd setup — sudo is used where needed
    if is_root && [[ "$1" != "--pm2" ]]; then
        echo -e "${RED}Error: Don't run this script as root for systemd setup${NC}"
        echo "Run as your regular user, we'll use sudo when needed"
        exit 1
    fi

    git_update_status
    local git_update_option choice
    git_update_option=$(print_git_status)

    echo "How do you want to run DockerWakeUp?"
    echo "1) Docker container + reverse proxy configs (easiest — no Node.js needed)"
    echo "2) SystemD service + reverse proxy configs (runs on the host via Node.js)"
    echo "3) PM2 process manager + reverse proxy configs"
    echo "4) Generate reverse proxy configs only (NGINX, Caddy or Traefik)"
    echo "5) Build project only (no service setup)"
    echo "6) Exit"
    if [ "$git_update_option" = "1" ]; then
        echo "7) Update to latest version from GitHub"
        echo ""
        read -r -p "Enter your choice (1-7): " choice
    else
        echo ""
        read -r -p "Enter your choice (1-6): " choice
    fi

    case "$choice" in
        1)
            DEPLOY_MODE="docker"
            setup_docker
            ;;
        2)
            build_project
            generate_proxy_configs
            setup_systemd
            SERVICE_SETUP=1
            ;;
        3)
            build_project
            generate_proxy_configs
            setup_pm2
            SERVICE_SETUP=1
            ;;
        4)
            generate_proxy_configs
            ;;
        5)
            build_project
            ;;
        6)
            echo -e "${GREEN}Exiting...${NC}"
            exit 0
            ;;
        7)
            update_from_git
            ;;
        *)
            echo -e "${RED}Invalid choice. Please run the script again.${NC}"
            exit 1
            ;;
    esac

    print_next_steps
}

# Run the menu only when executed, not when sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
