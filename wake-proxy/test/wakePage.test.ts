import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "../src/config";
import { renderDefaultWakePage, renderWakePage } from "../src/wakePage";
import { makeTempDir, mockConsole } from "./helpers";

const console = mockConsole();

describe("renderDefaultWakePage", () => {
  it("is a complete page wired to the wake endpoints", () => {
    const html = renderDefaultWakePage("jellyfin");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Starting jellyfin…</title>");
    expect(html).toContain('<h1>Starting <span id="svc">jellyfin</span></h1>');
    expect(html).toContain('var route = "jellyfin";');
    expect(html).toContain('"/__wake"');
    expect(html).toContain('base + "/logs"');
    expect(html).toContain('base + "/status"');
  });

  it("escapes the route for HTML and for the inline script", () => {
    const html = renderDefaultWakePage('<b>"x"&y</b>');
    expect(html).toContain("<title>Starting &lt;b&gt;&quot;x&quot;&amp;y&lt;/b&gt;…</title>");
    expect(html).toContain('var route = "<b>\\"x\\"&y</b>";');
    expect(html).not.toContain('<span id="svc"><b>');
  });
});

describe("renderWakePage", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("uses the built-in page without a custom path", () => {
    expect(renderWakePage("app")).toBe(renderDefaultWakePage("app"));
    expect(renderWakePage("app", undefined)).toBe(renderDefaultWakePage("app"));
  });

  it("serves a custom page from an absolute path, templating {{route}}", () => {
    const file = path.join(dir, "page.html");
    fs.writeFileSync(file, "<h1>{{route}}</h1><p>{{ route }} and {{  route}}</p>");
    expect(renderWakePage("photos", file)).toBe("<h1>photos</h1><p>photos and photos</p>");
  });

  it("resolves relative paths against the given root, defaulting to the project root", () => {
    fs.mkdirSync(path.join(dir, "pages"));
    fs.writeFileSync(path.join(dir, "pages", "custom.html"), "custom for {{route}}");
    expect(renderWakePage("app", "pages/custom.html", dir)).toBe("custom for app");

    const example = fs.readFileSync(
      path.join(PROJECT_ROOT, "examples", "custom-wake-page.html"),
      "utf8",
    );
    expect(renderWakePage("app", "examples/custom-wake-page.html")).toBe(
      example.replace(/\{\{\s*route\s*\}\}/g, "app"),
    );
  });

  it("falls back to the built-in page when the custom one cannot be read", () => {
    expect(renderWakePage("app", path.join(dir, "missing.html"))).toBe(
      renderDefaultWakePage("app"),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read custom wake page "'),
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});
