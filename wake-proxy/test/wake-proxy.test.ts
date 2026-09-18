import * as configModule from "../src/config";
import * as serverModule from "../src/server";
import { mockConsole } from "./helpers";

jest.mock("../src/config", () => ({
  loadConfig: jest.fn(() => ({ services: [] })),
  resolveConfigPath: jest.fn(() => "/etc/wakeup/config.json"),
}));
jest.mock("../src/server", () => ({ startServer: jest.fn() }));

const console = mockConsole();

describe("entry point", () => {
  const before = process.listeners("unhandledRejection");
  afterAll(() => {
    for (const listener of process.listeners("unhandledRejection")) {
      if (!before.includes(listener)) process.off("unhandledRejection", listener);
    }
  });

  it("loads the config and starts the server", () => {
    jest.isolateModules(() => {
      require("../src/wake-proxy");
    });
    expect(configModule.resolveConfigPath).toHaveBeenCalledTimes(1);
    expect(configModule.loadConfig).toHaveBeenCalledWith("/etc/wakeup/config.json");
    expect(serverModule.startServer).toHaveBeenCalledWith({ services: [] });
  });

  it("logs unhandled rejections instead of crashing", () => {
    const added = process.listeners("unhandledRejection").filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    (added[0] as (reason: unknown) => void)(new Error("stray"));
    expect(console.error).toHaveBeenCalledWith(
      "Unhandled rejection in wake-proxy:",
      expect.any(Error),
    );
  });
});
