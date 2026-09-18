// Shared test helpers: temp directories under os.tmpdir(), file setup,
// console capture and GeneratorSettings built straight from a config object.
import fs from "fs";
import os from "os";
import path from "path";
import { DEFAULT_PROXY_PORT, type Config, type GeneratorSettings } from "../src/config";

/** A fresh, empty directory under the OS temp dir; remove it with removeTempDir(). */
export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pg-"));
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Writes `content` to `file`, creating the parent directories. */
export function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

export interface ConsoleCapture {
  log: string[];
  warn: string[];
  error: string[];
}

/**
 * Silences console.log/warn/error for the current test and records every
 * call as one string (arguments joined by spaces, like console prints them).
 */
export function captureConsole(): ConsoleCapture {
  const capture: ConsoleCapture = { log: [], warn: [], error: [] };
  for (const channel of ["log", "warn", "error"] as const) {
    jest.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      capture[channel].push(args.map(String).join(" "));
    });
  }
  return capture;
}

/** A config with the domain the generators require. */
export type TestConfig = Config & { domain: string };

/** GeneratorSettings for `config` without touching the file system; tcp services are left out silently. */
export function settingsFor(
  config: TestConfig,
  configPath = "/srv/wakeup/config.json",
): GeneratorSettings {
  return {
    configPath,
    config,
    domain: config.domain,
    proxyPort: config.proxyPort || DEFAULT_PROXY_PORT,
    services: config.services.filter((svc) => svc.type !== "tcp"),
  };
}
