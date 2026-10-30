// The single-file journey viewer: inline CSS + JS, no network, the model embedded as JSON (scripts/obs/journey.ts).
// Tracks: marks & interactions, browser main thread, network per request, Cloudflare edge (front door), internal entrypoints,
// R2 / blocks, waitUntil. Critical path highlight, KPI row, coverage, hover/tap detail, zoom + pan (wheel, drag, pinch, keys),
// a keyboard-navigable request table, light + dark, 390 px.
export const viewerHtml = (model: unknown, title: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Journey trace</title>
<meta name="description" content="${title}: unified client and server trace">
<style>
:root{--bg:#f6f5f2;--panel:#fff;--ink:#16181d;--ink2:#565b66;--ink3:#8a8f99;--line:#e3e1dc;--grid:#eceae5;--accent:#d6336c;--focus:#2b6cf0;
--parse:#7b5cd6;--script:#d99a00;--style:#b45fc4;--layout:#6a4fd8;--paint:#2f9e5e;--gc:#8b8f97;--task:#c9ccd3;--other:#b9bcc4;--net:#9aa0aa;
--queue:#c4c7ce;--dns:#1f9e9a;--connect:#e8833a;--ssl:#9b5de5;--send:#3a7bd5;--wait:#7fc8a9;--download:#3a7bd5;
--edge:#f38020;--edge2:#f7b26b;--internal:#3a6fd8;--r2:#169c8a;--waituntil:#d6336c;--hit:#2f9e5e;--miss:#e8833a;--shadow:0 1px 2px rgba(0,0,0,.06),0 4px 16px rgba(0,0,0,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0e1014;--panel:#161920;--ink:#e8eaee;--ink2:#a7adb8;--ink3:#737a87;--line:#272b34;--grid:#1d2028;--accent:#ff5c8f;--focus:#6b9bff;
--task:#3a3f4a;--other:#4a505c;--queue:#4a505c;--wait:#3f8f6e;--edge2:#a65a1a;--shadow:none}}
:root[data-theme=dark]{--bg:#0e1014;--panel:#161920;--ink:#e8eaee;--ink2:#a7adb8;--ink3:#737a87;--line:#272b34;--grid:#1d2028;--accent:#ff5c8f;--focus:#6b9bff;
--task:#3a3f4a;--other:#4a505c;--queue:#4a505c;--wait:#3f8f6e;--edge2:#a65a1a;--shadow:none}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1280px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 2px;letter-spacing:-.01em}h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink2);margin:24px 0 8px}
.sub{color:var(--ink2);font-size:12.5px;word-break:break-word}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
button{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 10px;min-height:36px;cursor:pointer}
button:hover{border-color:var(--ink3)}button[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:14px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;box-shadow:var(--shadow)}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.15}.kpi span{font-size:11.5px;color:var(--ink2)}
.kpi small{display:block;font-size:11px;color:var(--ink3);margin-top:2px}
.cov{margin-top:10px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.cov.ok{border-left:4px solid var(--hit)}.cov.bad{border-left:4px solid var(--miss)}
.cov ul{margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--ink2)}
.tl{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-top:12px;overflow:hidden;box-shadow:var(--shadow)}
.bar{display:flex;flex-wrap:wrap;gap:6px;padding:8px;border-bottom:1px solid var(--line);align-items:center}
.bar .sp{flex:1}.bar .hint{font-size:11.5px;color:var(--ink3)}
#ov{display:block;width:100%;height:36px;border-bottom:1px solid var(--line);cursor:pointer;touch-action:none}
#cv{display:block;width:100%;touch-action:pan-y;cursor:grab}#cv:active{cursor:grabbing}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;padding:8px 10px;border-top:1px solid var(--line);font-size:11.5px;color:var(--ink2)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
#tip{position:fixed;z-index:10;pointer-events:none;max-width:min(360px,calc(100vw - 24px));background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.18);display:none}
#tip b{display:block;margin-bottom:2px}#tip table,.det table{border-collapse:collapse}#tip td,.det td{padding:1px 8px 1px 0;vertical-align:top;word-break:break-all}#tip td:first-child,.det td:first-child{color:var(--ink3);white-space:nowrap;word-break:normal}
.det{min-height:56px;padding:10px 12px;border-top:1px solid var(--line);font-size:12.5px}.det .empty{color:var(--ink3)}
.costs{display:grid;gap:8px}.cost{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:grid;grid-template-columns:auto 1fr;gap:2px 12px;align-items:baseline}
.cost b{font-size:20px;font-variant-numeric:tabular-nums;grid-row:span 2}.cost span{font-weight:600}.cost small{color:var(--ink2);font-size:12px}
.tw{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
table.req{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
table.req th{position:sticky;top:0;background:var(--panel);text-align:left;font-weight:600;color:var(--ink2);font-size:11.5px;padding:8px;border-bottom:1px solid var(--line);white-space:nowrap}
table.req td{padding:6px 8px;border-bottom:1px solid var(--grid);white-space:nowrap}table.req tr{cursor:pointer}table.req tr:hover td,table.req tr[aria-selected=true] td{background:color-mix(in srgb,var(--focus) 10%,transparent)}
table.req td.p{max-width:220px;overflow:hidden;text-overflow:ellipsis}
.tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;font-weight:600;line-height:18px}
.tag.HIT{background:color-mix(in srgb,var(--hit) 18%,transparent);color:var(--hit)}.tag.MISS,.tag.EXPIRED{background:color-mix(in srgb,var(--miss) 20%,transparent);color:var(--miss)}
.tag.LOCAL,.tag.n{background:var(--grid);color:var(--ink2)}.tag.crit{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.ok{color:var(--hit)}.warn{color:var(--miss)}
.off{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13px}
footer{color:var(--ink3);font-size:11.5px;margin:24px 0 8px}
@media (max-width:520px){main{padding:12px 16px}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi b{font-size:19px}h1{font-size:18px}.bar .hint{display:none}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<main>
<div class="top"><div><h1 id="h"></h1><div class="sub" id="meta"></div></div>
<button id="theme" aria-label="Toggle light or dark theme">◐</button></div>
<section class="kpis" id="kpis" aria-label="Key numbers"></section>
<div class="cov" id="cov" role="status"></div>
<section class="tl" aria-label="Unified timeline">
 <div class="bar" role="toolbar" aria-label="Timeline controls">
  <button id="zin" aria-label="Zoom in">+</button><button id="zout" aria-label="Zoom out">−</button>
  <button id="fitload">Page load</button><button id="fitall">Whole journey</button>
  <button id="critb" aria-pressed="false">Critical path</button>
  <span class="sp"></span><span class="hint">wheel / pinch zoom · drag pan · keys: ← → pan, + − zoom, 0 all, 1 load, n / p next span, Esc clear</span>
 </div>
 <canvas id="ov" aria-label="Overview of the whole journey; click to move the view" role="img"></canvas>
 <canvas id="cv" tabindex="0" role="application" aria-roledescription="timeline" aria-label="Timeline. Arrow keys pan, plus and minus zoom, n and p step through spans."></canvas>
 <div class="det" id="det" aria-live="polite"><span class="empty">Hover or tap a span for detail. Keyboard: focus the timeline, then n / p.</span></div>
 <div class="legend" id="legend"></div>
</section>
<h2>Top client-side costs</h2><div class="costs" id="costs"></div>
<h2>Clock offset</h2><div class="off" id="off"></div>
<h2>Every request</h2>
<div class="tw"><table class="req" id="rt"><thead><tr><th>#</th><th>request</th><th>type</th><th>st</th><th>start</th><th>dns+tcp+tls</th><th>wait</th><th>download</th><th>total</th><th>server cpu</th><th>cache</th><th>server</th></tr></thead><tbody></tbody></table></div>
<footer id="foot"></footer>
</main>
<div id="tip" role="tooltip"></div>
<script type="application/json" id="data">${JSON.stringify(model).replace(/</g, "\\u003c")}</script>
<script>
(function () {
"use strict";
var M = JSON.parse(document.getElementById("data").textContent);
var $ = function (id) { return document.getElementById(id); };
var root = document.documentElement;
try { var th = localStorage.getItem("journey-theme"); if (th) root.setAttribute("data-theme", th); } catch (e) {}
$("theme").onclick = function () {
  var dark = root.getAttribute("data-theme") ? root.getAttribute("data-theme") === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", dark ? "light" : "dark"); try { localStorage.setItem("journey-theme", dark ? "light" : "dark"); } catch (e) {}
  draw();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { draw(); });
function css(v) { return getComputedStyle(root).getPropertyValue("--" + v).trim(); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
function ms(x, d) { return x == null ? "–" : (Math.abs(x) >= 1000 ? (x / 1000).toFixed(2) + " s" : x.toFixed(d == null ? (Math.abs(x) < 10 ? 1 : 0) : d) + " ms"); }

// ---------- header ----------
var m = M.meta, k = M.kpi;
var rumSrc = m.source === "rum";
$("h").textContent = (m.page === "instrument" ? "/instrument" : "/") + " · " + (rumSrc ? "production RUM + server telemetry" : m.device.split(" ")[0] + " · " + (m.net === "none" ? "unthrottled" : m.net.split(" (")[0]) + (m.cpu > 1 ? " · " + m.cpu + "× CPU" : "") + " · " + m.mode);
$("meta").innerHTML = (rumSrc ? "source: Basin ephem.rum + ephem.requests_v2 + Workers Observability, by trace id · " + esc(m.client || "") : esc(m.device) + " · " + esc(m.net) + " · " + esc(m.chrome)) + "<br>" + (m.run ? "run <span class=mono>" + esc(m.run) + "</span> · " : "") + "ephem <span class=mono>" + esc(m.versions.join(", ")) + "</span> · trace <span class=mono>" + esc(m.traceId) + "</span>" + (rumSrc ? "" : " (document → " + (m.pageTraceId === m.traceId ? "page via " + esc(m.pageTraceFrom) : '<b class="warn">page used another id</b>') + ")") + " · " + esc(m.started) + " · " + m.durationS + " s · server ingest " + m.ingestS + " s";
function hm(o) { return Object.keys(o || {}).map(function (x) { return x + " " + o[x]; }).join(" · ") || "–"; }
var tiles = [
  ["TTFB", ms(k.ttfb), "document, from navigation start"],
  ["First paint", ms(k.fcp), "first contentful paint"],
  ["LCP", ms(k.lcp), "largest contentful paint"],
  ["Data drawn", ms(k.data), "first frame with an answer"],
  ["INP", ms(k.inp), rumSrc ? "interaction to next paint (Event Timing)" : "worst scripted input → next paint"],
  ["Requests", k.joined + " / " + k.requests, "joined to a server invocation"],
  ["Server CPU", k.serverCpu + " ms", k.invocations + " invocations (front + loopbacks)"],
  ["Api cache", hm(k.cache), "x-ephem-cache per request"],
  ["Blocks / geoid", hm(k.blocks), "isolate L1, Workers Cache, R2"],
  ["Long tasks", String(k.longTasks), "longest " + ms(k.longestTask)],
  ["Clock offset", "±" + ms(M.offset.plusMinusMs), "θ " + ms(M.offset.thetaMs, 1) + " from " + M.offset.n + " requests"],
];
if (m.rum) tiles.push(["RUM vs CDP", m.rum.within + " / " + m.rum.checks, "timings within " + m.rum.tolMs + " ms (max " + ms(m.rum.max, 1) + ") · " + m.rum.rows + " rows"]);
$("kpis").innerHTML = tiles.map(function (t) { return '<div class="kpi"><span>' + esc(t[0]) + "</span><b>" + esc(t[1]) + "</b><small>" + esc(t[2]) + "</small></div>"; }).join("");
var cv = M.coverage, allOk = cv.joined === cv.total;
$("cov").className = "cov " + (allOk ? "ok" : "bad");
var hits = M.reqs.filter(function (r) { return r.join === "joined" && r.reason; });
$("cov").innerHTML = "<b>" + cv.joined + " of " + cv.total + " requests joined to a server invocation</b> · " + cv.byTrace + " by trace id + cf-ray (document and every fetch), the rest by cf-ray (fonts, assets: no traceparent) · " + cv.fetchesSameTrace + " of " + cv.fetches + " fetches carried the document's trace id" +
  (cv.unjoined.length || hits.length ? "<ul>" + cv.unjoined.map(function (u) { return "<li><span class=mono>#" + u.i + " " + esc(u.url) + "</span>: " + esc(u.reason) + "</li>"; }).join("") +
  hits.map(function (r) { return "<li><span class=mono>#" + r.i + " " + esc(r.url) + "</span>: joined; " + esc(r.reason) + "</li>"; }).join("") + "</ul>" : "");
$("costs").innerHTML = M.costs.slice(0, 5).map(function (c, i) { return '<div class="cost"><b>' + ms(c.ms) + "</b><span>" + (i + 1) + ". " + esc(c.what) + "</span><small>" + esc(c.detail) + "</small></div>"; }).join("");
var o = M.offset;
$("off").innerHTML = "Server clock − client clock <b>θ = " + o.thetaMs.toFixed(1) + " ms ± " + o.plusMinusMs.toFixed(1) + " ms</b> (interval " + o.lo.toFixed(1) + " … " + o.hi.toFixed(1) + " ms), from " + o.n + " joined requests" +
  (o.consistent ? "" : ' <b class="warn">(bounds inconsistent: the tightest single request is used)</b>') + ". Each request bounds θ by (t3 − t4, t2 − t1): the Worker's root span starts after the browser sent (t1 → t2) and its first byte leaves before the browser has the headers (t3 → t4). Tightest single request: <span class=mono>" + esc(o.tightest && o.tightest.path) + "</span>, " + (o.tightest ? o.tightest.widthMs.toFixed(1) : "?") + " ms wide. Server spans are placed on the client clock with θ." + (m.sntp ? " Independent check: sntp " + esc(m.sntp.host) + " put the laptop's clock " + m.sntp.offsetMs + " ± " + m.sntp.errMs + " ms behind NTP." : "");
$("foot").textContent = "Generated by scripts/obs/journey.ts. Times are ms since navigation start on the browser's clock. Workers' clock is frozen during compute: compute spans read 0 ms, read server CPU instead. Perfetto: open the matching .perfetto.json at ui.perfetto.dev.";

// ---------- layout ----------
var critReq = {}, critSrv = {}, critMain = {};
M.crit.req.forEach(function (i) { critReq[i] = 1; }); M.crit.srv.forEach(function (i) { critSrv[i] = 1; }); M.crit.main.forEach(function (i) { critMain[i] = 1; });
var END = 0; M.reqs.forEach(function (r) { END = Math.max(END, r.end || r.start); }); M.main.forEach(function (e) { END = Math.max(END, e[0] + e[1]); });
M.srv.forEach(function (s) { END = Math.max(END, s.e); }); END = Math.max(END, 1);
var LOADEND = Math.max(k.data || 0, k.fontsDone || 0, k.fcp || 0) * 1.15 + 50;
// server span depth: root 0, Effect spans by their effect parent chain, other runtime spans 1
var byEff = {}; M.srv.forEach(function (s) { if (s.a["effect.span_id"]) byEff[s.trace + s.a["effect.span_id"]] = s; });
M.srv.forEach(function (s) {
  if (s.root) { s.d = 0; return; }
  if (s.a["effect.span_id"]) { var d = 1, p = s; while (p && p.a["effect.parent_id"] && byEff[p.trace + p.a["effect.parent_id"]] && d < 4) { p = byEff[p.trace + p.a["effect.parent_id"]]; d++; } s.d = d; return; }
  s.d = s.name === "jsRpcCall" ? 1 : 1;
});
function pack(groups, depthOf) { // groups: [{s,e,items}], lanes of height maxDepth
  var lanes = [], maxD = 0;
  groups.sort(function (a, b) { return a.s - b.s; }).forEach(function (g) {
    var gap = Math.max(2, (END) * 0.002), l = 0;
    while (lanes[l] != null && lanes[l] > g.s - gap) l++;
    lanes[l] = g.e; g.lane = l; g.items.forEach(function (it) { maxD = Math.max(maxD, depthOf(it)); });
  });
  return { lanes: Math.max(1, lanes.length), depth: maxD + 1 };
}
function groupBy(list, key) { var g = {}, out = []; list.forEach(function (x) { var kk = key(x); if (!g[kk]) { g[kk] = { s: Infinity, e: -Infinity, items: [] }; out.push(g[kk]); } g[kk].items.push(x); g[kk].s = Math.min(g[kk].s, x.s); g[kk].e = Math.max(g[kk].e, x.root && x.respEnd != null ? x.respEnd : x.e); /* pack by the response, not the waitUntil tail */ }); return out; }
var TR = [
  { id: "marks", name: "", h: 22 },
  { id: "main", name: "Main thread", depth: 4 },
  { id: "net", name: "Network" },
  { id: "edge", name: "Cloudflare edge · front door" },
  { id: "internal", name: "Internal entrypoints · Api / BlockStore / MetarFeed" },
  { id: "r2", name: "R2 · blocks · geoid · feed" },
  { id: "waituntil", name: "waitUntil · Basin send" },
];
var netGroups = M.reqs.map(function (r) { return { s: r.start, e: r.end || r.start + 1, items: [r], r: r }; });
var netP = pack(netGroups, function () { return 0; });
var srvTracks = {};
["edge", "internal", "r2", "waituntil"].forEach(function (t) {
  var items = M.srv.filter(function (s) { return s.track === t; });
  var groups = groupBy(items, function (s) { return t === "internal" ? s.trace : s.req + ":" + s.trace; });
  var p = pack(groups, function (it) { return t === "edge" ? it.d : (t === "internal" ? Math.min(it.d, 3) : 0); });
  srvTracks[t] = { groups: groups, lanes: p.lanes, depth: t === "edge" ? Math.min(p.depth, 4) : t === "internal" ? Math.min(p.depth, 4) : 1 };
});

// ---------- canvas ----------
var c = $("cv"), ov = $("ov"), ctx = c.getContext("2d"), octx = ov.getContext("2d");
var view = { a: -LOADEND * 0.02, b: LOADEND }, hover = null, sel = null, critOnly = false, hits = [];
var RH = 13, GAP = 6, LABEL = 16;
function rowH() { return innerWidth < 520 ? 11 : 14; }
function layout() {
  RH = rowH(); var y = 0;
  TR.forEach(function (t) {
    t.y = y; var rows;
    if (t.id === "marks") rows = 1;
    else if (t.id === "main") rows = 4;
    else if (t.id === "net") rows = netP.lanes;
    else rows = srvTracks[t.id].lanes * srvTracks[t.id].depth;
    t.rows = rows; t.h = LABEL + Math.max(1, rows) * RH + GAP; y += t.h;
  });
  return y + 18;
}
var W = 0, H = 0, dpr = 1;
function resize() {
  dpr = window.devicePixelRatio || 1; W = c.clientWidth; H = layout();
  c.style.height = H + "px"; c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  ov.width = Math.round(ov.clientWidth * dpr); ov.height = Math.round(36 * dpr);
  draw();
}
function X(t) { return (t - view.a) / (view.b - view.a) * W; }
function T(x) { return view.a + x / W * (view.b - view.a); }
var TASKN = { RunTask: 1, LoAF: 1, longtask: 1 };
var CATC = { parse: "parse", script: "script", style: "style", layout: "layout", paint: "paint", gc: "gc", task: "task", other: "other", net: "net" };
function rect(x0, x1, y, h, fill, item, outline) {
  if (x1 < 0 || x0 > W) return;
  var w = Math.max(1, x1 - x0);
  ctx.fillStyle = fill; ctx.fillRect(x0, y, w, h);
  if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = 2; ctx.strokeRect(x0 + 1, y + 1, Math.max(1, w - 2), h - 2); }
  if (item) hits.push({ x0: x0, x1: x0 + w, y0: y, y1: y + h, item: item });
}
function label(txt, x0, x1, y, h, color) {
  var w = x1 - x0; if (w < 28) return;
  ctx.save(); ctx.beginPath(); ctx.rect(Math.max(0, x0), y, Math.min(W, x1) - Math.max(0, x0), h); ctx.clip();
  ctx.fillStyle = color; ctx.font = (RH - 3) + "px ui-sans-serif,system-ui,sans-serif"; ctx.textBaseline = "middle";
  ctx.fillText(txt, Math.max(0, x0) + 3, y + h / 2 + .5); ctx.restore();
}
function dim(isCrit) { return critOnly && !isCrit ? .22 : 1; }
function draw() {
  if (!W) return;
  hits = [];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  var ink = css("ink"), ink2 = css("ink2"), ink3 = css("ink3"), grid = css("grid"), line = css("line"), accent = css("accent"), panel = css("panel");
  // grid + axis
  var span = view.b - view.a, step = Math.pow(10, Math.floor(Math.log10(span / 6))); if (span / step > 12) step *= 5; else if (span / step > 6) step *= 2;
  ctx.font = "10px ui-sans-serif,system-ui,sans-serif"; ctx.textBaseline = "top";
  for (var g = Math.ceil(view.a / step) * step; g <= view.b; g += step) { var gx = Math.round(X(g)) + .5; ctx.fillStyle = grid; ctx.fillRect(gx, 0, 1, H); ctx.fillStyle = ink3; ctx.fillText(ms(g, step < 1 ? 1 : 0), gx + 3, H - 14); }
  TR.forEach(function (t) {
    ctx.fillStyle = line; ctx.fillRect(0, t.y, W, 1);
    ctx.fillStyle = ink2; ctx.font = "600 10.5px ui-sans-serif,system-ui,sans-serif"; ctx.textBaseline = "top"; ctx.fillText(t.name.toUpperCase(), 6, t.y + 4);
  });
  var y0 = function (t) { return t.y + LABEL; };
  // main thread
  var tm = TR[1];
  M.main.forEach(function (e, i) {
    var x0 = X(e[0]), x1 = X(e[0] + e[1]); if (x1 < 0 || x0 > W || e[2] > 3) return;
    var cat = TASKN[e[3]] ? (e[1] >= 50 ? "long" : "task") : catOf(e[3]);
    var fill = cat === "long" ? accent : css(CATC[cat] || "other");
    ctx.globalAlpha = dim(critMain[i]);
    rect(x0, x1, y0(tm) + e[2] * RH, RH - 1, fill, { kind: "main", e: e, i: i }, critMain[i] && !critOnly ? null : null);
    if (cat === "long" && x1 - x0 > 2) { ctx.fillStyle = panel; ctx.globalAlpha = .55; for (var hx = x0; hx < x1; hx += 6) ctx.fillRect(hx, y0(tm), 2, RH - 1); }
    ctx.globalAlpha = 1;
    if (e[2] === 0 && x1 - x0 > 40) label(ms(e[1]), x0, x1, y0(tm), RH - 1, ink);
    else if (x1 - x0 > 50) label(e[3], x0, x1, y0(tm) + e[2] * RH, RH - 1, "#fff");
  });
  // network
  var tn = TR[2];
  netGroups.forEach(function (gp) {
    var r = gp.r, y = y0(tn) + gp.lane * RH, cr = critReq[r.i];
    ctx.globalAlpha = dim(cr);
    if (r.fromCache) rect(X(r.start), X(r.end || r.start), y + 3, RH - 7, css("queue"), { kind: "req", r: r });
    ["queue", "dns", "connect", "ssl", "send", "wait", "download"].forEach(function (p) { var s = r.ph[p]; if (s) rect(X(s[0]), X(s[1]), y + (p === "queue" ? 4 : 1), RH - (p === "queue" ? 9 : 3), css(p), { kind: "req", r: r, phase: p }); });
    if (!Object.keys(r.ph).length && !r.fromCache) rect(X(r.start), X(r.end || r.start + 1), y + 1, RH - 3, css("net"), { kind: "req", r: r });
    ctx.globalAlpha = 1;
    if (cr) { ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.strokeRect(X(r.start) - 1, y + .5, X(r.end || r.start) - X(r.start) + 2, RH - 2); }
    if (sel && sel.r === r) { ctx.strokeStyle = css("focus"); ctx.lineWidth = 2; ctx.strokeRect(X(r.start) - 2, y - .5, X(r.end || r.start) - X(r.start) + 4, RH); }
    var lx = X(r.end || r.start) + 3; if (lx < W - 30 && (view.b - view.a) < END * 0.6) { ctx.fillStyle = ink3; ctx.font = (RH - 3) + "px ui-sans-serif,system-ui,sans-serif"; ctx.textBaseline = "middle"; ctx.fillText(r.path.replace(/^\\/assets\\/[0-9a-f]+\\//, "") + (r.cache ? " " + r.cache : "") + (r.fromCache ? " (cache)" : ""), lx, y + RH / 2); }
  });
  // server tracks
  ["edge", "internal", "r2", "waituntil"].forEach(function (tid, ti) {
    var t = TR[3 + ti], st = srvTracks[tid], col = css(tid);
    st.groups.forEach(function (gp) {
      gp.items.forEach(function (s) {
        var d = tid === "edge" || tid === "internal" ? Math.min(s.d, st.depth - 1) : 0, y = y0(t) + (gp.lane * st.depth + d) * RH, cr = critSrv[s.k];
        ctx.globalAlpha = dim(cr);
        var fill = s.cache ? (/^HIT|^L1/.test(s.cache) ? css("hit") : /MISS|EXPIRED/.test(s.cache) ? css("miss") : col) : col;
        if (s.root && s.respEnd != null) { rect(X(s.s), X(s.respEnd), y + 1, RH - 2, col, { kind: "srv", s: s }); rect(X(s.respEnd), X(s.e), y + RH / 2 - 1, 2, css("edge2"), { kind: "srv", s: s, tail: true }); }
        else rect(X(s.s), X(Math.max(s.e, s.s)), y + 1, RH - 2, s.root ? col : fill, { kind: "srv", s: s });
        ctx.globalAlpha = 1;
        if (cr) { ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.strokeRect(X(s.s) - 1, y + .5, Math.max(2, X(s.e) - X(s.s)) + 2, RH - 1); }
        if (sel && sel.r && s.req === sel.r.i) { ctx.strokeStyle = css("focus"); ctx.lineWidth = 2; ctx.strokeRect(X(s.s) - 2, y, Math.max(2, X(s.e) - X(s.s)) + 4, RH); }
        label(s.label, X(s.s), X(s.respEnd != null ? s.respEnd : s.e), y + 1, RH - 2, "#fff");
      });
    });
  });
  // marks
  var tk = TR[0], lastEnd = -1;
  M.marks.slice().sort(function (p, q) { return p.t - q.t; }).forEach(function (mk) {
    var x = Math.round(X(mk.t)) + .5; if (x < 0 || x > W) return;
    var col = mk.kind === "input" ? css("focus") : mk.kind === "data" ? accent : mk.kind === "paint" ? css("paint") : ink3;
    ctx.fillStyle = col; ctx.globalAlpha = .35; ctx.fillRect(x, tk.y + LABEL, 1, H - tk.y - LABEL - 16); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(x, y0(tk) + RH - 2); ctx.lineTo(x - 5, y0(tk) + 1); ctx.lineTo(x + 5, y0(tk) + 1); ctx.closePath(); ctx.fill();
    hits.push({ x0: x - 6, x1: x + 6, y0: y0(tk), y1: y0(tk) + RH, item: { kind: "mark", m: mk } });
    if (mk.kind !== "nav") { ctx.fillStyle = col; ctx.font = "10px ui-sans-serif,system-ui,sans-serif"; ctx.textBaseline = "top"; var tw2 = ctx.measureText(mk.name).width; if (x + 7 + tw2 < W && x + 7 > lastEnd + 6) { ctx.fillText(mk.name, x + 7, tk.y + 4); lastEnd = x + 7 + tw2; } }
  });
  drawOverview();
}
function catOf(n) {
  if (/^(ParseHTML|ParseAuthorStyleSheet)$/.test(n)) return "parse";
  if (/^(EvaluateScript|v8\\.|V8\\.Compile|V8\\.Parse|FunctionCall|EventDispatch|TimerFire|FireAnimationFrame|RunMicrotasks|XHRReadyStateChange|FireIdleCallback|BlinkScheduler_PerformMicrotaskCheckpoint)/.test(n)) return "script";
  if (/^(UpdateLayoutTree|RecalculateStyles)$/.test(n)) return "style";
  if (/^(Layout|UpdateLayerTree|InlineNode)/.test(n)) return "layout";
  if (/^(Paint|PaintImage|PrePaint|Layerize|Commit|CompositeLayers|UpdateLayer|RasterTask|Decode)/.test(n)) return "paint";
  if (/GC/.test(n)) return "gc";
  if (/^Resource/.test(n)) return "net";
  return "other";
}
function drawOverview() {
  var w = ov.clientWidth, h = 36; octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.clearRect(0, 0, w, h);
  var ox = function (t) { return t / END * w; };
  octx.fillStyle = css("task"); M.main.forEach(function (e) { if (e[2] === 0 && e[1] > 2) octx.fillRect(ox(e[0]), 4, Math.max(1, ox(e[1])), 8); });
  M.reqs.forEach(function (r) { octx.fillStyle = css(r.fromCache ? "queue" : "send"); octx.fillRect(ox(r.start), 14, Math.max(1, ox((r.end || r.start) - r.start)), 6); });
  M.srv.forEach(function (s) { if (s.root) { octx.fillStyle = css(s.ep === "default" ? "edge" : "internal"); octx.fillRect(ox(s.s), 22, Math.max(1, ox(s.e - s.s)), 6); } });
  M.marks.forEach(function (mk) { octx.fillStyle = mk.kind === "input" ? css("focus") : mk.kind === "data" ? css("accent") : css("ink3"); octx.fillRect(ox(mk.t), 0, 1, h); });
  octx.fillStyle = css("focus"); octx.globalAlpha = .14; octx.fillRect(ox(view.a), 0, Math.max(2, ox(view.b) - ox(view.a)), h); octx.globalAlpha = 1;
  octx.strokeStyle = css("focus"); octx.lineWidth = 1; octx.strokeRect(ox(view.a) + .5, .5, Math.max(2, ox(view.b) - ox(view.a)) - 1, h - 1);
}

// ---------- detail ----------
function kv(rows) { return "<table>" + rows.filter(function (r) { return r[1] != null && r[1] !== ""; }).map(function (r) { return "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>"; }).join("") + "</table>"; }
function detail(it) {
  if (!it) return "";
  if (it.kind === "main") { var e = it.e; return "<b>" + esc(e[3]) + (TASKN[e[3]] && e[1] >= 50 ? " · long task" : "") + "</b>" + kv([["start", ms(e[0], 1)], ["duration", ms(e[1], 2)], ["category", TASKN[e[3]] ? "task" : catOf(e[3])], ["detail", e[4]], ["critical path", critMain[it.i] ? "yes" : null]]); }
  if (it.kind === "mark") return "<b>" + esc(it.m.name) + "</b>" + kv([["at", ms(it.m.t, 1)], ["input → next paint", it.m.latency != null ? ms(it.m.latency, 1) : null]]);
  if (it.kind === "req") { var r = it.r, ph = r.ph, d = function (p) { return ph[p] ? ms(ph[p][1] - ph[p][0], 1) : null; };
    return "<b>#" + r.i + " " + esc(r.method + " " + r.url) + "</b>" + kv([["phase", it.phase || null], ["status", r.status + (r.protocol ? " · " + r.protocol : "")], ["type", r.type], ["start → end", ms(r.start, 1) + " → " + ms(r.end, 1)],
      ["queue", d("queue")], ["dns", d("dns")], ["connect", d("connect")], ["tls", d("ssl")], ["send", d("send")], ["wait (TTFB)", d("wait")], ["download", d("download")], ["bytes", r.bytes ? (r.bytes / 1024).toFixed(1) + " KiB" : null],
      ["browser cache", r.fromCache], ["cf-ray", r.ray], ["x-ephem-cache", r.cache], ["server-timing", r.serverTiming], ["x-ephem-version", r.version], ["trace id", r.traceId], ["span id", r.spanId], ["joined by", r.join === "joined" ? (r.byTrace ? "trace id + cf-ray" : "cf-ray") : null],
      ["front door", r.front ? "cpu " + r.front.cpu + " ms · wall " + r.front.wall + " ms (incl. waitUntil) · " + r.front.colo + " · " + r.front.outcome : null],
      ["loopbacks", r.internal.map(function (x) { return x.ep + " " + x.path + " cpu " + x.cpu + " ms @" + x.colo; }).join("; ") || null], ["join", r.join + (r.reason ? ": " + r.reason : "")], ["critical path", critReq[r.i] ? "yes" : null]]); }
  if (it.kind === "srv") { var s = it.s, rows = [["entrypoint", s.ep], ["start → end", ms(s.s, 1) + " → " + ms(s.e, 1) + " (" + ms(s.e - s.s, 1) + ")"], ["response (TTFB)", s.ttfb != null ? s.ttfb + " ms; after it: waitUntil" : null], ["request", s.req >= 0 ? "#" + s.req + " " + (M.reqs[s.req] || {}).url : null], ["trace", s.trace]];
    Object.keys(s.a).forEach(function (kk) { if (!/^effect\\./.test(kk)) rows.push([kk, String(s.a[kk])]); });
    return "<b>" + esc(s.label) + (it.tail ? " · waitUntil tail" : "") + "</b>" + kv(rows); }
  return "";
}
var tip = $("tip");
function pick(x, y) { for (var i = hits.length - 1; i >= 0; i--) { var h = hits[i]; if (x >= h.x0 - 1 && x <= h.x1 + 1 && y >= h.y0 && y <= h.y1) return h.item; } return null; }
function showTip(it, cx, cy) {
  if (!it) { tip.style.display = "none"; return; }
  tip.innerHTML = detail(it); tip.style.display = "block";
  var tw = tip.offsetWidth, th2 = tip.offsetHeight, x = cx + 14, y = cy + 14;
  if (x + tw > innerWidth - 8) x = Math.max(8, cx - tw - 14); if (y + th2 > innerHeight - 8) y = Math.max(8, cy - th2 - 14);
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
function select(it) { sel = it; $("det").innerHTML = it ? detail(it) : '<span class="empty">Hover or tap a span for detail.</span>'; markRow(it && it.r ? it.r.i : it && it.s ? it.s.req : -1); draw(); }

// ---------- zoom / pan ----------
function clampView() { var span = Math.max(0.5, Math.min(END * 1.2, view.b - view.a)); var mid = (view.a + view.b) / 2; mid = Math.max(-END * 0.05 + span / 2 - span / 2, Math.min(END * 1.05, mid)); view.a = mid - span / 2; view.b = mid + span / 2; }
function zoom(f, at) { var t = at == null ? (view.a + view.b) / 2 : at; view.a = t - (t - view.a) * f; view.b = t + (view.b - t) * f; clampView(); draw(); }
function pan(dt) { view.a += dt; view.b += dt; clampView(); draw(); }
function fit(a, b) { var pad = (b - a) * 0.03; view.a = a - pad; view.b = b + pad; clampView(); draw(); }
c.addEventListener("wheel", function (e) {
  var r = c.getBoundingClientRect();
  if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), T(e.clientX - r.left)); }
  else if (Math.abs(e.deltaX) > 0) { e.preventDefault(); pan(e.deltaX / W * (view.b - view.a)); }
}, { passive: false });
var ptrs = {}, dragAt = null, pinch = null, moved = false;
c.addEventListener("pointerdown", function (e) { ptrs[e.pointerId] = { x: e.clientX, y: e.clientY }; moved = false;
  var ids = Object.keys(ptrs); if (ids.length === 1) dragAt = { x: e.clientX, y: e.clientY, a: view.a, b: view.b };
  if (ids.length === 2) { var p = ptrs[ids[0]], q = ptrs[ids[1]]; pinch = { d: Math.abs(p.x - q.x) || 1, a: view.a, b: view.b, mid: T((p.x + q.x) / 2 - c.getBoundingClientRect().left) }; dragAt = null; }
});
c.addEventListener("pointermove", function (e) {
  var r = c.getBoundingClientRect();
  if (ptrs[e.pointerId]) ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
  var ids = Object.keys(ptrs);
  if (pinch && ids.length === 2) { var p = ptrs[ids[0]], q = ptrs[ids[1]], f = pinch.d / (Math.abs(p.x - q.x) || 1); view.a = pinch.mid - (pinch.mid - pinch.a) * f; view.b = pinch.mid + (pinch.b - pinch.mid) * f; clampView(); draw(); moved = true; return; }
  if (dragAt && ids.length === 1) { var dx = e.clientX - dragAt.x, dy = e.clientY - dragAt.y;
    if (!moved && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) { moved = true; try { c.setPointerCapture(e.pointerId); } catch (er) {} }
    if (moved) { var dt = dx / W * (dragAt.b - dragAt.a); view.a = dragAt.a - dt; view.b = dragAt.b - dt; clampView(); draw(); showTip(null); return; } }
  if (e.pointerType === "mouse") { hover = pick(e.clientX - r.left, e.clientY - r.top); showTip(hover, e.clientX, e.clientY); }
});
function up(e) { var was = ptrs[e.pointerId]; delete ptrs[e.pointerId]; if (Object.keys(ptrs).length < 2) pinch = null;
  if (was && !moved && e.type === "pointerup") { var r = c.getBoundingClientRect(); select(pick(e.clientX - r.left, e.clientY - r.top)); }
  if (!Object.keys(ptrs).length) dragAt = null; }
c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
c.addEventListener("pointerleave", function () { showTip(null); });
// keyboard: pan / zoom / step through spans in time order
var order = [];
function buildOrder() { order = [];
  M.marks.forEach(function (mk) { order.push({ t: mk.t, it: { kind: "mark", m: mk } }); });
  M.reqs.forEach(function (r) { order.push({ t: r.start, it: { kind: "req", r: r } }); });
  M.srv.forEach(function (s) { order.push({ t: s.s, it: { kind: "srv", s: s } }); });
  M.main.forEach(function (e, i) { if (e[2] === 0 && e[1] >= 16) order.push({ t: e[0], it: { kind: "main", e: e, i: i } }); });
  order.sort(function (a, b) { return a.t - b.t; }); }
buildOrder(); var oi = -1;
function step(d) { if (!order.length) return; oi = (oi + d + order.length) % order.length; var o2 = order[oi], t = o2.t; if (t < view.a || t > view.b) { var sp = view.b - view.a; view.a = t - sp * 0.2; view.b = t + sp * 0.8; }
  select(o2.it); }
c.addEventListener("keydown", function (e) {
  var sp = view.b - view.a, h = { ArrowLeft: function () { pan(-sp * 0.15); }, ArrowRight: function () { pan(sp * 0.15); }, "+": function () { zoom(0.7); }, "=": function () { zoom(0.7); }, "-": function () { zoom(1 / 0.7); },
    "0": function () { fit(0, END); }, "1": function () { fit(0, LOADEND); }, n: function () { step(1); }, p: function () { step(-1); }, Escape: function () { select(null); } }[e.key];
  if (h) { e.preventDefault(); h(); }
});
$("zin").onclick = function () { zoom(0.6); }; $("zout").onclick = function () { zoom(1 / 0.6); };
$("fitload").onclick = function () { fit(0, LOADEND); }; $("fitall").onclick = function () { fit(0, END); };
$("critb").onclick = function () { critOnly = !critOnly; this.setAttribute("aria-pressed", String(critOnly)); draw(); };
ov.addEventListener("pointerdown", function (e) { var r = ov.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * END, sp = view.b - view.a; view.a = t - sp / 2; view.b = t + sp / 2; clampView(); draw(); });

// ---------- legend, table ----------
var LG = [["parse", "parse"], ["script", "script"], ["style", "style"], ["layout", "layout"], ["paint", "paint"], ["task", "task"], ["accent", "long task ≥ 50 ms"], ["dns", "dns"], ["connect", "connect"], ["ssl", "tls"], ["send", "send"], ["wait", "wait (TTFB)"], ["download", "download"],
  ["edge", "front door"], ["edge2", "after response (waitUntil)"], ["internal", "Api / BlockStore"], ["hit", "cache HIT / L1"], ["miss", "cache MISS"], ["r2", "R2 / blocks"], ["waituntil", "Basin send"]];
$("legend").innerHTML = LG.map(function (l) { return '<span><i style="background:var(--' + l[0] + ')"></i>' + esc(l[1]) + "</span>"; }).join("") + '<span><i style="background:transparent;outline:2px solid var(--accent)"></i>critical path to data drawn</span>';
var tb = $("rt").querySelector("tbody");
tb.innerHTML = M.reqs.map(function (r) {
  var d = function (p) { return r.ph[p] ? r.ph[p][1] - r.ph[p][0] : 0; }, conn = d("dns") + d("connect") + d("ssl");
  var cpu = r.front ? r.front.cpu + r.internal.reduce(function (a, x) { return a + x.cpu; }, 0) : null;
  var cache = r.fromCache ? '<span class="tag n">browser</span>' : r.cache ? '<span class="tag ' + esc(r.cache) + '">' + esc(r.cache) + "</span>" : "";
  var srv = r.join === "joined" ? '<span class="ok">✓</span> ' + esc(r.front.colo || "") + (r.internal.length ? " +" + r.internal.map(function (x) { return x.ep; }).join("+") : "") : '<span class="warn">' + esc(r.join) + "</span>";
  return '<tr tabindex="0" data-i="' + r.i + '" aria-selected="false"><td>' + r.i + (critReq[r.i] ? ' <span class="tag crit">crit</span>' : "") + '</td><td class="p mono" title="' + esc(r.url) + '">' + esc(r.url) + "</td><td>" + esc(r.type) + "</td><td>" + r.status + "</td><td>" + ms(r.start) + "</td><td>" + (conn ? ms(conn) : "") + "</td><td>" + (r.ph.wait ? ms(d("wait")) : "") + "</td><td>" + (r.ph.download ? ms(d("download")) : "") + "</td><td>" + ms((r.end || r.start) - r.start) + "</td><td>" + (cpu != null ? cpu + " ms" : "") + "</td><td>" + cache + "</td><td>" + srv + "</td></tr>";
}).join("");
function markRow(i) { Array.prototype.forEach.call(tb.rows, function (tr) { tr.setAttribute("aria-selected", String(+tr.getAttribute("data-i") === i)); }); }
function openRow(tr) { var r = M.reqs[+tr.getAttribute("data-i")]; var ss = M.srv.filter(function (s) { return s.req === r.i; }), a = r.start, b = r.end || r.start + 1;
  ss.forEach(function (s) { a = Math.min(a, s.s); b = Math.max(b, s.e); }); fit(a, b); select({ kind: "req", r: r }); $("cv").scrollIntoView({ block: "nearest", behavior: "smooth" }); }
tb.addEventListener("click", function (e) { var tr = e.target.closest("tr"); if (tr) openRow(tr); });
tb.addEventListener("keydown", function (e) { var tr = e.target.closest("tr"); if (!tr) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRow(tr); }
  if (e.key === "ArrowDown" && tr.nextElementSibling) { e.preventDefault(); tr.nextElementSibling.focus(); }
  if (e.key === "ArrowUp" && tr.previousElementSibling) { e.preventDefault(); tr.previousElementSibling.focus(); } });
addEventListener("resize", resize);
resize();
})();
</script></body></html>`
