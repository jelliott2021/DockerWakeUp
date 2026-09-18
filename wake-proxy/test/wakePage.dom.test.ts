/**
 * @jest-environment jsdom
 *
 * Runs the built-in wake page's inline script against a jsdom document with
 * fake EventSource/fetch/location, to exercise the browser-side logic:
 * log rendering, readiness polling, progress and reload.
 */
import { renderDefaultWakePage } from "../src/wakePage";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = jest.fn();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  emit(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? JSON.stringify(data) : String(data) });
  }
}

interface Page {
  es: FakeEventSource;
  fetch: jest.Mock;
  location: { pathname: string; reload: jest.Mock };
  $: (id: string) => HTMLElement;
  lines: () => HTMLElement[];
}

/** Load the page for `route` at `pathname` and run its script with fakes injected. */
function loadPage(route = "svc", pathname = "/", fetchImpl?: jest.Mock): Page {
  const html = renderDefaultWakePage(route);
  const body = html.slice(html.indexOf("<body>") + "<body>".length, html.indexOf("<script>"));
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  document.body.innerHTML = body;

  const location = { pathname, reload: jest.fn() };
  const fetch = fetchImpl ?? jest.fn(() => new Promise(() => {}));
  FakeEventSource.instances = [];
  // The script is an IIFE over free identifiers; passing the fakes as
  // parameters shadows the globals without touching the page source.
  new Function("document", "location", "EventSource", "fetch", "setInterval", "setTimeout", script)(
    document,
    location,
    FakeEventSource,
    fetch,
    setInterval,
    setTimeout,
  );
  return {
    es: FakeEventSource.instances[0],
    fetch,
    location,
    $: (id) => document.getElementById(id)!,
    lines: () => Array.from(document.querySelectorAll<HTMLElement>("#log .line")),
  };
}

const statusResponse = (status: object) => Promise.resolve({ json: () => Promise.resolve(status) });

const ESC = "";

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("wake page script", () => {
  it("uses same-origin endpoints at the root, or under /proxy/<route> when accessed that way", () => {
    expect(loadPage("svc", "/").es.url).toBe("/__wake/logs");
    expect(loadPage("svc", "/proxy/svc/some/path").es.url).toBe("/proxy/svc/__wake/logs");
    expect(loadPage("svc", "/proxy/other").es.url).toBe("/__wake/logs");
  });

  it("shows the elapsed time", () => {
    const page = loadPage();
    jest.advanceTimersByTime(5000);
    expect(page.$("elapsed").textContent).toBe("5s");
    jest.advanceTimersByTime(60_000);
    expect(page.$("elapsed").textContent).toBe("1m 5s");
  });

  describe("log rendering", () => {
    it("replaces the placeholder with rendered lines, colouring compose service prefixes", () => {
      const page = loadPage();
      expect(page.$("log").textContent).toContain("Waiting for container logs…");
      page.es.emit("jellyfin  | Server started");
      page.es.emit("db | ready");
      const lines = page.lines();
      expect(lines).toHaveLength(2);
      expect(page.$("log").textContent).not.toContain("Waiting");
      const [svc, sep, msg] = Array.from(lines[0].children) as HTMLElement[];
      expect(svc.textContent).toBe("jellyfin");
      expect(svc.className).toBe("svc");
      expect(svc.style.color).not.toBe("");
      expect(sep.textContent).toBe(" | ");
      expect(msg.textContent).toBe("Server started");
    });

    it("renders ANSI SGR colours and skips 256/RGB colour codes", () => {
      const page = loadPage();
      page.es.emit(
        `${ESC}[31mred${ESC}[0m plain ${ESC}[38;5;200mx${ESC}[39m ${ESC}[48;2;1;2;3my${ESC}[m z`,
      );
      const spans = Array.from(page.lines()[0].querySelectorAll("span")) as HTMLElement[];
      expect(spans.map((s) => s.textContent)).toEqual(["red", " plain ", "x", " ", "y", " z"]);
      expect(spans[0].style.color).toBe("rgb(255, 123, 114)");
      expect(spans[1].style.color).toBe("");
      expect(spans[2].style.color).toBe("");
    });

    it("tints plain error and warning lines, but not already-coloured ones", () => {
      const page = loadPage();
      page.es.emit("app | connection FAILED, retrying");
      page.es.emit("Warning: something odd");
      page.es.emit(`${ESC}[32mfailed but coloured${ESC}[0m`);
      page.es.emit("all good");
      expect(page.lines().map((l) => l.className)).toEqual([
        "line err",
        "line warn",
        "line",
        "line",
      ]);
    });

    it("dims leading timestamps and strips escape sequences a browser cannot render", () => {
      const page = loadPage();
      page.es.emit(`2026-09-17T12:00:00.123Z ${ESC}]0;title${ESC}[2Kmessage`);
      const spans = Array.from(page.lines()[0].querySelectorAll("span")) as HTMLElement[];
      expect(spans[0].className).toBe("dim");
      expect(spans[0].textContent).toBe("2026-09-17T12:00:00.123Z ");
      expect(spans[1].textContent).toBe("message");
    });

    it("keeps only the final state of carriage-return overwrites and drops blank lines", () => {
      const page = loadPage();
      page.es.emit("progress 10%\rprogress 55%\rprogress 100%");
      page.es.emit("   ");
      page.es.emit(`${ESC}[0m${ESC}[1m`);
      page.es.emit("trailing\r");
      expect(page.lines().map((l) => l.textContent)).toEqual(["progress 100%", "trailing"]);
    });

    it("accepts raw (non-JSON) event data too", () => {
      const page = loadPage();
      page.es.onmessage!({ data: "not json" });
      expect(page.lines()[0].textContent).toBe("not json");
    });

    it("caps the log at 500 lines", () => {
      const page = loadPage();
      for (let i = 0; i < 520; i++) page.es.emit(`line ${i}`);
      const lines = page.lines();
      expect(lines).toHaveLength(500);
      expect(lines[0].textContent).toBe("line 20");
      page.es.onerror?.(); // tolerated: the status poller drives failure/reload
    });
  });

  describe("readiness polling", () => {
    it("shows the estimate and progress while starting", async () => {
      const fetch = jest.fn().mockReturnValue(
        statusResponse({
          state: "starting",
          ready: false,
          expectedMs: 90_000,
          elapsedMs: 45_000,
        }),
      );
      const page = loadPage("svc", "/proxy/svc/", fetch);
      await jest.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledWith("/proxy/svc/__wake/status", { cache: "no-store" });
      expect(page.$("eta").textContent).toBe(" · usually ready in ~1m 30s");
      expect(page.$("progress").style.display).toBe("block");
      expect(page.$("bar").style.width).toBe("50%");
    });

    it("estimates elapsed time locally when the server sends none, capping the bar at 95%", async () => {
      const fetch = jest
        .fn()
        .mockReturnValue(statusResponse({ ready: false, expectedMs: 500, elapsedMs: null }));
      const page = loadPage("svc", "/", fetch);
      jest.advanceTimersByTime(10_000);
      await jest.advanceTimersByTimeAsync(0);
      expect(page.$("eta").textContent).toBe(" · usually ready in ~1s");
      expect(page.$("bar").style.width).toBe("95%");
    });

    it("polls every two seconds and retries after a failed request", async () => {
      const fetch = jest
        .fn()
        .mockReturnValueOnce(Promise.reject(new Error("network")))
        .mockReturnValue(statusResponse({ ready: false }));
      loadPage("svc", "/", fetch);
      await jest.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2000);
      expect(fetch).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(2000);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("shows the failure state with the server's error", async () => {
      const fetch = jest
        .fn()
        .mockReturnValue(
          statusResponse({ state: "failed", ready: false, error: "compose exploded" }),
        );
      const page = loadPage("svc", "/", fetch);
      await jest.advanceTimersByTimeAsync(0);
      expect(page.$("spinner").style.animationPlayState).toBe("paused");
      expect(page.$("status-line").textContent).toBe("Startup failed.");
      expect(page.$("error").style.display).toBe("block");
      expect(page.$("error").firstChild!.textContent).toBe("Startup failed: compose exploded");
      await jest.advanceTimersByTimeAsync(3000); // the elapsed timer is stopped, nothing throws
      expect(page.$("status-line").textContent).toBe("Startup failed.");
    });

    it("keeps the generic failure text when no error is given", async () => {
      const fetch = jest.fn().mockReturnValue(statusResponse({ state: "failed", ready: false }));
      const page = loadPage("svc", "/", fetch);
      await jest.advanceTimersByTimeAsync(0);
      expect(page.$("error").firstChild!.textContent).toBe("Startup failed.");
    });

    it("reloads the page once the service is ready", async () => {
      const fetch = jest.fn().mockReturnValue(statusResponse({ state: "ready", ready: true }));
      const page = loadPage("svc", "/", fetch);
      await jest.advanceTimersByTimeAsync(0);
      expect(page.$("status-line").textContent).toBe("Ready! Loading…");
      expect(page.$("bar").style.width).toBe("100%");
      expect(page.es.close).toHaveBeenCalled();
      expect(page.location.reload).toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(5000);
      expect(fetch).toHaveBeenCalledTimes(1); // polling stopped
    });
  });
});
