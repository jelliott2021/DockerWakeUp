import { errorMessage, sleep } from "../src/util";

describe("errorMessage", () => {
  it("uses the message of Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("uses a message property on plain objects", () => {
    expect(errorMessage({ message: "from object" })).toBe("from object");
  });

  it("falls back to String() for everything else", () => {
    expect(errorMessage("text")).toBe("text");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage({ message: 5 })).toBe("[object Object]");
  });
});

describe("sleep", () => {
  it("resolves after the given delay", async () => {
    jest.useFakeTimers();
    const done = jest.fn();
    const promise = sleep(500).then(done);
    await jest.advanceTimersByTimeAsync(499);
    expect(done).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await promise;
    expect(done).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
