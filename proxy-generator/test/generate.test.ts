// generate.ts is the documented entry point: it hands the CLI arguments and
// its own directory to main() and turns the returned code into process.exitCode.
import path from "path";
import { main } from "../src/cli";

jest.mock("../src/cli", () => ({ main: jest.fn() }));

const mainMock = jest.mocked(main);

describe("generate.ts", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
  });

  it("runs main with the CLI arguments and its directory, and sets the exit code", () => {
    process.argv = ["node", "generate.ts", "--proxy", "caddy", "/srv/wakeup/config.json"];
    mainMock.mockReturnValue(1);

    jest.isolateModules(() => {
      require("../generate");
    });

    expect(mainMock).toHaveBeenCalledTimes(1);
    expect(mainMock).toHaveBeenCalledWith(["--proxy", "caddy", "/srv/wakeup/config.json"], {
      generatorDir: path.resolve(__dirname, ".."),
    });
    expect(process.exitCode).toBe(1);
  });

  it("sets exit code 0 for a successful run", () => {
    process.argv = ["node", "generate.ts", "--proxy", "nginx"];
    mainMock.mockReturnValue(0);

    jest.isolateModules(() => {
      require("../generate");
    });

    expect(mainMock).toHaveBeenCalledWith(["--proxy", "nginx"], expect.anything());
    expect(process.exitCode).toBe(0);
  });
});
