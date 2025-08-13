# Docker Wake-Up Proxy System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.5+-blue.svg)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Compatible-blue.svg)](https://www.docker.com/)

## Features 🚀

- **On-Demand Container Startup**: Automatically starts Docker containers when they receive HTTP requests
- **Intelligent Idle Management**: Monitors container usage and stops idle containers after configurable timeout
- **Automatic NGINX Configuration**: Generates SSL-enabled NGINX reverse proxy configurations
- **Zero-Downtime Experience**: Seamless proxying with startup loading pages
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

- [Features](#features-)
- [Quick Start](#quick-start-)
- [SSL Setup](#ssl-setup-)
- [Automated Setup Script](#automated-setup-script-️)
- [Manual Installation](#manual-installation-)
- [Service Management](#service-management-️)
- [Architecture](#️-architecture)
- [Configuration](#configuration-️)
- [Components](#components-)
- [Usage](#usage-)
- [Project Structure](#-project-structure)
- [Requirements](#requirements-)
- [Contributing](#contributing-)
- [License](#license-)
- [Acknowledgments](#acknowledgments-)
- [Support](#support-)

## Quick Start ⚡

1. **Clone the repository**
   ```bash
   git clone https://github.com/jelliott2021/docker-wakeup.git
   cd docker-wakeup
   ```

2. **Configure your services**
   ```bash
   cp config.json.example config.json # Copy example to config
   nano config.json  # Edit with your service details
   ```

3. **Make sure SSL is setup**
  Instructions down below to setup wildcard SSL Certificate

4. **Run the automated setup**
   ```bash
   chmod +x setup-service.sh
   ./setup-service.sh
   ```

5. **Idle shutdown is now built-in!**
   - No separate script or cron job needed.
   - The wake-proxy automatically monitors and stops idle containers every 5 minutes based on your `idleThreshold` in `config.json`.

The setup script will automatically:
- Build all components (wake-proxy and nginx-generator)
- Generate NGINX configurations from your config.json
- Set up the wake-proxy as a SystemD service
- Configure auto-start on boot

That's it! Your wake-proxy service is now running with NGINX configs generated and ready to use.

## SSL Setup 🔒

For HTTPS access, set up a wildcard SSL certificate to cover all subdomains:

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
1. ✅ **Dependency Installation** - Installs all npm packages for both components
2. ✅ **TypeScript Compilation** - Builds the wake-proxy and nginx-generator
3. ✅ **NGINX Configuration Generation** - Creates SSL-enabled NGINX configs from your config.json
4. ✅ **SystemD Service Creation** - Generates service file with correct paths
5. ✅ **User & Path Detection** - Automatically configures service for your system
6. ✅ **Security Hardening** - Applies production security settings
7. ✅ **Auto-Start Configuration** - Sets up service to start on boot
8. ✅ **Service Activation** - Immediately starts the service

### Setup Options

The script provides several installation methods:

```
1) SystemD service + NGINX configs (recommended for production)
2) PM2 process manager + NGINX configs
3) Build project only (no service setup)
4) Generate NGINX configs only
5) Exit
```

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
- Homelab setups requiring NGINX reverse proxy

## Manual Installation 📦

If you prefer manual setup or need custom configuration:

### Prerequisites

- Docker and Docker Compose
- Node.js 16+ and npm
- NGINX (for production)
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
   ```

3. **Configure your services**
   ```bash
   # Copy and edit the configuration
   cp config.json.example config.json
   nano config.json
   ```

4. **Generate NGINX configurations**
   ```bash
   cd nginx-generator
   npm run generate
   sudo nginx -t  # Test configuration
   sudo systemctl reload nginx
   cd ..
   ```

5. **Build the wake proxy**
   ```bash
   cd wake-proxy && npm run build && cd ..
   ```

6. **Create SystemD service manually**
   
   Copy the service template and customize:
   ```bash
   # Copy the template
   sudo cp docker-wakeup.service /etc/systemd/system/
   
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
│   NGINX Proxy   │───▶│  Wake Proxy  │───▶│ Docker Services │
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
1. **NGINX** handles SSL termination and routes requests to the wake proxy
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

### Service Configuration

| Field | Description | Example |
|-------|-------------|---------|
| `route` | Subdomain/route name | `"jellyfin"` |
| `target` | Local URL where the service runs | `"http://localhost:8096"` |
| `composeDir` | Directory containing docker-compose.yml | `"/path/to/service"` |

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

### 3. Idle Shutdown (Integrated)

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
├── docker-wakeup.service       # SystemD service template
├── ecosystem.config.js         # PM2 configuration template
├── setup-service.sh            # Automated service setup script
├── wake-proxy/                 # Wake proxy service
│   ├── src/
│   │   └── wake-proxy.ts      # Main proxy logic
│   ├── package.json           # Dependencies
│   ├── tsconfig.json          # TypeScript config
│   └── dist/                  # Compiled JavaScript
└─ nginx-generator/            # NGINX config generator
    ├── generate-nginx.ts      # Generator script
    ├── package.json           # Dependencies
    ├── tsconfig.json          # TypeScript config
    └── confs/                 # Generated configs
        ├── jellyfin.conf
        ├── portainer.conf
        └── ...
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
- **NGINX**: 1.18+
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
