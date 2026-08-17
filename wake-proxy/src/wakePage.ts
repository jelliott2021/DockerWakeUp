import fs from "fs";
import path from "path";

/**
 * Returns the HTML for the "starting up" page shown to browsers while a
 * service wakes. If a custom page is configured (per-service or global
 * `wakePage` in config.json, path relative to the project root), it is used
 * instead of the built-in one; `{{route}}` inside it is replaced with the
 * service's route name.
 */
export function renderWakePage(route: string, customPagePath?: string): string {
  if (customPagePath) {
    try {
      const resolved = path.isAbsolute(customPagePath)
        ? customPagePath
        : path.join(__dirname, "../../", customPagePath);
      const html = fs.readFileSync(resolved, "utf8");
      return html.replace(/\{\{\s*route\s*\}\}/g, route);
    } catch (e) {
      console.error(`Failed to read custom wake page "${customPagePath}", falling back to default:`, e);
    }
  }
  return renderDefaultWakePage(route);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderDefaultWakePage(route: string): string {
  const safeRoute = escapeHtml(route);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting ${safeRoute}…</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #0d1117;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    padding: 2rem 1rem;
  }
  .card { width: 100%; max-width: 760px; }
  .header { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 0.5rem; }
  .spinner {
    width: 22px; height: 22px; flex: none;
    border: 3px solid #21262d;
    border-top-color: #2f81f7;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 1.35rem; margin: 0; font-weight: 600; }
  .sub { color: #8b949e; font-size: 0.9rem; margin: 0 0 1.25rem 0; }
  .sub .elapsed { color: #e6edf3; font-variant-numeric: tabular-nums; }
  .term {
    background: #010409;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 0.9rem 1rem;
    height: 320px;
    overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 0.78rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .term .line { color: #9da7b3; }
  .term .line:last-child { color: #e6edf3; }
  .error { color: #f85149; margin-top: 1rem; display: none; }
  .error button {
    margin-left: 0.6rem;
    background: #21262d; color: #e6edf3;
    border: 1px solid #30363d; border-radius: 6px;
    padding: 0.25rem 0.7rem; cursor: pointer; font-size: 0.85rem;
  }
  .error button:hover { background: #30363d; }
  .footer { color: #484f58; font-size: 0.75rem; margin-top: 1rem; text-align: center; }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="spinner" id="spinner"></div>
    <h1>Starting <span id="svc">${safeRoute}</span></h1>
  </div>
  <p class="sub" id="status-line">Waking up containers… <span class="elapsed" id="elapsed">0s</span></p>
  <div class="term" id="log"><div class="line">Waiting for container logs…</div></div>
  <p class="error" id="error">Startup failed.<button onclick="location.reload()">Retry</button></p>
  <p class="footer">This page will refresh automatically once the service is ready.</p>
</div>
<script>
(function () {
  var route = ${JSON.stringify(route)};
  // Direct access hits /proxy/<route>/…; behind nginx the subdomain root maps there already.
  var prefix = location.pathname.indexOf("/proxy/" + route) === 0 ? "/proxy/" + route : "";
  var base = prefix + "/__wake";

  var start = Date.now();
  var logEl = document.getElementById("log");
  var firstLine = true;

  setInterval(function () {
    var s = Math.floor((Date.now() - start) / 1000);
    document.getElementById("elapsed").textContent =
      s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s";
  }, 1000);

  function addLine(text) {
    if (firstLine) { logEl.innerHTML = ""; firstLine = false; }
    var atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 10;
    var div = document.createElement("div");
    div.className = "line";
    div.textContent = text;
    logEl.appendChild(div);
    while (logEl.childNodes.length > 500) logEl.removeChild(logEl.firstChild);
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  // Live container logs over SSE
  var es = new EventSource(base + "/logs");
  es.onmessage = function (ev) {
    try { addLine(JSON.parse(ev.data)); } catch (e) { addLine(ev.data); }
  };
  es.onerror = function () { /* poller below handles reload/failure */ };

  // Poll readiness; reload the original URL once the service responds
  function poll() {
    fetch(base + "/status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (st) {
        if (st.ready) {
          document.getElementById("status-line").textContent = "Ready! Loading…";
          es.close();
          location.reload();
          return;
        }
        if (st.state === "failed") {
          document.getElementById("spinner").style.animationPlayState = "paused";
          document.getElementById("status-line").textContent = "Startup failed.";
          var errEl = document.getElementById("error");
          errEl.style.display = "block";
          if (st.error) errEl.firstChild.textContent = "Startup failed: " + st.error;
        }
        setTimeout(poll, 2000);
      })
      .catch(function () { setTimeout(poll, 2000); });
  }
  poll();
})();
</script>
</body>
</html>`;
}
