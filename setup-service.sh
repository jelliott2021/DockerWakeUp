#!/bin/bash

# Docker Wake-Up Service Setup Script
# This script helps set up the wake-proxy as a system service

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color


# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        # Function to check and update to latest git version from canonical remote
        update_from_git() {
            CANONICAL_REMOTE="https://github.com/jelliott2021/DockerWakeUp.git"
            if [ -d "$SCRIPT_DIR/.git" ]; then
                echo -e "${YELLOW}Checking for latest code from canonical git remote...${NC}"
                cd "$SCRIPT_DIR"
                git fetch "$CANONICAL_REMOTE" HEAD:refs/remotes/origin-upstream 2>/dev/null
                LOCAL=$(git rev-parse HEAD)
                REMOTE=$(git rev-parse refs/remotes/origin-upstream)
                BASE=$(git merge-base HEAD refs/remotes/origin-upstream)
                if [ "$LOCAL" = "$REMOTE" ]; then
                    echo -e "${GREEN}You are already on the latest version of the code.${NC}"
                elif [ "$LOCAL" = "$BASE" ]; then
                    echo -e "${YELLOW}Your local code is behind the canonical remote. Updating now...${NC}"
                    git pull "$CANONICAL_REMOTE" HEAD
                    echo -e "${GREEN}Code updated. Please re-run this script if you want to continue setup.${NC}"
                    exit 0
                elif [ "$REMOTE" = "$BASE" ]; then
                    echo -e "${YELLOW}Your local code is ahead of the canonical remote. (Local changes not pushed)${NC}"
                else
                    echo -e "${RED}Your local and canonical remote branches have diverged. Please resolve manually.${NC}"
                    exit 1
                fi
                cd "$SCRIPT_DIR"
            else
                echo -e "${RED}Not a git repository. Cannot update from remote.${NC}"
            fi
        }
WAKE_PROXY_DIR="$SCRIPT_DIR/wake-proxy"



echo -e "${BLUE}Docker Wake-Up Service Setup${NC}"
echo "================================"

# Check if running as root for systemd setup
if [[ $EUID -eq 0 ]] && [[ "$1" != "--pm2" ]]; then
   echo -e "${RED}Error: Don't run this script as root for systemd setup${NC}"
   echo "Run as your regular user, we'll use sudo when needed"
   exit 1
fi

# Function to setup systemd service
setup_systemd() {
    echo -e "${YELLOW}Setting up SystemD service...${NC}"
    
    # Get current user and directory
    CURRENT_USER=$(whoami)
    CURRENT_DIR=$(pwd)
    
    # Check if wake-proxy is built
    if [ ! -f "$WAKE_PROXY_DIR/dist/wake-proxy.js" ]; then
        echo -e "${YELLOW}Building wake-proxy...${NC}"
        cd "$WAKE_PROXY_DIR"
        npm run build
        cd "$CURRENT_DIR"
    fi
    
    # Create service file with correct paths
    SERVICE_FILE="/tmp/docker-wakeup.service"
    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Docker Wake-Up Proxy
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$CURRENT_USER
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

    # Install service file
    sudo cp "$SERVICE_FILE" /etc/systemd/system/docker-wakeup.service
    sudo systemctl daemon-reload
    
    echo -e "${GREEN}SystemD service created successfully!${NC}"
    echo ""
    read -p "Enable auto-start on boot and (re)start docker-wakeup now? (Y/n): " start_now
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

# Function to setup PM2 service
setup_pm2() {
    echo -e "${YELLOW}Setting up PM2 service...${NC}"
    
    # Check if PM2 is installed
    if ! command -v pm2 &> /dev/null; then
        echo -e "${YELLOW}Installing PM2...${NC}"
        npm install -g pm2
    fi
    
    # Check if wake-proxy is built
    if [ ! -f "$WAKE_PROXY_DIR/dist/wake-proxy.js" ]; then
        echo -e "${YELLOW}Building wake-proxy...${NC}"
        cd "$WAKE_PROXY_DIR"
        npm run build
        cd "$SCRIPT_DIR"
    fi
    
    # Create PM2 ecosystem file
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

    # Create logs directory
    mkdir -p "$SCRIPT_DIR/logs"
    
    # Start with PM2
    pm2 start ecosystem.config.js
    pm2 save
    
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

# Function to build dependencies
build_project() {
    echo -e "${YELLOW}Building project dependencies...${NC}"
    
    # Build wake-proxy
    if [ -d "$WAKE_PROXY_DIR" ]; then
        echo -e "${BLUE}Building wake-proxy...${NC}"
        cd "$WAKE_PROXY_DIR"
        npm install
        npm run build
        cd "$SCRIPT_DIR"
    fi
    
    # Build proxy-generator (NGINX + Caddy config generation)
    if [ -d "$SCRIPT_DIR/proxy-generator" ]; then
        echo -e "${BLUE}Building proxy-generator...${NC}"
        cd "$SCRIPT_DIR/proxy-generator"
        npm install
        cd "$SCRIPT_DIR"
    fi
    
    echo -e "${GREEN}Build completed!${NC}"
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

# Function to generate NGINX configurations
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
        (cd "$SCRIPT_DIR" && WAKEUP_PROXY=nginx docker compose run --rm caddy-generator </dev/null)
        if [ $? -ne 0 ]; then
            echo -e "${RED}❌ Failed to generate NGINX configurations${NC}"
            return 1
        fi
        install_nginx_confs
    else
        echo -e "${BLUE}Generating NGINX configuration files...${NC}"
        cd "$SCRIPT_DIR/proxy-generator"
        [ -d node_modules ] || npm install
        # Run as the regular user — the generator uses sudo itself only for
        # the symlink/reload steps, so conf files stay user-owned
        npm run nginx

        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ NGINX configurations generated successfully!${NC}"
            echo -e "${YELLOW}Note: the confs rely on the wake proxy's host-based routing — if an older${NC}"
            echo -e "${YELLOW}build of docker-wakeup is still running, restart it: sudo systemctl restart docker-wakeup${NC}"
        else
            echo -e "${RED}❌ Failed to generate NGINX configurations${NC}"
            echo -e "${YELLOW}Please check your config.json file and try again${NC}"
        fi
        cd "$SCRIPT_DIR"
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
    local SUDO="sudo"; [ -w "$sites" ] && SUDO=""
    local f base
    for f in "$SCRIPT_DIR"/proxy-generator/confs/*.conf; do
        [ -e "$f" ] || continue
        base=$(basename "$f")
        [ "$base" = "example.conf" ] && continue
        $SUDO ln -sf "$f" "$sites/$base"
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

# Function to generate Caddy / caddy-docker-proxy configurations
generate_caddy_configs() {
    echo -e "${YELLOW}Generating Caddy configurations...${NC}"
    ensure_config || return 1

    if [ "$DEPLOY_MODE" = "docker" ]; then
        # Full output (Caddyfile + labels override) via the one-shot container —
        # works without Node.js on the host, and the override is exactly what a
        # Docker deployment needs
        (cd "$SCRIPT_DIR" && docker compose run --rm caddy-generator </dev/null)
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ Caddy configuration generated (Caddyfile + docker-compose.override.yml)${NC}"
            print_caddy_next_steps
        else
            echo -e "${RED}❌ Failed to generate Caddy configurations${NC}"
        fi
        return
    fi

    if [ -d "$SCRIPT_DIR/proxy-generator" ]; then
        echo -e "${BLUE}Generating Caddy configuration files...${NC}"
        cd "$SCRIPT_DIR/proxy-generator"
        [ -d node_modules ] || npm install
        # Nothing here needs sudo: the generator only writes files in
        # proxy-generator/ — Caddy picks them up itself. This path runs the
        # wake proxy via SystemD/PM2, so only the Caddyfile is needed (the
        # compose labels override is for Docker deployments).
        npm run caddy -- --caddyfile-only

        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ Caddy configuration generated: $SCRIPT_DIR/proxy-generator/Caddyfile${NC}"
            cd "$SCRIPT_DIR"
            print_caddy_next_steps
        else
            echo -e "${RED}❌ Failed to generate Caddy configurations${NC}"
            echo -e "${YELLOW}Please check your config.json file and try again${NC}"
        fi

        cd "$SCRIPT_DIR"
    else
        echo -e "${RED}Error: proxy-generator directory not found${NC}"
        return 1
    fi
}

# Turn examples/caddy-docker-proxy.yml into a ready-to-run stack with the
# generated Caddyfile already mounted (the two "B)" lines uncommented)
write_caddy_stack() {
    local example="$SCRIPT_DIR/examples/caddy-docker-proxy.yml"
    local out="$SCRIPT_DIR/proxy-generator/caddy-stack.yml"
    [ -f "$example" ] || { echo -e "${RED}$example not found${NC}"; return 1; }
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
    local port
    port=$(sed -n 's/.*"proxyPort"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$SCRIPT_DIR/config.json" | head -1)
    port=${port:-8080}
    echo ""
    read -p "Do you already have Caddy / caddy-docker-proxy running on this machine? (y/N): " have_caddy || have_caddy=""
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
        local netname="bridge"; [ -n "$subnet" ] && netname="caddy"
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

    local port i
    port=$(sed -n 's/.*"proxyPort"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$SCRIPT_DIR/config.json" | head -1)
    port=${port:-8080}
    for i in 1 2 3 4 5 6 7 8 9 10; do
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

# Function to generate Traefik configuration (file provider)
generate_traefik_configs() {
    echo -e "${YELLOW}Generating Traefik configuration...${NC}"
    ensure_config || return 1

    if [ "$DEPLOY_MODE" = "docker" ] && ! command -v npm >/dev/null 2>&1; then
        (cd "$SCRIPT_DIR" && WAKEUP_PROXY=traefik docker compose run --rm caddy-generator </dev/null)
        [ $? -eq 0 ] || { echo -e "${RED}❌ Failed to generate Traefik configuration${NC}"; return 1; }
    else
        cd "$SCRIPT_DIR/proxy-generator"
        [ -d node_modules ] || npm install
        npm run traefik || { echo -e "${RED}❌ Failed to generate Traefik configuration${NC}"; cd "$SCRIPT_DIR"; return 1; }
        cd "$SCRIPT_DIR"
    fi
    echo -e "${GREEN}✅ Traefik configuration generated: $SCRIPT_DIR/proxy-generator/traefik-dynamic.yml${NC}"
    print_traefik_next_steps
}

# What's left to do by hand for Traefik — short enough to skip the README
print_traefik_next_steps() {
    local dyn="$SCRIPT_DIR/proxy-generator/traefik-dynamic.yml"
    local port
    port=$(sed -n 's/.*"proxyPort"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$SCRIPT_DIR/config.json" | head -1)
    port=${port:-8080}
    echo ""
    read -p "Do you already have Traefik running on this machine? (y/N): " have_traefik || have_traefik=""
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
DEPLOY_MODE="host"
PROXY_CHOICE="nginx"
generate_proxy_configs() {
    echo ""
    echo "Which reverse proxy do you use in front of DockerWakeUp?"
    echo "1) NGINX (default)"
    echo "2) Caddy / caddy-docker-proxy"
    echo "3) Traefik"
    echo "4) Skip reverse proxy config generation"
    read -p "Enter your choice (1-4) [1]: " proxy_choice
    case "${proxy_choice:-1}" in
        1) PROXY_CHOICE="nginx"; generate_nginx_configs ;;
        2) PROXY_CHOICE="caddy"; generate_caddy_configs ;;
        3) PROXY_CHOICE="traefik"; generate_traefik_configs ;;
        4) PROXY_CHOICE="none"; echo -e "${YELLOW}Skipping reverse proxy config generation${NC}" ;;
        *) echo -e "${RED}Invalid choice, defaulting to NGINX${NC}"; PROXY_CHOICE="nginx"; generate_nginx_configs ;;
    esac
}


# --- Git update check before menu ---
CANONICAL_REMOTE="https://github.com/jelliott2021/DockerWakeUp.git"
GIT_UPDATE_OPTION=""
GIT_UP_TO_DATE=true
if [ -d "$SCRIPT_DIR/.git" ]; then
    git fetch "$CANONICAL_REMOTE" HEAD:refs/remotes/origin-upstream 2>/dev/null
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse refs/remotes/origin-upstream)
    BASE=$(git merge-base HEAD refs/remotes/origin-upstream)
    if [ "$LOCAL" = "$REMOTE" ]; then
        echo -e "${GREEN}You are already on the latest version of the code.${NC}"
    elif [ "$LOCAL" = "$BASE" ]; then
        echo -e "${YELLOW}Your local code is behind the canonical remote. You should update to the latest version!${NC}"
        GIT_UPDATE_OPTION=1
        GIT_UP_TO_DATE=false
    elif [ "$REMOTE" = "$BASE" ]; then
        echo -e "${YELLOW}Your local code is ahead of the canonical remote. (Local changes not pushed)${NC}"
    else
        echo -e "${RED}Your local and canonical remote branches have diverged. Please resolve manually.${NC}"
        GIT_UPDATE_OPTION=1
        GIT_UP_TO_DATE=false
    fi
fi

echo "How do you want to run DockerWakeUp?"
echo "1) Docker container + reverse proxy configs (easiest — no Node.js needed)"
echo "2) SystemD service + reverse proxy configs (runs on the host via Node.js)"
echo "3) PM2 process manager + reverse proxy configs"
echo "4) Generate reverse proxy configs only (NGINX, Caddy or Traefik)"
echo "5) Build project only (no service setup)"
echo "6) Exit"
if [ "$GIT_UPDATE_OPTION" = "1" ]; then
    echo "7) Update to latest version from GitHub"
    echo ""
    read -p "Enter your choice (1-7): " choice
else
    echo ""
    read -p "Enter your choice (1-6): " choice
fi

case $choice in
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

echo ""
echo -e "${GREEN}Setup completed!${NC}"
echo -e "${YELLOW}Next steps:${NC}"
if [ "$SERVICE_SETUP" = "docker" ]; then
    SERVICE_HINT="The docker-wakeup container is running — manage it with docker compose"
elif [ -n "$SERVICE_SETUP" ]; then
    SERVICE_HINT="Your wake-proxy service should now be running!"
else
    SERVICE_HINT="Start the wake proxy: re-run this script with option 1 or 2 (or: cd wake-proxy && npm start)"
fi

if [ ! -f "$SCRIPT_DIR/config.json" ] || [ -f "$SCRIPT_DIR/config.json.example" ] && cmp -s "$SCRIPT_DIR/config.json" "$SCRIPT_DIR/config.json.example"; then
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
    echo "3. $SERVICE_HINT"
elif [ "$PROXY_CHOICE" = "traefik" ]; then
    echo "1. ✅ Traefik configuration generated: proxy-generator/traefik-dynamic.yml"
    echo "2. Follow the Traefik steps printed above"
    echo "3. $SERVICE_HINT"
elif [ "$PROXY_CHOICE" = "none" ]; then
    echo "1. ⏭️  Reverse proxy config generation was skipped"
    echo "2. Generate later with: cd proxy-generator && npm run nginx  (or npm run caddy)"
    echo "3. $SERVICE_HINT"
else
    echo "1. ✅ NGINX configurations generated, symlinked and NGINX reloaded"
    echo "2. Nothing else to do for routing — set up SSL once if you haven't (see README)"
    echo "3. $SERVICE_HINT"
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
