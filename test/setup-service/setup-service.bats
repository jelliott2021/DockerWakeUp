#!/usr/bin/env bats
#
# Tests for the pure parts of setup-service.sh. The script is sourced (its
# main() only runs when executed), SCRIPT_DIR is pointed at a scratch copy of
# the repository layout, and `git`, `docker`, `sudo`, `nginx` and `systemctl`
# are shimmed on PATH so nothing touches the real machine.
#
#   npm run test:setup-script

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

setup() {
    SANDBOX="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$SANDBOX/proxy-generator/confs" "$SANDBOX/examples" "$SANDBOX/wake-proxy" "$BATS_TEST_TMPDIR/bin"
    cp "$REPO_ROOT/config.json.example" "$SANDBOX/"
    cp "$REPO_ROOT/examples/caddy-docker-proxy.yml" "$SANDBOX/examples/"
    cp "$REPO_ROOT/setup-service.sh" "$SANDBOX/"

    # Shims: record what would have been run instead of running it
    for tool in sudo docker nginx systemctl npm pm2 curl; do
        printf '#!/bin/bash\necho "%s $*" >> "%s/calls.log"\nexit 0\n' "$tool" "$BATS_TEST_TMPDIR" > "$BATS_TEST_TMPDIR/bin/$tool"
        chmod +x "$BATS_TEST_TMPDIR/bin/$tool"
    done
    export PATH="$BATS_TEST_TMPDIR/bin:$PATH"

    # shellcheck disable=SC1091
    source "$SANDBOX/setup-service.sh"
}

# --- config_proxy_port -------------------------------------------------------

@test "config_proxy_port reads proxyPort from config.json" {
    echo '{ "proxyPort": 9090, "services": [] }' > "$SANDBOX/config.json"
    run config_proxy_port
    [ "$status" -eq 0 ]
    [ "$output" = "9090" ]
}

@test "config_proxy_port defaults to 8080 without a config or a proxyPort" {
    run config_proxy_port
    [ "$output" = "8080" ]
    echo '{ "services": [] }' > "$SANDBOX/config.json"
    run config_proxy_port
    [ "$output" = "8080" ]
}

# --- ensure_config -----------------------------------------------------------

@test "ensure_config creates config.json from the example and warns" {
    run ensure_config
    [ "$status" -eq 0 ]
    [[ "$output" == *"config.json not found. Creating from example..."* ]]
    [[ "$output" == *"Edit config.json with your actual service details"* ]]
    cmp -s "$SANDBOX/config.json" "$SANDBOX/config.json.example"
}

@test "ensure_config leaves an existing config.json alone" {
    echo '{"services": []}' > "$SANDBOX/config.json"
    run ensure_config
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    [ "$(cat "$SANDBOX/config.json")" = '{"services": []}' ]
}

@test "ensure_config fails without an example to copy" {
    rm "$SANDBOX/config.json.example"
    run ensure_config
    [ "$status" -eq 1 ]
    [[ "$output" == *"No config.json.example found"* ]]
}

# --- write_caddy_stack ---------------------------------------------------------

@test "write_caddy_stack (SystemD/PM2) enables the base-Caddyfile lines with the real path" {
    DEPLOY_MODE="host"
    run write_caddy_stack
    [ "$status" -eq 0 ]
    [ "$output" = "$SANDBOX/proxy-generator/caddy-stack.yml" ]
    local stack="$SANDBOX/proxy-generator/caddy-stack.yml"
    head -1 "$stack" | grep -q "^# Written by setup-service.sh"
    grep -q "^      - CADDY_DOCKER_CADDYFILE_PATH=/etc/caddy/docker-wakeup.Caddyfile" "$stack"
    grep -q "^      - $SANDBOX/proxy-generator/Caddyfile:/etc/caddy/docker-wakeup.Caddyfile:ro" "$stack"
    grep -q "lines below are already enabled" "$stack"
    ! grep -q "^      # - CADDY_DOCKER_CADDYFILE_PATH" "$stack"
}

@test "write_caddy_stack (Docker) keeps the example as-is behind a header" {
    DEPLOY_MODE="docker"
    run write_caddy_stack
    [ "$status" -eq 0 ]
    local stack="$SANDBOX/proxy-generator/caddy-stack.yml"
    head -2 "$stack" | grep -q "labels on the docker-wakeup container"
    tail -n +3 "$stack" | cmp -s - "$SANDBOX/examples/caddy-docker-proxy.yml"
}

@test "write_caddy_stack fails when the example is missing" {
    rm "$SANDBOX/examples/caddy-docker-proxy.yml"
    run write_caddy_stack
    [ "$status" -eq 1 ]
    [[ "$output" == *"caddy-docker-proxy.yml not found"* ]]
}

# --- install_nginx_confs --------------------------------------------------------

@test "install_nginx_confs symlinks every conf except example.conf into NGINX_SITES_DIR" {
    local sites="$BATS_TEST_TMPDIR/sites-enabled"
    mkdir -p "$sites"
    for name in jellyfin photos example; do
        echo "server {}" > "$SANDBOX/proxy-generator/confs/$name.conf"
    done
    echo "not a conf" > "$SANDBOX/proxy-generator/confs/.htpasswd"

    NGINX_SITES_DIR="$sites" run install_nginx_confs
    [ "$status" -eq 0 ]
    [ "$(readlink "$sites/jellyfin.conf")" = "$SANDBOX/proxy-generator/confs/jellyfin.conf" ]
    [ "$(readlink "$sites/photos.conf")" = "$SANDBOX/proxy-generator/confs/photos.conf" ]
    [ ! -e "$sites/example.conf" ]
    [ ! -e "$sites/.htpasswd" ]
    [[ "$output" == *"Symlinked confs into $sites"* ]]
    [[ "$output" == *"custom NGINX_SITES_DIR — reload NGINX yourself"* ]]
    # writable target: no sudo involved
    [ ! -f "$BATS_TEST_TMPDIR/calls.log" ]
}

@test "install_nginx_confs uses sudo for a read-only sites directory" {
    local sites="$BATS_TEST_TMPDIR/sites-enabled"
    mkdir -p "$sites"
    chmod 555 "$sites"
    echo "server {}" > "$SANDBOX/proxy-generator/confs/app.conf"
    NGINX_SITES_DIR="$sites" run install_nginx_confs
    chmod 755 "$sites"
    [ "$status" -eq 0 ]
    grep -q "^sudo ln -sf $SANDBOX/proxy-generator/confs/app.conf $sites/app.conf" "$BATS_TEST_TMPDIR/calls.log"
}

@test "install_nginx_confs explains what to do when the sites directory is missing" {
    echo "server {}" > "$SANDBOX/proxy-generator/confs/app.conf"
    NGINX_SITES_DIR="$BATS_TEST_TMPDIR/nowhere" run install_nginx_confs
    [ "$status" -eq 0 ]
    [[ "$output" == *"nowhere not found — copy proxy-generator/confs/ into your NGINX setup manually."* ]]
}

@test "install_nginx_confs validates and reloads NGINX for the standard directory" {
    # With NGINX_SITES_DIR unset the real /etc/nginx/sites-enabled is used; the
    # sudo/nginx/systemctl shims only record the calls, so nothing is changed
    echo "server {}" > "$SANDBOX/proxy-generator/confs/app.conf"
    unset NGINX_SITES_DIR
    run install_nginx_confs
    [ "$status" -eq 0 ]
    if [ -d /etc/nginx/sites-enabled ]; then
        [[ "$output" == *"Symlinked confs into /etc/nginx/sites-enabled"* ]]
        [[ "$output" == *"NGINX reloaded"* ]]
        grep -q "^sudo nginx -t" "$BATS_TEST_TMPDIR/calls.log"
        grep -q "^sudo systemctl reload nginx" "$BATS_TEST_TMPDIR/calls.log"
    else
        [[ "$output" == *"/etc/nginx/sites-enabled not found"* ]]
    fi
}

# --- git_update_status ------------------------------------------------------------

# A fake git driven by env vars: FAKE_LOCAL / FAKE_REMOTE / FAKE_BASE / FAKE_FETCH_FAILS
write_git_shim() {
    cat > "$BATS_TEST_TMPDIR/bin/git" <<'EOF'
#!/bin/bash
args=("$@")
# drop a leading "-C <dir>"
if [ "${args[0]}" = "-C" ]; then args=("${args[@]:2}"); fi
case "${args[0]} ${args[1]}" in
    "fetch "*) [ -n "$FAKE_FETCH_FAILS" ] && exit 1; exit 0 ;;
    "rev-parse HEAD") echo "$FAKE_LOCAL" ;;
    "rev-parse refs/remotes/origin-upstream") echo "$FAKE_REMOTE" ;;
    "merge-base "*) echo "$FAKE_BASE" ;;
    "pull "*) echo "pulled ${args[*]:1}" ;;
    *) echo "unexpected git call: $*" >&2; exit 2 ;;
esac
EOF
    chmod +x "$BATS_TEST_TMPDIR/bin/git"
    mkdir -p "$SANDBOX/.git"
}

@test "git_update_status reports none outside a git checkout" {
    rm -rf "$SANDBOX/.git"
    git_update_status
    [ "$GIT_STATUS" = "none" ]
}

@test "git_update_status classifies latest, behind, ahead and diverged" {
    write_git_shim
    FAKE_LOCAL=aaa FAKE_REMOTE=aaa FAKE_BASE=aaa git_update_status; [ "$GIT_STATUS" = "latest" ]
    FAKE_LOCAL=aaa FAKE_REMOTE=bbb FAKE_BASE=aaa git_update_status; [ "$GIT_STATUS" = "behind" ]
    FAKE_LOCAL=bbb FAKE_REMOTE=aaa FAKE_BASE=aaa git_update_status; [ "$GIT_STATUS" = "ahead" ]
    FAKE_LOCAL=bbb FAKE_REMOTE=ccc FAKE_BASE=aaa git_update_status; [ "$GIT_STATUS" = "diverged" ]
}

@test "git_update_status reports offline when the fetch fails" {
    write_git_shim
    FAKE_FETCH_FAILS=1 git_update_status
    [ "$GIT_STATUS" = "offline" ]
}

@test "print_git_status offers the update option only when it makes sense" {
    for status in latest ahead offline; do
        GIT_STATUS=$status run print_git_status
        [ "$output" = "" ] || [[ "$output" != "1" ]]
        GIT_STATUS=$status
        [ "$(print_git_status 2>/dev/null)" = "" ]
    done
    GIT_STATUS=behind
    [ "$(print_git_status 2>/dev/null)" = "1" ]
    GIT_STATUS=diverged
    [ "$(print_git_status 2>/dev/null)" = "1" ]
    GIT_STATUS=behind run print_git_status
    [[ "$output" == *"behind the canonical remote"* ]]
}

@test "update_from_git pulls when behind and stops when diverged" {
    write_git_shim
    FAKE_LOCAL=aaa FAKE_REMOTE=bbb FAKE_BASE=aaa run update_from_git
    [ "$status" -eq 0 ]
    [[ "$output" == *"Updating now..."* ]]
    [[ "$output" == *"pulled $CANONICAL_REMOTE HEAD"* ]]
    [[ "$output" == *"Code updated."* ]]

    FAKE_LOCAL=bbb FAKE_REMOTE=ccc FAKE_BASE=aaa run update_from_git
    [ "$status" -eq 1 ]
    [[ "$output" == *"have diverged"* ]]

    FAKE_LOCAL=aaa FAKE_REMOTE=aaa FAKE_BASE=aaa run update_from_git
    [ "$status" -eq 0 ]
    [[ "$output" == *"already on the latest version"* ]]

    rm -rf "$SANDBOX/.git"
    run update_from_git
    [[ "$output" == *"Not a git repository"* ]]
}

# --- next steps printed for Caddy / Traefik ------------------------------------------

@test "print_caddy_next_steps without Caddy writes the stack and explains how to start it" {
    DEPLOY_MODE="host"
    run print_caddy_next_steps <<< "n"
    [ "$status" -eq 0 ]
    [[ "$output" == *"No Caddy yet — a ready-to-run caddy-docker-proxy stack was written to:"* ]]
    [[ "$output" == *"$SANDBOX/proxy-generator/caddy-stack.yml"* ]]
    [[ "$output" == *"docker network create caddy"* ]]
    [[ "$output" == *"cd proxy-generator && npm run caddy"* ]]
    [ -f "$SANDBOX/proxy-generator/caddy-stack.yml" ]
}

@test "print_caddy_next_steps with an existing Caddy prints the checklist for the deployment mode" {
    echo '{ "proxyPort": 9090, "services": [] }' > "$SANDBOX/config.json"
    DEPLOY_MODE="docker"
    run print_caddy_next_steps <<< "y"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Let Caddy reach the wake proxy on this host (port 9090)"* ]]
    [[ "$output" == *"the sites themselves need nothing"* ]]
    [[ "$output" == *"docker compose run --rm caddy-generator && docker compose up -d"* ]]

    DEPLOY_MODE="host"
    run print_caddy_next_steps <<< "y"
    [[ "$output" == *"Hand Caddy the generated sites."* ]]
    [[ "$output" == *"import $SANDBOX/proxy-generator/Caddyfile"* ]]
}

@test "print_traefik_next_steps covers both the existing-Traefik and the fresh-stack cases" {
    DEPLOY_MODE="host"
    run print_traefik_next_steps <<< "y"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Traefik is already running"* ]]
    [[ "$output" == *"$SANDBOX/proxy-generator/traefik-dynamic.yml:/etc/traefik/docker-wakeup.yml:ro"* ]]
    [[ "$output" == *"cd proxy-generator && npm run traefik"* ]]

    DEPLOY_MODE="docker"
    run print_traefik_next_steps <<< "n"
    [[ "$output" == *"No Traefik yet"* ]]
    [[ "$output" == *"WAKEUP_PROXY=traefik docker compose run --rm caddy-generator"* ]]
}

@test "generate_proxy_configs can skip generation" {
    run generate_proxy_configs <<< "4"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Skipping reverse proxy config generation"* ]]
}

# --- print_next_steps ------------------------------------------------------------------

@test "print_next_steps nags about the example config until it is edited" {
    cp "$SANDBOX/config.json.example" "$SANDBOX/config.json"
    PROXY_CHOICE="nginx" SERVICE_SETUP="" run print_next_steps
    [[ "$output" == *"IMPORTANT: Edit config.json"* ]]
    [[ "$output" == *"npm run nginx"* ]]
}

@test "print_next_steps summarises the chosen proxy and deployment" {
    echo '{ "services": [] }' > "$SANDBOX/config.json"
    PROXY_CHOICE="traefik" SERVICE_SETUP="docker" run print_next_steps
    [[ "$output" == *"Traefik configuration generated"* ]]
    [[ "$output" == *"The docker-wakeup container is running"* ]]
    [[ "$output" == *"docker logs -f docker-wakeup"* ]]

    PROXY_CHOICE="none" SERVICE_SETUP="1" run print_next_steps
    [[ "$output" == *"Reverse proxy config generation was skipped"* ]]
    [[ "$output" == *"Your wake-proxy service should now be running!"* ]]
    [[ "$output" == *"sudo journalctl -u docker-wakeup -f"* ]]
}

# --- main ----------------------------------------------------------------------------

@test "main: option 6 exits cleanly, an unknown option fails" {
    write_git_shim
    run env FAKE_LOCAL=aaa FAKE_REMOTE=aaa FAKE_BASE=aaa bash "$SANDBOX/setup-service.sh" <<< "6"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Docker Wake-Up Service Setup"* ]]
    [[ "$output" == *"already on the latest version"* ]]
    [[ "$output" == *"Exiting..."* ]]

    run env FAKE_LOCAL=aaa FAKE_REMOTE=aaa FAKE_BASE=aaa bash "$SANDBOX/setup-service.sh" <<< "9"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Invalid choice"* ]]
}

@test "main: offers the update option when behind and runs it" {
    write_git_shim
    run env FAKE_LOCAL=aaa FAKE_REMOTE=bbb FAKE_BASE=aaa bash "$SANDBOX/setup-service.sh" <<< "7"
    [ "$status" -eq 0 ]
    [[ "$output" == *"7) Update to latest version from GitHub"* ]]
    [[ "$output" == *"Code updated."* ]]
}

@test "main: option 4 generates configs only and prints the next steps" {
    write_git_shim
    echo '{ "domain": "example.com", "services": [] }' > "$SANDBOX/config.json"
    printf '4\n4\n' > "$BATS_TEST_TMPDIR/answers"
    run env FAKE_LOCAL=aaa FAKE_REMOTE=aaa FAKE_BASE=aaa bash "$SANDBOX/setup-service.sh" < "$BATS_TEST_TMPDIR/answers"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Skipping reverse proxy config generation"* ]]
    [[ "$output" == *"Setup completed!"* ]]
    [[ "$output" == *"Reverse proxy config generation was skipped"* ]]
}

@test "main: refuses to run as root" {
    write_git_shim
    is_root() { return 0; }
    run main <<< "6"
    [ "$status" -eq 1 ]
    [[ "$output" == *"Don't run this script as root"* ]]

    run main --pm2 <<< "6"
    [ "$status" -eq 0 ]
    [[ "$output" == *"Exiting..."* ]]
}
