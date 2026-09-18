import { CommandError, runFile, runShell } from "../src/shell";
import { makeTempDir } from "./helpers";

describe("runShell", () => {
  it("resolves with stdout and stderr on success", async () => {
    await expect(runShell("echo out; echo err >&2")).resolves.toEqual({
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  it("runs in the given working directory", async () => {
    const dir = makeTempDir();
    const { stdout } = await runShell("pwd", dir);
    expect(stdout.trim()).toBe(dir);
  });

  it("rejects with a CommandError carrying stderr", async () => {
    const err = await runShell("echo failed >&2; exit 3").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).name).toBe("CommandError");
    expect((err as CommandError).stderr).toBe("failed\n");
    expect((err as CommandError).message).toMatch(/^Command failed/);
  });
});

describe("runFile", () => {
  it("passes arguments without a shell", async () => {
    const { stdout } = await runFile("printf", ["%s|", "a b", "$HOME", "`x`"]);
    expect(stdout).toBe("a b|$HOME|`x`|");
  });

  it("rejects with a CommandError on failure and on a missing executable", async () => {
    const err = await runFile("sh", ["-c", "echo nope >&2; exit 1"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).stderr).toBe("nope\n");

    await expect(runFile("definitely-not-a-real-binary-xyz", [])).rejects.toThrow(/ENOENT/);
  });
});
