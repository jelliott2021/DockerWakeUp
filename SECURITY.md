# Security Notes

## Trust model

- **`config.json` is code.** `startCommand`, `stopCommand` and `logsCommand`
  run as the wake proxy's user via `/bin/sh -c`, and that user holds the
  Docker socket — which is root-equivalent on the host. Anyone who can edit
  `config.json` (or the compose files it points at) controls the machine.
  Keep both writable only by their owner.
- **The Docker deployment has the same power**: the container mounts
  `/var/run/docker.sock` (required to start/stop your services) and your home
  directory read-only (so it can see your compose files). The container is
  not a security boundary here.

## Network exposure

- The wake proxy performs **no authentication**. Whatever your reverse proxy
  enforces (TLS, basic auth, an access proxy) is bypassed by anyone who can
  reach the wake proxy's port directly. If your reverse proxy runs on the
  host, set `"bindHost": "127.0.0.1"` in `config.json`; if it runs in a
  bridge-network container, firewall the port so only that network reaches it
  (see the README's "Works With Any Reverse Proxy" section).
- `"type": "tcp"` services (game servers etc.) listen on their `listenPort`
  on all interfaces by design — treat them like any other exposed game port.
- Anyone who can reach a service's URL can **wake it and keep it awake**
  (every successful request resets the idle timer — crawlers included).
  That's the product working as designed; put auth in front of services where
  that matters (the generated configs' `# custom-start` blocks are the place).

## Wake page

- Startup-log streaming to the browser is **off by default** and only ever
  possible while a wake is in progress (`"showLogs": true` opts a service in).
- `__wake/status` is public per service (state and timing only) — the wake
  page needs it to know when to reload.

## Reporting

Found something? Please open a GitHub issue (or a private security advisory
on the repository) rather than posting an exploit publicly first.
