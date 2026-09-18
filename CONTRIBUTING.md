# Contributing to DockerWakeUp

Thanks for helping out! This page covers the development setup, the checks
every change has to pass, and the conventions of the codebase. Bug reports and
feature requests go to the
[issue tracker](https://github.com/jelliott2021/DockerWakeUp/issues); pull
requests are welcome.

## Repository layout

| Path                        | What it is                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wake-proxy/`               | The wake proxy (TypeScript, Express). A deployable package with its own `package.json`; `src/` compiles to `dist/`, `test/` holds its Jest tests           |
| `proxy-generator/`          | Generates NGINX / Caddy / Traefik configuration from `config.json`. Own `package.json`, run with ts-node; `src/` + `test/`                                 |
| `setup-service.sh`          | The interactive installer (Docker, SystemD, PM2)                                                                                                            |
| `test/`                     | Cross-package suites: `api/` (Postman collection + newman runner), `e2e/` (Playwright), `setup-service/` (bats), `support/` (the harness they share)        |
| `package.json` (repo root)  | Development tooling only — lint, formatting, type checks, test runners, CI scripts. Nothing in it is deployed                                              |
| `.github/workflows/ci.yml`  | The CI pipeline; every job runs one of the npm scripts below                                                                                               |
| `docs/ARCHITECTURE.md`      | How a request travels through the proxy and what each module does                                                                                          |

The two packages are deliberately **not** npm workspaces: the Dockerfile, the
compose helper and `setup-service.sh` each install one package on its own, so
the lockfiles stay self-contained and deployments keep working unchanged.

## Development setup

Requirements: Node.js 20 or newer, Git, and (for the end-to-end tests) the
Chromium that Playwright downloads.

```bash
git clone https://github.com/jelliott2021/DockerWakeUp.git
cd DockerWakeUp
npm run install:all                # root tooling + both packages (npm ci)
npx playwright install chromium    # once, for the end-to-end tests
```

To run the proxy itself you need a `config.json` (start from
`config.json.example`). `npm run dev --prefix wake-proxy` runs it from source
with ts-node; `npm run build && npm start --prefix wake-proxy` runs the
compiled build. Two environment variables help during development and are
used by the test harness:

| Variable            | Effect                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `WAKEUP_CONFIG`     | Path of the config file (default: `config.json` in the repository root) |
| `WAKEUP_STATE_DIR`  | Directory for the last-access / wake-history files (default: `wake-proxy/tmp`) |

## Checks

| Command                      | What it does                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`               | ESLint and a Prettier check                                                                                          |
| `npm run lint:fix`           | Fix what ESLint can fix and reformat                                                                                 |
| `npm run typecheck`          | `tsc --noEmit` for both packages (sources and tests) and the root test code                                          |
| `npm run shellcheck`         | ShellCheck for `setup-service.sh`                                                                                    |
| `npm test`                   | Jest: unit and integration tests of both packages                                                                    |
| `npm run test:coverage`      | The same with coverage. The thresholds in `jest.config.js` (100% statements, branches, functions and lines) are enforced |
| `npm run test:api`           | Builds the proxy, starts it on free ports in front of throwaway services and runs the Postman collection with newman |
| `npm run test:e2e`           | Builds the proxy and drives a real Chromium through the wake page with Playwright                                    |
| `npm run test:setup-script`  | bats tests for `setup-service.sh`                                                                                    |
| `npm run test:all`           | Everything above, in the order CI runs it                                                                            |

CI runs all of this for every pull request to `main` (Node 20 and 22 for the
Jest suite) and additionally builds the Docker image and checks its `/healthz`.

## Test layers

- **Unit tests** live next to each package (`wake-proxy/test`,
  `proxy-generator/test`), one file per module, run by Jest with ts-jest.
  Shell commands (`docker compose`, hooks) are mocked at the `shell.ts`
  boundary; everything else — HTTP backends, TCP sockets, the file system —
  is real but throwaway (temp directories, free ports).
- **Integration tests** (`wake-proxy/test/app.test.ts`) run the real Express
  app in-process with supertest and raw sockets for WebSocket upgrades.
- **Browser logic** of the built-in wake page is tested under jsdom
  (`wake-proxy/test/wakePage.dom.test.ts`): the inline script runs against a
  document with fake `EventSource`, `fetch` and `location`.
- **API tests** are a Postman collection
  (`test/api/DockerWakeUp.postman_collection.json`). `npm run test:api`
  runs it with newman against a proxy started by `test/support/harness.ts`;
  the collection can also be imported into Postman — the runner prints the
  environment values it uses.
- **End-to-end tests** (`test/e2e`) start the same harness and open the wake
  page in Chromium: log streaming, the automatic reload into the app, custom
  pages and the failure state.
- **Setup script tests** (`test/setup-service`) source `setup-service.sh` in a
  sandbox with `sudo`, `docker`, `git`, `nginx` and `systemctl` shimmed, so
  nothing on the machine is touched.

Rules for new tests: never touch the real machine (no Docker, no `/etc`, no
network), use temp directories and free ports, and close what you open — Jest
reports leaked handles at the end of a run.

## Code style

- TypeScript with `strict` on. Prettier formats everything (double quotes,
  semicolons, two spaces, 100 columns); ESLint enforces `import { type X }`
  for types and forbids `any`.
- Every module starts with a comment saying what it is for; exported
  functions carry a JSDoc comment.
- Refactors do not change behaviour. Behaviour changes that users can notice
  are documented in `CHANGELOG.md`, and configuration changes in
  `CONFIGURATION.md` as well.
- Commit messages: a short imperative subject line, with bullet points in the
  body when a change has several parts.

## Pull requests

1. Fork and branch from `main`.
2. Make the change with tests and documentation.
3. Run `npm run test:all` locally.
4. Open the pull request; the template lists what reviewers look for, and CI
   has to be green before merging.
