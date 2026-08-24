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
    
    # Build nginx-generator
    if [ -d "$SCRIPT_DIR/nginx-generator" ]; then
        echo -e "${BLUE}Building nginx-generator...${NC}"
        cd "$SCRIPT_DIR/nginx-generator"
        npm install
        cd "$SCRIPT_DIR"
    fi

    # Build caddy-generator
    if [ -d "$SCRIPT_DIR/caddy-generator" ]; then
        echo -e "${BLUE}Building caddy-generator...${NC}"
        cd "$SCRIPT_DIR/caddy-generator"
        npm install
        cd "$SCRIPT_DIR"
    fi
    
    echo -e "${GREEN}Build completed!${NC}"
}

# Function to generate NGINX configurations
generate_nginx_configs() {
    echo -e "${YELLOW}Generating NGINX configurations...${NC}"
    
    # Check if config.json exists
    if [ ! -f "$SCRIPT_DIR/config.json" ]; then
        echo -e "${YELLOW}config.json not found. Creating from example...${NC}"
        if [ -f "$SCRIPT_DIR/config.json.example" ]; then
            cp "$SCRIPT_DIR/config.json.example" "$SCRIPT_DIR/config.json"
            echo -e "${RED}⚠️  Please edit config.json with your actual service details before the NGINX configs will work properly!${NC}"
        else
            echo -e "${RED}Error: No config.json.example found. Please create config.json manually.${NC}"
            return 1
        fi
    fi
    
    # Generate NGINX configurations
    if [ -d "$SCRIPT_DIR/nginx-generator" ]; then
        echo -e "${BLUE}Generating NGINX configuration files...${NC}"
        cd "$SCRIPT_DIR/nginx-generator"
        # Run as the regular user — the generator uses sudo itself only for
        # the symlink/reload steps, so conf files stay user-owned
        npm run generate
        
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ NGINX configurations generated successfully!${NC}"
            echo -e "${BLUE}Generated configs are in: $SCRIPT_DIR/nginx-generator/confs/${NC}"
            
            # Check if we can create symlinks
            if [ -d "/etc/nginx/sites-enabled" ]; then
                echo -e "${YELLOW}Note: Symlinks to /etc/nginx/sites-enabled/ may require manual sudo access${NC}"
                echo -e "${YELLOW}To activate the configs, run: sudo systemctl reload nginx${NC}"
            else
                echo -e "${YELLOW}Note: /etc/nginx/sites-enabled not found. You may need to manually copy configs to your NGINX setup.${NC}"
            fi
        else
            echo -e "${RED}❌ Failed to generate NGINX configurations${NC}"
            echo -e "${YELLOW}Please check your config.json file and try again${NC}"
        fi
        
        cd "$SCRIPT_DIR"
    else
        echo -e "${RED}Error: nginx-generator directory not found${NC}"
        return 1
    fi
}

# Function to generate Caddy / caddy-docker-proxy configurations
generate_caddy_configs() {
    echo -e "${YELLOW}Generating Caddy configurations...${NC}"

    # Check if config.json exists
    if [ ! -f "$SCRIPT_DIR/config.json" ]; then
        echo -e "${YELLOW}config.json not found. Creating from example...${NC}"
        if [ -f "$SCRIPT_DIR/config.json.example" ]; then
            cp "$SCRIPT_DIR/config.json.example" "$SCRIPT_DIR/config.json"
            echo -e "${RED}⚠️  Please edit config.json with your actual service details before the Caddy configs will work properly!${NC}"
        else
            echo -e "${RED}Error: No config.json.example found. Please create config.json manually.${NC}"
            return 1
        fi
    fi

    if [ -d "$SCRIPT_DIR/caddy-generator" ]; then
        echo -e "${BLUE}Generating Caddy configuration files...${NC}"
        cd "$SCRIPT_DIR/caddy-generator"
        # Nothing here needs sudo: the generator only writes files in
        # caddy-generator/ — Caddy picks them up itself. This path runs the
        # wake proxy via SystemD/PM2, so only the Caddyfile is needed (the
        # compose labels override is for Docker deployments).
        npm run generate -- --caddyfile-only

        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ Caddy configuration generated: $SCRIPT_DIR/caddy-generator/Caddyfile${NC}"
            cd "$SCRIPT_DIR"
            print_caddy_next_steps
        else
            echo -e "${RED}❌ Failed to generate Caddy configurations${NC}"
            echo -e "${YELLOW}Please check your config.json file and try again${NC}"
        fi

        cd "$SCRIPT_DIR"
    else
        echo -e "${RED}Error: caddy-generator directory not found${NC}"
        return 1
    fi
}

# Turn examples/caddy-docker-proxy.yml into a ready-to-run stack with the
# generated Caddyfile already mounted (the two "B)" lines uncommented)
write_caddy_stack() {
    local example="$SCRIPT_DIR/examples/caddy-docker-proxy.yml"
    local out="$SCRIPT_DIR/caddy-generator/caddy-stack.yml"
    [ -f "$example" ] || { echo -e "${RED}$example not found${NC}"; return 1; }
    {
        echo "# Written by setup-service.sh from examples/caddy-docker-proxy.yml with the"
        echo "# DockerWakeUp Caddyfile already mounted. Safe to edit; re-running the script overwrites it."
        sed -e 's|label). The two CADDY_DOCKER_CADDYFILE_PATH lines below must be enabled|label). The two CADDY_DOCKER_CADDYFILE_PATH lines below are already enabled|' \
            -e 's|^      # - CADDY_DOCKER_CADDYFILE_PATH=|      - CADDY_DOCKER_CADDYFILE_PATH=|' \
            -e "s|^      # - /path/to/DockerWakeUp/caddy-generator/Caddyfile:|      - $SCRIPT_DIR/caddy-generator/Caddyfile:|" \
            "$example"
    } > "$out"
    echo "$out"
}

# Print what the user still has to do by hand for Caddy — short enough to
# follow without the README. Asks whether a Caddy already exists because the
# two cases need different things.
print_caddy_next_steps() {
    local caddyfile="$SCRIPT_DIR/caddy-generator/Caddyfile"
    local port
    port=$(sed -n 's/.*"proxyPort"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$SCRIPT_DIR/config.json" | head -1)
    port=${port:-8080}
    echo ""
    read -p "Do you already have Caddy / caddy-docker-proxy running on this machine? (y/N): " have_caddy
    echo ""
    if [[ "$have_caddy" =~ ^[Yy] ]]; then
        # Bridge-network containers can't reach host ports through ufw; tell
        # the user exactly which rule opens the wake proxy for their network
        local subnet
        subnet=$(docker network inspect caddy -f '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || true)
        echo -e "${BLUE}Caddy is already running — 4 things to do:${NC}"
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
        echo -e "${YELLOW}2. Hand Caddy the generated sites.${NC}"
        echo "   caddy-docker-proxy — add to your caddy service, then recreate it:"
        echo "       environment:"
        echo "         - CADDY_DOCKER_CADDYFILE_PATH=/etc/caddy/docker-wakeup.Caddyfile"
        echo "       volumes:"
        echo "         - $caddyfile:/etc/caddy/docker-wakeup.Caddyfile:ro"
        echo "   Plain Caddy on the host — add to /etc/caddy/Caddyfile:"
        echo "       import $caddyfile"
        echo "     set \"caddyUpstream\": \"127.0.0.1:$port\" in config.json, re-run this script, then: sudo systemctl reload caddy"
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
        echo "After editing config.json: re-run this script (or: cd caddy-generator && npm run generate)."
        echo "caddy-docker-proxy re-reads the Caddyfile by itself; plain Caddy needs: sudo systemctl reload caddy"
    else
        local stack
        stack=$(write_caddy_stack) || return 0
        echo -e "${BLUE}No Caddy yet — a ready-to-run caddy-docker-proxy stack was written to:${NC}"
        echo "   $stack"
        echo "   (the DockerWakeUp Caddyfile is already mounted; nothing to edit)"
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
        echo "After editing config.json: re-run this script (or: cd caddy-generator && npm run generate)."
        echo "caddy-docker-proxy picks the new Caddyfile up by itself within ~30s."
    fi
}

# Ask which reverse proxy fronts the wake proxy and generate its configs
PROXY_CHOICE="nginx"
generate_proxy_configs() {
    echo ""
    echo "Which reverse proxy do you use in front of DockerWakeUp?"
    echo "1) NGINX (default)"
    echo "2) Caddy / caddy-docker-proxy"
    echo "3) Skip reverse proxy config generation"
    read -p "Enter your choice (1-3) [1]: " proxy_choice
    case "${proxy_choice:-1}" in
        1) PROXY_CHOICE="nginx"; generate_nginx_configs ;;
        2) PROXY_CHOICE="caddy"; generate_caddy_configs ;;
        3) PROXY_CHOICE="none"; echo -e "${YELLOW}Skipping reverse proxy config generation${NC}" ;;
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

echo "Please choose how you want to run the wake-proxy service:"
echo "1) SystemD service + reverse proxy configs (recommended for production)"
echo "2) PM2 process manager + reverse proxy configs"
echo "3) Build project only (no service setup)"
echo "4) Generate reverse proxy configs only (NGINX or Caddy)"
echo "5) Exit"
if [ "$GIT_UPDATE_OPTION" = "1" ]; then
    echo "6) Update to latest version from GitHub"
    echo ""
    read -p "Enter your choice (1-6): " choice
else
    echo ""
    read -p "Enter your choice (1-5): " choice
fi

case $choice in
    1)
        build_project
        generate_proxy_configs
        setup_systemd
        SERVICE_SETUP=1
        ;;
    2)
        build_project
        generate_proxy_configs
        setup_pm2
        SERVICE_SETUP=1
        ;;
    3)
        build_project
        ;;
    4)
        build_project
        generate_proxy_configs
        ;;
    5)
        echo -e "${GREEN}Exiting...${NC}"
        exit 0
        ;;
    6)
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
if [ -n "$SERVICE_SETUP" ]; then
    SERVICE_HINT="Your wake-proxy service should now be running!"
else
    SERVICE_HINT="Start the wake proxy: re-run this script with option 1 or 2 (or: cd wake-proxy && npm start)"
fi

if [ ! -f "$SCRIPT_DIR/config.json" ] || [ -f "$SCRIPT_DIR/config.json.example" ] && cmp -s "$SCRIPT_DIR/config.json" "$SCRIPT_DIR/config.json.example"; then
    echo "1. ⚠️  IMPORTANT: Edit config.json with your actual service details"
    if [ "$PROXY_CHOICE" = "caddy" ]; then
        echo "2. Re-run the script or manually generate Caddy configs: cd caddy-generator && npm run generate"
        echo "3. Follow the Caddy steps printed above"
    else
        echo "2. Re-run the script or manually generate NGINX configs: cd nginx-generator && npm run generate"
        echo "3. Reload NGINX: sudo systemctl reload nginx"
    fi
elif [ "$PROXY_CHOICE" = "caddy" ]; then
    echo "1. ✅ Caddy configuration generated: caddy-generator/Caddyfile"
    echo "2. Follow the Caddy steps printed above (details: README → Caddy Generator)"
    echo "3. $SERVICE_HINT"
elif [ "$PROXY_CHOICE" = "none" ]; then
    echo "1. ⏭️  Reverse proxy config generation was skipped"
    echo "2. Generate later with: cd nginx-generator && npm run generate  (or cd caddy-generator && npm run generate)"
    echo "3. $SERVICE_HINT"
else
    echo "1. ✅ NGINX configurations have been generated"
    echo "2. Reload NGINX to activate: sudo systemctl reload nginx"
    echo "3. $SERVICE_HINT"
fi

echo ""
echo -e "${BLUE}Useful commands:${NC}"
echo "• Check service status: sudo systemctl status docker-wakeup"
echo "• View logs: sudo journalctl -u docker-wakeup -f"
echo "• Restart service: sudo systemctl restart docker-wakeup"
