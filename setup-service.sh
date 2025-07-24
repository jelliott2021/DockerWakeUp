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
ProtectHome=true
ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
EOF

    # Install service file
    sudo cp "$SERVICE_FILE" /etc/systemd/system/docker-wakeup.service
    sudo systemctl daemon-reload
    
    echo -e "${GREEN}SystemD service created successfully!${NC}"
    echo -e "${YELLOW}To enable and start the service:${NC}"
    echo "  sudo systemctl enable docker-wakeup"
    echo "  sudo systemctl start docker-wakeup"
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

# Main menu
echo "Please choose how you want to run the wake-proxy service:"
echo "1) SystemD service + NGINX configs (recommended for production)"
echo "2) PM2 process manager + NGINX configs"
echo "3) Build project only (no service setup)"
echo "4) Generate NGINX configs only"
echo "5) Exit"
echo ""
read -p "Enter your choice (1-5): " choice

case $choice in
    1)
        build_project
        generate_nginx_configs
        setup_systemd
        ;;
    2)
        build_project
        generate_nginx_configs
        setup_pm2
        ;;
    3)
        build_project
        ;;
    4)
        build_project
        generate_nginx_configs
        ;;
    5)
        echo -e "${GREEN}Exiting...${NC}"
        exit 0
        ;;
    *)
        echo -e "${RED}Invalid choice. Please run the script again.${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}Setup completed!${NC}"
echo -e "${YELLOW}Next steps:${NC}"

if [ ! -f "$SCRIPT_DIR/config.json" ] || [ -f "$SCRIPT_DIR/config.json.example" ] && cmp -s "$SCRIPT_DIR/config.json" "$SCRIPT_DIR/config.json.example"; then
    echo "1. ⚠️  IMPORTANT: Edit config.json with your actual service details"
    echo "2. Re-run the script or manually generate NGINX configs: cd nginx-generator && npm run generate"
    echo "3. Reload NGINX: sudo systemctl reload nginx"
    echo "4. Set up the idle shutdown cron job if desired"
else
    echo "1. ✅ NGINX configurations have been generated"
    echo "2. Reload NGINX to activate: sudo systemctl reload nginx"
    echo "3. Set up the idle shutdown cron job if desired"
    echo "4. Your wake-proxy service should now be running!"
fi

echo ""
echo -e "${BLUE}Useful commands:${NC}"
echo "• Check service status: sudo systemctl status docker-wakeup"
echo "• View logs: sudo journalctl -u docker-wakeup -f"
echo "• Restart service: sudo systemctl restart docker-wakeup"
