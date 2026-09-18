import path from "path";
import {
  DEFAULT_PROXY_PORT,
  hostsFor,
  httpServices,
  loadGeneratorConfig,
  resolveConfigPath,
  type Config,
} from "../src/config";
import { captureConsole, makeTempDir, removeTempDir, writeFile } from "./helpers";

const SKIPPED = 'Skipped minecraft: type "tcp" services don\'t use an HTTP reverse proxy config';

const fullConfig: Config = {
  domain: "example.com",
  services: [
    { route: "jellyfin", target: "http://localhost:8096" },
    {
      route: "photos",
      target: "http://localhost:2283",
      type: "http",
      domains: ["pics.example.net"],
    },
    { route: "minecraft", target: "localhost:25565", type: "tcp" },
  ],
};

describe("resolveConfigPath", () => {
  it("defaults to config.json in the generator's parent directory", () => {
    expect(resolveConfigPath(undefined, "/srv/wakeup/proxy-generator")).toBe(
      "/srv/wakeup/config.json",
    );
  });

  it("resolves a relative positional path against the current directory", () => {
    expect(resolveConfigPath("configs/wakeup.json", "/srv/wakeup/proxy-generator")).toBe(
      path.join(process.cwd(), "configs/wakeup.json"),
    );
  });

  it("keeps an absolute positional path", () => {
    expect(resolveConfigPath("/etc/wakeup/config.json", "/srv/wakeup/proxy-generator")).toBe(
      "/etc/wakeup/config.json",
    );
  });
});

describe("loadGeneratorConfig", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = makeTempDir();
    configPath = path.join(dir, "config.json");
    captureConsole();
  });
  afterEach(() => removeTempDir(dir));

  it("reports a missing file", () => {
    expect(loadGeneratorConfig(configPath)).toEqual({
      ok: false,
      message: `${configPath} not found.`,
    });
  });

  it("reports a missing domain", () => {
    writeFile(configPath, JSON.stringify({ services: [] }));
    expect(loadGeneratorConfig(configPath)).toEqual({
      ok: false,
      message: 'No "domain" set in config.json — add e.g. "domain": "example.com" and re-run.',
    });
  });

  it("treats an empty domain as missing", () => {
    writeFile(configPath, JSON.stringify({ domain: "", services: [] }));
    expect(loadGeneratorConfig(configPath)).toMatchObject({ ok: false });
  });

  it("lets malformed JSON throw", () => {
    writeFile(configPath, "{ not json");
    expect(() => loadGeneratorConfig(configPath)).toThrow(SyntaxError);
  });

  it("returns the settings with the default proxy port", () => {
    writeFile(configPath, JSON.stringify(fullConfig));
    expect(loadGeneratorConfig(configPath)).toEqual({
      ok: true,
      settings: {
        configPath,
        config: fullConfig,
        domain: "example.com",
        proxyPort: DEFAULT_PROXY_PORT,
        services: fullConfig.services.slice(0, 2),
      },
    });
    expect(DEFAULT_PROXY_PORT).toBe(8080);
  });

  it("uses the configured proxy port", () => {
    writeFile(configPath, JSON.stringify({ ...fullConfig, proxyPort: 9090 }));
    expect(loadGeneratorConfig(configPath)).toMatchObject({ settings: { proxyPort: 9090 } });
  });

  it("treats proxyPort 0 as unset", () => {
    writeFile(configPath, JSON.stringify({ ...fullConfig, proxyPort: 0 }));
    expect(loadGeneratorConfig(configPath)).toMatchObject({ settings: { proxyPort: 8080 } });
  });

  it("says which tcp services it leaves out", () => {
    writeFile(configPath, JSON.stringify(fullConfig));
    loadGeneratorConfig(configPath);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(SKIPPED);
  });
});

describe("httpServices", () => {
  it("keeps http and untyped services and skips tcp ones with a message", () => {
    const out = captureConsole();
    expect(httpServices(fullConfig)).toEqual(fullConfig.services.slice(0, 2));
    expect(out.log).toEqual([SKIPPED]);
  });

  it("returns an empty list when there are no services", () => {
    captureConsole();
    expect(httpServices({ domain: "example.com", services: [] })).toEqual([]);
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe("hostsFor", () => {
  it("is route.domain followed by the extra domains", () => {
    expect(hostsFor(fullConfig.services[1], "example.com")).toEqual([
      "photos.example.com",
      "pics.example.net",
    ]);
  });

  it("is just route.domain without extra domains", () => {
    expect(hostsFor(fullConfig.services[0], "example.com")).toEqual(["jellyfin.example.com"]);
  });
});
