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

// NOTE: String.raw is essential here — the page's inline JS is full of regex
// escapes (\d, \[, \u001b, ...) that a normal template literal would mangle.
function renderDefaultWakePage(route: string): string {
  const safeRoute = escapeHtml(route);
  const routeJson = JSON.stringify(route);
  return String.raw`<!DOCTYPE html>
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
  .sub { color: #8b949e; font-size: 0.9rem; margin: 0 0 1rem 0; }
  .sub .elapsed { color: #e6edf3; font-variant-numeric: tabular-nums; }
  .progress {
    display: none;
    height: 6px;
    background: #21262d;
    border-radius: 3px;
    overflow: hidden;
    margin: 0 0 1.25rem 0;
  }
  .progress .bar {
    height: 100%;
    width: 0%;
    background: #2f81f7;
    border-radius: 3px;
    transition: width 0.8s ease;
  }
  .term {
    background: #010409;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 0.9rem 1rem;
    height: 320px;
    overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace;
    font-size: 0.78rem;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .term .line { color: #c9d1d9; }
  .term .line.err { color: #ff7b72; }
  .term .line.warn { color: #d29922; }
  .term .dim { color: #6e7681; }
  .term .svc { font-weight: 600; }
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
  <p class="sub" id="status-line">Waking up containers… <span class="elapsed" id="elapsed">0s</span><span id="eta"></span></p>
  <div class="progress" id="progress"><div class="bar" id="bar"></div></div>
  <div class="term" id="log"><div class="line dim">Waiting for container logs…</div></div>
  <p class="error" id="error">Startup failed.<button onclick="location.reload()">Retry</button></p>
  <p class="footer">This page will refresh automatically once the service is ready.</p>
</div>
<script>
(function () {
  var route = ${routeJson};
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

  // Service-name prefix colors (like docker compose) and the ANSI palette
  var PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#39c5cf", "#ff9bce", "#7ee787", "#79c0ff"];
  var ANSI = { 30:"#484f58",31:"#ff7b72",32:"#3fb950",33:"#d29922",34:"#58a6ff",35:"#bc8cff",36:"#39c5cf",37:"#b1bac4",
               90:"#6e7681",91:"#ffa198",92:"#56d364",93:"#e3b341",94:"#79c0ff",95:"#d2a8ff",96:"#56d4dd",97:"#f0f6fc" };

  function serviceColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function span(parent, text, color, cls) {
    if (!text) return;
    var s = document.createElement("span");
    s.textContent = text;
    if (color) s.style.color = color;
    if (cls) s.className = cls;
    parent.appendChild(s);
  }

  // Render a message honoring ANSI SGR color codes (16-color set)
  function renderMessage(parent, text) {
    // Dim a leading ISO timestamp, if any
    var ts = text.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.:Z+\-]*\s*/);
    if (ts) { span(parent, ts[0], null, "dim"); text = text.slice(ts[0].length); }

    var re = /\u001b\[([0-9;]*)m/g;
    var idx = 0, m, color = null;
    while ((m = re.exec(text)) !== null) {
      span(parent, text.slice(idx, m.index), color);
      var codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (var i = 0; i < codes.length; i++) {
        var c = codes[i];
        if (c === 0 || c === 39) color = null;
        else if (c === 38 || c === 48) { i += codes[i + 1] === 5 ? 2 : 4; } // skip 256/RGB colors
        else if (ANSI[c]) color = ANSI[c];
      }
      idx = re.lastIndex;
    }
    span(parent, text.slice(idx), color);
  }

  function addLine(raw) {
    // Strip escape sequences a browser can't render: OSC titles, cursor
    // movement and erase codes — and keep only the final state of \r overwrites
    var text = String(raw)
      .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[0-9;?]*[A-Za-ln-z]/g, "")
      .replace(/[\r\u0000-\u0008\u000b-\u001a]+$/g, "");
    var cr = text.lastIndexOf("\r");
    if (cr !== -1) text = text.slice(cr + 1);
    if (!text.replace(/\u001b\[[0-9;]*m/g, "").trim()) return;

    if (firstLine) { logEl.innerHTML = ""; firstLine = false; }
    var atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 10;
    var div = document.createElement("div");
    div.className = "line";

    // docker compose prefixes lines with "service-name  | "
    var pref = text.match(/^([\w.-]+)(\s+\|\s?)([\s\S]*)$/);
    var msg = pref ? pref[3] : text;
    // Tint whole line for plain (uncolored) error/warning output
    if (!/\u001b\[/.test(msg)) {
      if (/\b(error|fatal|exception|failed|panic)\b/i.test(msg)) div.className += " err";
      else if (/\bwarn(ing)?\b/i.test(msg)) div.className += " warn";
    }
    if (pref) {
      span(div, pref[1], serviceColor(pref[1]), "svc");
      span(div, " | ", null, "dim");
    }
    renderMessage(div, msg);

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

  function fmtSecs(ms) {
    var s = Math.max(1, Math.round(ms / 1000));
    return s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s";
  }

  // Poll readiness; reload the original URL once the service responds
  function poll() {
    fetch(base + "/status", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (st) {
        if (st.ready) {
          document.getElementById("status-line").textContent = "Ready! Loading…";
          document.getElementById("bar").style.width = "100%";
          es.close();
          location.reload();
          return;
        }
        // Progress estimate from previous wake-ups of this service
        if (st.expectedMs) {
          var elapsedMs = st.elapsedMs != null ? st.elapsedMs : (Date.now() - start);
          document.getElementById("eta").textContent = " · usually ready in ~" + fmtSecs(st.expectedMs);
          document.getElementById("progress").style.display = "block";
          document.getElementById("bar").style.width =
            Math.min(95, Math.round(100 * elapsedMs / st.expectedMs)) + "%";
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
