import path from "path";
import { generateCaddy } from "../src/caddy";
import { PROXY_KINDS, USAGE, main, parseArgs } from "../src/cli";
import { generateNginx } from "../src/nginx";
import { generateTraefik } from "../src/traefik";
import {
  captureConsole,
  makeTempDir,
  removeTempDir,
  writeFile,
  type ConsoleCapture,
} from "./helpers";

jest.mock("../src/nginx");
jest.mock("../src/caddy");
jest.mock("../src/traefik");

const nginxMock = jest.mocked(generateNginx);
const caddyMock = jest.mocked(generateCaddy);
const traefikMock = jest.mocked(generateTraefik);

describe("parseArgs", () => {
  it("returns the defaults for no arguments", () => {
    expect(parseArgs([])).toEqual({ proxy: "", configPath: undefined, caddyfileOnly: false });
  });

  it("reads --proxy <name>", () => {
    expect(parseArgs(["--proxy", "nginx"])).toEqual({
      proxy: "nginx",
      configPath: undefined,
      caddyfileOnly: false,
    });
  });

  it("reads --proxy=<name>", () => {
    expect(parseArgs(["--proxy=caddy"]).proxy).toBe("caddy");
  });

  it("takes the first positional argument as the config path", () => {
    expect(parseArgs(["--proxy", "caddy", "/a/config.json", "/b/config.json"]).configPath).toBe(
      "/a/config.json",
    );
  });

  it("reads --caddyfile-only", () => {
    expect(parseArgs(["--caddyfile-only", "--proxy", "caddy"])).toEqual({
      proxy: "caddy",
      configPath: undefined,
      caddyfileOnly: true,
    });
  });

  it("ignores unknown --flags", () => {
    expect(parseArgs(["--verbose", "--proxy", "traefik"])).toEqual({
      proxy: "traefik",
      configPath: undefined,
      caddyfileOnly: false,
    });
  });

  it("leaves proxy empty when --proxy has no value", () => {
    expect(parseArgs(["--proxy"]).proxy).toBe("");
  });

  it("uses the last --proxy given", () => {
    expect(parseArgs(["--proxy=nginx", "--proxy", "caddy"]).proxy).toBe("caddy");
  });
});

describe("main", () => {
  let root: string;
  let generatorDir: string;
  let configPath: string;
  let out: ConsoleCapture;

  const config = {
    domain: "example.com",
    services: [
      { route: "jellyfin", target: "http://localhost:8096" },
      { route: "minecraft", target: "localhost:25565", type: "tcp" },
    ],
  };
  const expectedSettings = (overrides: Record<string, unknown> = {}) => ({
    configPath,
    config,
    domain: "example.com",
    proxyPort: 8080,
    services: [config.services[0]],
    ...overrides,
  });

  beforeEach(() => {
    root = makeTempDir();
    generatorDir = path.join(root, "proxy-generator");
    configPath = path.join(root, "config.json");
    out = captureConsole();
  });
  afterEach(() => removeTempDir(root));

  it("knows the three proxies", () => {
    expect(PROXY_KINDS).toEqual(["nginx", "caddy", "traefik"]);
  });

  it("prints the usage and exits 1 without --proxy", () => {
    expect(main([configPath], { generatorDir })).toBe(1);
    expect(out.error).toEqual([USAGE]);
    expect(USAGE).toBe(
      "Usage: generate.ts --proxy nginx|caddy|traefik [/path/to/config.json] [--caddyfile-only]",
    );
    expect(nginxMock).not.toHaveBeenCalled();
    expect(caddyMock).not.toHaveBeenCalled();
    expect(traefikMock).not.toHaveBeenCalled();
  });

  it("prints the usage and exits 1 for an unknown proxy", () => {
    expect(main(["--proxy", "apache", configPath], { generatorDir })).toBe(1);
    expect(out.error).toEqual([USAGE]);
  });

  it("exits 1 when the config file is missing", () => {
    expect(main(["--proxy", "caddy", configPath], { generatorDir })).toBe(1);
    expect(out.error).toEqual([`${configPath} not found.`]);
    expect(caddyMock).not.toHaveBeenCalled();
  });

  it("looks for ../config.json next to the generator by default", () => {
    expect(main(["--proxy", "caddy"], { generatorDir })).toBe(1);
    expect(out.error).toEqual([`${configPath} not found.`]);

    writeFile(configPath, JSON.stringify(config));
    expect(main(["--proxy", "caddy"], { generatorDir })).toBe(0);
    expect(caddyMock).toHaveBeenCalledWith(expectedSettings(), { generatorDir }, false);
  });

  it("resolves a relative config path against the current directory", () => {
    const relative = path.relative(process.cwd(), configPath);
    expect(main(["--proxy", "caddy", relative], { generatorDir })).toBe(1);
    expect(out.error).toEqual([`${configPath} not found.`]);
  });

  it("exits 1 when the config has no domain", () => {
    writeFile(configPath, JSON.stringify({ services: [] }));
    expect(main(["--proxy", "nginx", configPath], { generatorDir })).toBe(1);
    expect(out.error).toEqual([
      'No "domain" set in config.json — add e.g. "domain": "example.com" and re-run.',
    ]);
    expect(nginxMock).not.toHaveBeenCalled();
  });

  it("lets malformed JSON throw", () => {
    writeFile(configPath, "{");
    expect(() => main(["--proxy", "nginx", configPath], { generatorDir })).toThrow(SyntaxError);
  });

  it("runs the nginx generator and returns its exit code", () => {
    writeFile(configPath, JSON.stringify(config));
    nginxMock.mockReturnValue(1);
    const ctx = { generatorDir, isRoot: true };
    expect(main(["--proxy", "nginx", configPath], ctx)).toBe(1);
    expect(nginxMock).toHaveBeenCalledWith(expectedSettings(), ctx);
    expect(out.log).toEqual([
      'Skipped minecraft: type "tcp" services don\'t use an HTTP reverse proxy config',
    ]);
    expect(caddyMock).not.toHaveBeenCalled();
    expect(traefikMock).not.toHaveBeenCalled();
  });

  it("runs the caddy generator", () => {
    writeFile(configPath, JSON.stringify({ ...config, proxyPort: 9090 }));
    expect(main(["--proxy", "caddy", configPath], { generatorDir })).toBe(0);
    expect(caddyMock).toHaveBeenCalledWith(
      expectedSettings({ config: { ...config, proxyPort: 9090 }, proxyPort: 9090 }),
      { generatorDir },
      false,
    );
  });

  it("passes --caddyfile-only to the caddy generator", () => {
    writeFile(configPath, JSON.stringify(config));
    expect(main(["--proxy=caddy", "--caddyfile-only", configPath], { generatorDir })).toBe(0);
    expect(caddyMock).toHaveBeenCalledWith(expectedSettings(), { generatorDir }, true);
  });

  it("runs the traefik generator", () => {
    writeFile(configPath, JSON.stringify(config));
    expect(main(["--proxy=traefik", configPath], { generatorDir })).toBe(0);
    expect(traefikMock).toHaveBeenCalledWith(expectedSettings(), { generatorDir });
    expect(nginxMock).not.toHaveBeenCalled();
    expect(caddyMock).not.toHaveBeenCalled();
  });
});
