import fs from "fs";
import path from "path";
import {
  DEFAULT_BIND_HOST,
  DEFAULT_PROXY_PORT,
  PROJECT_ROOT,
  ROUTE_RE,
  indexServices,
  isTcpService,
  loadConfig,
  resolveConfigPath,
  type ServiceConfig,
} from "../src/config";
import { makeTempDir, mockConsole } from "./helpers";

const console = mockConsole();

describe("constants", () => {
  it("resolves the project root to the repository root", () => {
    expect(PROJECT_ROOT).toBe(path.resolve(__dirname, "..", ".."));
    expect(fs.existsSync(path.join(PROJECT_ROOT, "config.json.example"))).toBe(true);
  });

  it("exposes the documented defaults", () => {
    expect(DEFAULT_PROXY_PORT).toBe(8080);
    expect(DEFAULT_BIND_HOST).toBe("0.0.0.0");
  });

  it("accepts only plain route names", () => {
    expect(ROUTE_RE.test("jellyfin")).toBe(true);
    expect(ROUTE_RE.test("my-app-2")).toBe(true);
    expect(ROUTE_RE.test("Photos")).toBe(true);
    expect(ROUTE_RE.test("a b")).toBe(false);
    expect(ROUTE_RE.test("a/b")).toBe(false);
    expect(ROUTE_RE.test("")).toBe(false);
  });
});

describe("resolveConfigPath", () => {
  it("defaults to config.json in the project root", () => {
    expect(resolveConfigPath({})).toBe(path.join(PROJECT_ROOT, "config.json"));
  });

  it("honours WAKEUP_CONFIG, resolved against the working directory", () => {
    expect(resolveConfigPath({ WAKEUP_CONFIG: "rel/config.json" })).toBe(
      path.resolve("rel/config.json"),
    );
    expect(resolveConfigPath({ WAKEUP_CONFIG: "/abs/config.json" })).toBe("/abs/config.json");
  });

  it("reads process.env by default", () => {
    const previous = process.env.WAKEUP_CONFIG;
    process.env.WAKEUP_CONFIG = "/from/env.json";
    try {
      expect(resolveConfigPath()).toBe("/from/env.json");
    } finally {
      if (previous === undefined) delete process.env.WAKEUP_CONFIG;
      else process.env.WAKEUP_CONFIG = previous;
    }
  });
});

describe("loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
  };

  it("parses a valid file", () => {
    const file = write("config.json", JSON.stringify({ proxyPort: 1234, services: [] }));
    expect(loadConfig(file)).toEqual({ proxyPort: 1234, services: [] });
  });

  it("reports unreadable or invalid JSON with the path", () => {
    expect(() => loadConfig(path.join(dir, "missing.json"))).toThrow(
      /Cannot read .*missing\.json: ENOENT/,
    );
    const file = write("bad.json", "{ not json");
    expect(() => loadConfig(file)).toThrow(/Cannot read .*bad\.json/);
  });

  it("requires a services array", () => {
    for (const content of ["null", "42", "[]", "{}", '{"services": "nope"}']) {
      const file = write("shape.json", content);
      expect(() => loadConfig(file)).toThrow(/must be a JSON object with a "services" array/);
    }
  });
});

describe("indexServices", () => {
  const http: ServiceConfig = { route: "app", target: "http://localhost:3000", composeDir: "/x" };
  const tcp: ServiceConfig = {
    route: "mc",
    target: "localhost:25565",
    type: "tcp",
    listenPort: 25566,
    composeDir: "/x",
  };

  it("indexes valid services by route", () => {
    expect(indexServices([http, tcp])).toEqual({ app: http, mc: tcp });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("skips services with an invalid or missing route", () => {
    const bad = [
      { ...http, route: "a b" },
      { ...http, route: "a/b" },
      { ...http, route: undefined as unknown as string },
    ];
    expect(indexServices(bad)).toEqual({});
    expect(console.error).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"a b" is invalid'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("null is invalid"));
  });

  it("skips services without a target", () => {
    expect(
      indexServices([
        { ...http, target: "" },
        { ...http, target: undefined as unknown as string },
      ]),
    ).toEqual({});
    expect(console.error).toHaveBeenCalledWith('Service app: "target" is required — skipping');
  });

  it("skips tcp services without a usable listenPort", () => {
    const bad = [
      { ...tcp, listenPort: undefined },
      { ...tcp, listenPort: 0 },
      { ...tcp, listenPort: 1.5 },
      { ...tcp, listenPort: "25566" as unknown as number },
    ];
    expect(indexServices(bad)).toEqual({});
    expect(console.error).toHaveBeenCalledTimes(4);
    expect(console.error).toHaveBeenCalledWith(
      'Service mc: type "tcp" requires a listenPort — skipping',
    );
  });

  it("keeps services that cannot be woken, with a warning", () => {
    const svc = { route: "static", target: "http://localhost:1" };
    expect(indexServices([svc])).toEqual({ static: svc });
    expect(console.warn).toHaveBeenCalledWith(
      "Service static: no composeDir or startCommand configured — it cannot be woken",
    );
  });

  it("does not warn when a startCommand replaces composeDir", () => {
    indexServices([{ route: "s", target: "http://localhost:1", startCommand: "./start.sh" }]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("lets the later entry win on duplicate routes, with a warning", () => {
    const later = { ...http, target: "http://localhost:4000" };
    expect(indexServices([http, later])).toEqual({ app: later });
    expect(console.warn).toHaveBeenCalledWith(
      "Service app: duplicate route in config.json — the later entry wins",
    );
  });
});

describe("isTcpService", () => {
  it("narrows on the type field", () => {
    expect(isTcpService({ route: "a", target: "x", type: "tcp", listenPort: 1 })).toBe(true);
    expect(isTcpService({ route: "a", target: "x", type: "http" })).toBe(false);
    expect(isTcpService({ route: "a", target: "x" })).toBe(false);
  });
});
