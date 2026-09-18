import { execSync } from "child_process";
import { resolveContext } from "../src/context";

describe("resolveContext", () => {
  const originalGetuid = process.getuid;
  afterEach(() => {
    process.getuid = originalGetuid;
  });

  it("fills in the process-based defaults", () => {
    process.getuid = () => 1000;
    expect(resolveContext({ generatorDir: "/srv/pg" })).toEqual({
      generatorDir: "/srv/pg",
      env: process.env,
      runCommand: execSync,
      isRoot: false,
    });
  });

  it("is root when the process runs as uid 0", () => {
    process.getuid = () => 0;
    expect(resolveContext({ generatorDir: "/srv/pg" }).isRoot).toBe(true);
  });

  it("is not root when getuid is unavailable (Windows)", () => {
    process.getuid = undefined;
    expect(resolveContext({ generatorDir: "/srv/pg" }).isRoot).toBe(false);
  });

  it("keeps every field it is given", () => {
    process.getuid = () => 0;
    const runCommand = jest.fn();
    const env = { NGINX_SITES_DIR: "/tmp/sites" };
    expect(resolveContext({ generatorDir: "/srv/pg", env, runCommand, isRoot: false })).toEqual({
      generatorDir: "/srv/pg",
      env,
      runCommand,
      isRoot: false,
    });
  });
});
