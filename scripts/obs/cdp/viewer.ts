// The single-file journey viewer: inline CSS + JS + the Ephem DIN font, no network, the model embedded as JSON
// (scripts/obs/journey.ts, scripts/obs/trace-view.ts). A waterfall tree, one row per span (Honeycomb-style): each browser
// request is a parent row with its network phases inside its bar; its front-door invocation, every Effect span, loopback
// entrypoints (Api, BlockStore, MetarFeed) and waitUntil work (the Basin send, "after response") nest under it, placed by
// the clock offset with the ± as a whisker. One condensed browser main-thread row (long tasks + category activity; expand
// for the call tree). FCP / LCP / data drawn / interactions as lines across the waterfall; critical path to data drawn
// underlined in cyan (toggle dims the rest). Auto-fit to the page-load window, whole journey, zoom/pan (wheel on the axis or
// minimap, ⌘/ctrl-wheel or pinch on the rows, shift-wheel pan, W/S/A/D, + −), minimap. Click a row (or ↑ ↓ + Enter) for
// every attribute. Five key numbers; the rest in "Run details". Dark only (the site's mission-control style), 390 px:
// the name column narrows and the waterfall scrolls sideways inside its own container.
// The client script lives in a String.raw template: no backticks and no dollar-brace inside it; comments as /* */.
import { DIN_CSS } from "../../../packages/worker/src/din.ts"

const CSS = String.raw`
:root{--bg:#060708;--panel:#0b0d10;--raise:#11141a;--ink:#f2f4f7;--ink2:#c3c8d0;--muted:#8d939c;--faint:#555b64;
--line:rgba(242,244,247,.09);--grid:rgba(242,244,247,.04);--hover:rgba(242,244,247,.035);--accent:#6fd8f2;--sun:#f5b860;--moon:#c9d1de;
--caution:#e8a64a;--alert:#ef6a5e;--ok:#7cc9a0;
--queue:rgba(201,209,222,.16);--dns:#5fa8a0;--connect:#7d8fd6;--ssl:#a98bd8;--send:#c9d1de;--wait:rgba(201,209,222,.30);--download:#c9d1de;
--front:#f5b860;--eff:rgba(245,184,96,.58);--int:#f3d39f;--store:#c98f4c;
--din:"Ephem DIN","DIN Alternate","DIN 2014",Bahnschrift,-apple-system,system-ui,sans-serif;
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
--nw:360px;--ind:14px;--rh:24px;--ax:50px;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:400 13px/1.45 var(--sans);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
main{padding:0 24px 32px;transition:margin-right .16s}
.cap{font:500 10.5px/1.3 var(--din);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.tn{font-family:var(--din);font-variant-numeric:tabular-nums}
.mono{font-family:var(--mono);font-size:11.5px}
:focus-visible{outline:1.5px solid var(--accent);outline-offset:1px}
/* header */
.hd{display:flex;align-items:center;gap:14px;padding:16px 0 12px;border-bottom:1px solid var(--line);min-width:0}
.brand{font:700 13px/1 var(--din);letter-spacing:.3em;color:var(--ink);white-space:nowrap}
.hd h1{margin:0;font:500 12px/1.2 var(--din);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.hd .run{color:var(--faint);white-space:nowrap}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:1px solid var(--line)}
.kpi{padding:14px 0 14px;min-width:0}
.kpi+.kpi{padding-left:20px;border-left:1px solid var(--line)}
.kpi .v{display:block;margin-top:6px;font:400 30px/1 var(--din);font-variant-numeric:tabular-nums;letter-spacing:.01em;white-space:nowrap}
.kpi .v small{font-size:13px;letter-spacing:.12em;color:var(--muted);margin-left:4px;text-transform:uppercase}
.kpi .cap i{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:7px;vertical-align:1px}
/* run details */
details.rd{border-bottom:1px solid var(--line)}
details.rd>summary{list-style:none;cursor:pointer;padding:10px 0;display:flex;gap:10px;align-items:center}
details.rd>summary::-webkit-details-marker{display:none}
details.rd>summary::before,.tw::before{content:"";width:5px;height:5px;border:solid var(--muted);border-width:0 1.5px 1.5px 0;transform:rotate(-45deg);transition:transform .12s;flex:none}
details.rd[open]>summary::before,.tw.o::before{transform:rotate(45deg)}
details.rd>summary .cap{white-space:nowrap;flex:none}details.rd>summary .sum{flex:1;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rdg{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:4px 32px;padding:4px 0 18px}
.rdg section h3{margin:12px 0 6px}
.kv{display:grid;grid-template-columns:minmax(84px,max-content) minmax(0,1fr);gap:3px 14px;margin:0;font-size:12.5px}
.kv dt{font:500 10.5px/1.75 var(--din);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);max-width:180px;overflow-wrap:anywhere}
.kv dd{margin:0;color:var(--ink2);min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.ok{color:var(--ok)}.warn{color:var(--caution)}.bad{color:var(--alert)}
ul.ls,ol.ls{margin:0;padding-left:18px;color:var(--ink2);font-size:12.5px}ul.ls li,ol.ls li{margin:2px 0}
/* toolbar + minimap */
.tb{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:12px 0 8px}
.tb .sp{flex:1}
button{font:500 10.5px/1 var(--din);letter-spacing:.14em;text-transform:uppercase;color:var(--ink2);background:transparent;border:1px solid var(--line);border-radius:3px;padding:0 11px;height:30px;cursor:pointer;white-space:nowrap}
button:hover{color:var(--ink);border-color:rgba(242,244,247,.22)}
button[aria-pressed=true]{color:var(--accent);border-color:rgba(111,216,242,.5);background:rgba(111,216,242,.06)}
button.ic{width:30px;padding:0;font-size:14px;letter-spacing:0}
.tb .hint{color:var(--faint);font:500 10px/1.3 var(--din);letter-spacing:.1em;text-transform:uppercase;text-align:right}
.mm{position:relative;height:40px;border:1px solid var(--line);border-radius:3px;overflow:hidden;background:var(--panel);cursor:crosshair;touch-action:none;margin-bottom:10px}
.mm canvas{display:block;width:100%;height:100%}
#mmw{position:absolute;top:0;bottom:0;border:1px solid rgba(111,216,242,.55);border-radius:2px;box-shadow:0 0 0 9999px rgba(6,7,8,.6);cursor:grab;pointer-events:none}
#mmb{position:absolute;top:0;bottom:0;background:rgba(111,216,242,.12);border:1px dashed rgba(111,216,242,.5);display:none;pointer-events:none}
/* waterfall */
.sc{overflow-x:clip;border-top:1px solid var(--line);touch-action:pan-x pan-y}
.wf{position:relative;outline:none}
.row{display:grid;grid-template-columns:var(--nw) minmax(0,1fr);height:var(--rh);cursor:pointer}
.nm{position:sticky;left:0;z-index:3;background:var(--bg);display:flex;align-items:center;gap:7px;min-width:0;padding-right:10px;border-right:1px solid var(--line);white-space:nowrap;overflow:hidden;border-bottom:1px solid var(--grid)}
.tk{position:relative;overflow:hidden;border-bottom:1px solid var(--grid)}
.row:hover .nm,.row:hover .tk{background-color:#0c0e12}
.row.sel .nm,.row.sel .tk{background-color:#0d1a1f}
.row.sel .nm{box-shadow:inset 2px 0 0 var(--accent)}
.row.crit:not(.sel) .nm{box-shadow:inset 2px 0 0 rgba(111,216,242,.45)}
.tw{width:14px;height:14px;display:inline-grid;place-items:center;flex:none}
.n{overflow:hidden;text-overflow:ellipsis;min-width:0;color:var(--ink2);font-size:12.5px}
.n b{font-weight:500;color:var(--ink)}
.row.req .n{color:var(--muted)}
.row.group{--rh:28px}.row.group .nm,.row.group .tk{border-bottom-color:var(--line)}.row.group .b{top:9px;height:10px;opacity:.7}.row.group .lb{line-height:28px}
.row.req{--rh:28px}.row.req .nm,.row.req .tk{border-bottom-color:var(--line)}
.row.off .n,.row.off .n b{color:var(--faint)}
.row.aft .n{color:var(--muted)}
.tg{font:500 9.5px/1 var(--din);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);flex:none}
.bd{font:500 9.5px/1 var(--din);letter-spacing:.1em;text-transform:uppercase;padding:3px 5px 2px;border-radius:2px;border:1px solid var(--line);color:var(--muted);flex:none}
.bd.hit{color:var(--ok);border-color:rgba(124,201,160,.35)}.bd.miss{color:var(--caution);border-color:rgba(232,166,74,.4)}.bd.err{color:var(--alert);border-color:rgba(239,106,94,.45)}
.bd.lt{color:var(--alert);border-color:rgba(239,106,94,.45)}
.b{position:absolute;top:calc(var(--rh) / 2 - 6px);height:12px;border-radius:1.5px;min-width:2px}
.row.req .b{top:8px;height:12px}
.b.base{background:rgba(201,209,222,.07)}
.b.p-queue{background:var(--queue)}.b.p-dns{background:var(--dns)}.b.p-connect{background:var(--connect)}.b.p-ssl{background:var(--ssl)}
.b.p-send{background:var(--send)}.b.p-wait{background:var(--wait)}.b.p-download{background:var(--download)}
.b.front{background:var(--front)}.b.eff{background:var(--eff)}.b.int{background:var(--int)}.b.int2{background:rgba(243,211,159,.55)}.b.store{background:var(--store)}
.b.sub{background:rgba(245,184,96,.10);box-shadow:inset 0 0 0 1px rgba(245,184,96,.65)}
.b.after{background:repeating-linear-gradient(135deg,rgba(245,184,96,.34) 0 2px,transparent 2px 5px);box-shadow:inset 0 0 0 1px rgba(245,184,96,.38)}
.b.cr{-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 28px),transparent)}
.b.body{background:linear-gradient(to bottom,rgba(245,184,96,.5),rgba(245,184,96,.32));box-shadow:inset 0 1px 0 rgba(245,184,96,.8)}
.b.alive{top:calc(var(--rh) / 2 - 1px);height:2px;background:rgba(245,184,96,.35);border-radius:0}
.b.zero{width:2px;min-width:2px;background:var(--eff)}
.b.wh{top:calc(var(--rh) / 2 - 4px);height:8px;border-left:1px solid rgba(245,184,96,.35);border-right:1px solid rgba(245,184,96,.35);background:linear-gradient(to bottom,transparent 3.5px,rgba(245,184,96,.28) 3.5px 4.5px,transparent 4.5px);border-radius:0}
.tk .b.cl,.row.req .tk .b.cl{top:auto;bottom:2px;height:2px;background:var(--accent);border-radius:1px}
.lb{position:absolute;top:0;line-height:var(--rh);font:400 11px/var(--rh) var(--din);letter-spacing:.06em;color:var(--ink2);white-space:nowrap;text-transform:uppercase;pointer-events:none;font-variant-numeric:tabular-nums}
.row.req .lb{line-height:28px}
.lb{text-shadow:0 0 2px var(--bg),0 0 2px var(--bg)}.lb .c{color:var(--muted)}.lb .z{color:var(--faint)}.lb .mc{display:none;color:var(--ok)}
.lb.in{text-shadow:0 0 3px #000,0 0 3px #000}
.edge{position:absolute;top:0;font:500 10px/var(--rh) var(--din);letter-spacing:.08em;color:var(--faint);white-space:nowrap;text-transform:uppercase;pointer-events:none}
.row.req .edge{line-height:28px}
.edge.r{right:6px}.edge.l{left:6px}
.row.main{--rh:44px}
.row.main .nm{flex-wrap:wrap;align-content:center;row-gap:3px}
.row.main .sub{flex-basis:100%;padding-left:21px;font:500 9.5px/1 var(--din);letter-spacing:.1em;color:var(--muted);text-transform:uppercase;overflow:hidden;text-overflow:ellipsis}
.row.main .sub i,.lg i{display:inline-block;width:7px;height:7px;border-radius:1px;margin:0 4px 0 0;vertical-align:-0.5px}
.row.main .sub span+span{margin-left:8px}
.row.flame .nm{align-items:flex-start;padding-top:6px;flex-direction:column;gap:3px;padding-left:27px}
.row canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
/* axis */
.row.ax{--rh:var(--ax);cursor:grab;position:sticky;top:0;z-index:5}
.row.ax .nm,.row.ax .tk{background:var(--bg);border-bottom:1px solid var(--line)}
.row.ax .nm{padding-left:8px;align-items:flex-end;padding-bottom:7px}
.tick{position:absolute;top:6px;font:400 10px/1 var(--din);letter-spacing:.06em;color:var(--muted);white-space:nowrap;padding-left:4px;border-left:1px solid var(--line);height:12px;text-transform:uppercase;font-variant-numeric:tabular-nums}
.ml{position:absolute;font:500 9.5px/1 var(--din);letter-spacing:.1em;white-space:nowrap;text-transform:uppercase;pointer-events:auto;cursor:default}
.mk{position:absolute;top:var(--ax);bottom:0;left:var(--nw);right:0;pointer-events:none;z-index:2;overflow:hidden}
.mk i{position:absolute;top:0;bottom:0;width:1px}
.mk i.g{background:var(--grid)}
/* modes */
.critmode .row:not(.crit):not(.ax) .tk>*{opacity:.18}
.critmode .row:not(.crit):not(.ax) .n{opacity:.4}
/* legend + foot */
.lg{display:flex;flex-wrap:wrap;gap:6px 18px;padding:12px 0 0;font:500 9.5px/1.4 var(--din);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.lg>span{display:inline-flex;flex-wrap:wrap;gap:4px 10px}.lg span span{white-space:nowrap}.lg .h{color:var(--faint)}
.lg i.after{background:repeating-linear-gradient(135deg,rgba(245,184,96,.5) 0 2px,transparent 2px 4px);box-shadow:inset 0 0 0 1px rgba(245,184,96,.4)}
.lg i.sub{box-shadow:inset 0 0 0 1px rgba(245,184,96,.7)}
.lg i.cl{height:2px;width:12px;vertical-align:2px}
.lg i.line{width:1px;height:10px;vertical-align:-1px}
footer{color:var(--faint);font-size:11.5px;margin-top:20px;max-width:900px}
/* detail panel */
#det{position:fixed;z-index:20;background:var(--panel);border-left:1px solid var(--line);right:0;top:0;bottom:0;width:420px;transform:translateX(102%);transition:transform .16s;overflow:auto;padding:0 18px 24px;overscroll-behavior:contain}
body.dopen #det{transform:none}
#det .dh{position:sticky;top:0;background:var(--panel);padding:16px 0 10px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:flex-start;z-index:1}
#det .dh .t{flex:1;min-width:0}
#det h2{margin:4px 0 0;font:500 16px/1.3 var(--sans);overflow-wrap:anywhere}
#det h3{margin:16px 0 6px}
#det .ph{display:grid;grid-template-columns:10px 76px 1fr auto;gap:3px 8px;align-items:center;font-size:12.5px}
#det .ph i{width:10px;height:10px;border-radius:1.5px}
#det .ph .bar{height:6px;background:var(--grid);position:relative;border-radius:1px}
#det .ph .bar span{position:absolute;top:0;bottom:0;border-radius:1px}
#det a{color:var(--accent);cursor:pointer;text-decoration:none}
@media (min-width:1100px){body.dopen main{margin-right:420px}}
@media (max-width:1099px){#det{left:0;right:0;top:auto;width:auto;height:min(58vh,560px);border-left:0;border-top:1px solid var(--line);transform:translateY(102%);box-shadow:0 -12px 32px rgba(0,0,0,.5)}
body.dopen main{padding-bottom:min(58vh,560px)}}
@media (max-width:860px){.tb .hint{display:none}}
@media (max-width:720px){
:root{--nw:168px;--ind:7px;--rh:30px}
main{padding:0 16px 24px}
.hd{flex-wrap:wrap;gap:4px 12px}.hd h1{flex-basis:100%;order:3;font-size:11px}
.kpis{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:0}
.kpi{padding:12px 0}.kpi+.kpi{padding-left:12px}.kpi:nth-child(4){padding-left:0;border-left:0}
.kpi:nth-child(-n+3){border-bottom:1px solid var(--line)}
.kpi .v{font-size:24px}.kpi .v small{font-size:11px}
.sc{overflow-x:auto;-webkit-overflow-scrolling:touch}
.wf{min-width:calc(var(--nw) + 620px)}
.row.req{--rh:32px}.row.req .lb,.row.req .edge{line-height:32px}.row.req .b{top:10px}
.tg{display:none}.n{font-size:12px}.nm{gap:4px;padding-right:6px}
.row.srv .bd,.row.main .bd{display:none}.lb .mc{display:inline}
.row.main .sub{padding-left:6px}.row.main .sub span:nth-child(n+3){display:none}
.row.flame .nm{padding-left:8px}
.rdg{grid-template-columns:minmax(0,1fr)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`

const JS = String.raw`
(() => {
"use strict";
const $ = id => document.getElementById(id);
const M = JSON.parse($("data").textContent);
const meta = M.meta || {}, k = M.kpi || {}, off = M.offset || {}, PM = off.plusMinusMs || 0;
const rumSrc = meta.source === "rum";
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (x, d) => {
  if (x == null || !isFinite(x)) return "–";
  const a = Math.abs(x);
  if (a >= 1000) return (x / 1000).toFixed(a >= 10000 ? 1 : 2) + " s";
  return (d != null ? x.toFixed(d) : a > 0 && a < 10 ? x.toFixed(1) : String(Math.round(x))) + " ms";
};
const unitHtml = s => esc(s).replace(/ (ms|s)$/, "<small>$1</small>");
const kb = b => b == null ? "–" : b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : b >= 1024 ? Math.round(b / 1024) + " KB" : b + " B";
const css = v => getComputedStyle(document.documentElement).getPropertyValue("--" + v).trim();

/* ---------- browser main thread ---------- */
const TASKN = { RunTask: 1, LoAF: 1, longtask: 1 };
const CATS = ["script", "layout", "style", "paint", "parse", "gc"];
const CATC = { script: "#c7b45e", layout: "#8f7fd6", style: "#b294e0", paint: "#6fb38a", parse: "#6f9fd6", gc: "#8a909a", other: "#3a3f47", task: "#262a31", net: "#4a5260" };
function catOf(n) {
  if (/^(ParseHTML|ParseAuthorStyleSheet|HTMLDocumentParser|CSSParserImpl)/.test(n)) return "parse";
  if (/^(EvaluateScript|v8\.|V8\.Compile|V8\.Parse|V8\.PreParse|FunctionCall|EventDispatch|TimerFire|FireAnimationFrame|RunMicrotasks|XHRReadyStateChange|FireIdleCallback|BlinkScheduler_PerformMicrotaskCheckpoint)/.test(n)) return "script";
  if (/^(UpdateLayoutTree|RecalculateStyles|Document::updateStyle|Document::recalcStyle)/.test(n)) return "style";
  if (/^(Layout|UpdateLayerTree|InlineNode|LocalFrameView::layout|LocalFrameView::performLayout)/.test(n)) return "layout";
  if (/^(Paint|PaintImage|PrePaint|Layerize|Commit|CompositeLayers|UpdateLayer|RasterTask|Decode)/.test(n)) return "paint";
  if (/GC/.test(n)) return "gc";
  if (/^Resource/.test(n)) return "net";
  return "other";
}
const ev = M.main.map((e, i) => ({ i, s: e[0], d: e[1], z: e[2], n: e[3], x: e[4], c: TASKN[e[3]] ? "task" : catOf(e[3]), self: e[1] }))
  .sort((a, b) => a.s - b.s || a.z - b.z);
{ const st = []; for (const e of ev) { st.length = e.z; const p = e.z > 0 ? st[e.z - 1] : null; if (p) p.self -= e.d; st[e.z] = e; } for (const e of ev) e.self = Math.max(0, e.self); }
const tasks = ev.filter(e => e.z === 0 && (e.c === "task" || rumSrc));
const longT = tasks.filter(e => e.d >= 50);
const critMain = new Set(M.crit.main);
let busy = k.mainBusy && Object.keys(k.mainBusy).length ? k.mainBusy : null;
if (!busy) { busy = {}; for (const e of ev) if (CATS.includes(e.c)) busy[e.c] = (busy[e.c] || 0) + e.self; }
const busyToData = k.mainBusyToData && Object.keys(k.mainBusyToData).length ? k.mainBusyToData : null;

/* ---------- requests + spans: one tree ---------- */
const rEnd = r => r.end != null ? r.end : Math.max(r.start, ...Object.values(r.ph || {}).map(p => p[1]));
const reqByI = new Map(M.reqs.map(r => [r.i, r]));
const byId = new Map(M.srv.map(x => [x.id, x]));
const byEff = new Map(); for (const x of M.srv) if (x.a["effect.span_id"]) byEff.set(x.trace + ":" + x.a["effect.span_id"], x);
for (const x of M.srv) { let y = x, g = 0; while (y && y.req < 0 && g++ < 30) y = byId.get(y.parent); x.ri = y && y.req >= 0 ? y.req : -1; }
const parentOf = new Map(), claimed = new Set();
const isRuntimeFetch = x => x.name === "fetch" && !x.a["effect.span_id"] && !x.root;
for (const x of M.srv) {
  if (x.root && x.ep === "default") parentOf.set(x.k, "r" + x.ri);
  else if (x.a["effect.span_id"]) {
    const p = byEff.get(x.trace + ":" + x.a["effect.parent_id"]) || byId.get(x.parent);
    parentOf.set(x.k, p && p !== x ? "s" + p.k : "r" + x.ri);
  }
}
/* a runtime fetch (subrequest) under the Effect span that made it: same trace, contains it, nearest in emission order */
for (const x of M.srv) {
  if (parentOf.has(x.k) || x.root) continue;
  if (isRuntimeFetch(x)) {
    const c = M.srv.filter(y => y.trace === x.trace && y.a["effect.span_id"] && /fetch|load|feed/.test(y.name) && !claimed.has(y.k) && y.s <= x.s + 0.5 && y.e >= x.e - 0.5)
      .sort((a, b) => Math.abs(a.k - x.k) - Math.abs(b.k - x.k))[0];
    if (c) { claimed.add(c.k); parentOf.set(x.k, "s" + c.k); continue; }
  }
  const p = byId.get(x.parent); parentOf.set(x.k, p ? "s" + p.k : "r" + x.ri);
}
/* a loopback entrypoint's invocation under the front door's subrequest that contains it (± the clock) */
for (const x of M.srv) {
  if (!(x.root && x.ep !== "default")) continue;
  const f = M.srv.filter(y => y.ri === x.ri && y.ep === "default" && isRuntimeFetch(y) && y.s <= x.s + 1 && y.e >= x.e - 1).sort((a, b) => (a.e - a.s) - (b.e - b.s))[0];
  const front = M.srv.find(y => y.ri === x.ri && y.root && y.ep === "default");
  parentOf.set(x.k, f ? "s" + f.k : front ? "s" + front.k : "r" + x.ri);
}

let END = 1;
for (const r of M.reqs) END = Math.max(END, rEnd(r));
for (const e of ev) END = Math.max(END, e.s + e.d);
for (const x of M.srv) END = Math.max(END, x.e);
for (const m of M.marks) if (m.kind !== "nav") END = Math.max(END, m.t);

/* critical path: the model's walk back from data drawn; the document is always on it (it carries the page) */
const crit = { req: new Set(M.crit.req), srv: new Set(M.crit.srv) };
const doc = M.reqs.find(r => r.type === "Document");

const nodes = new Map();
const mk = (key, o) => { o.key = key; o.kids = []; o.parent = null; nodes.set(key, o); return o; };
const mainN = mk("main", { kind: "main", s: 0, e: END, crit: critMain.size > 0 });
const flameN = mk("flame", { kind: "flame", s: 0, e: END }); mainN.kids.push(flameN); flameN.parent = mainN;
const reqNs = M.reqs.slice().sort((a, b) => a.start - b.start).map(r => mk("r" + r.i, { kind: "req", r, s: r.start, e: rEnd(r), crit: crit.req.has(r.i) }));
for (const x of M.srv) if (x.ri >= 0 && reqByI.has(x.ri)) mk("s" + x.k, { kind: "srv", x, s: x.s, e: x.e });
for (const x of M.srv) {
  const n = nodes.get("s" + x.k); if (!n) continue;
  let p = nodes.get(parentOf.get(x.k)) || nodes.get("r" + x.ri);
  for (let q = p, g = 0; q && g < 40; q = q.parent, g++) if (q === n) { p = nodes.get("r" + x.ri); break; }
  if (p) { p.kids.push(n); n.parent = p; }
}
const sortKids = n => { n.kids.sort((a, b) => a.s - b.s || ((a.x && a.x.track === "waituntil") - (b.x && b.x.track === "waituntil")) || (b.e - b.s) - (a.e - a.s) || (a.x && b.x ? b.x.k - a.x.k : 0)); n.kids.forEach(sortKids); };
reqNs.forEach(sortKids);
const decorate = (n, after) => {
  if (n.kind === "srv") { n.after = after || n.x.track === "waituntil"; n.crit = crit.srv.has(n.x.k) || (crit.req.has(n.x.ri) && !n.after); }
  n.kids.forEach(c => decorate(c, n.after));
};
reqNs.forEach(n => decorate(n, false));
const subEnd = n => n.kids.reduce((a, c) => Math.max(a, subEnd(c)), n.e);
const subStart = n => n.kids.reduce((a, c) => Math.min(a, subStart(c)), n.s);

/* the page-load window: everything the page waited for, and every span of every request it started before then */
const tKey = Math.max(k.data || 0, k.lcp || 0, k.fcp || 0, doc ? rEnd(doc) : 0);
let L1 = tKey;
const fitEnd = n => n.kind === "srv" && n.after ? -Infinity : n.kids.reduce((a, c) => Math.max(a, fitEnd(c)), n.kind === "srv" && n.x.root && n.x.respEnd != null ? n.x.respEnd : n.e);
for (const n of reqNs) if (n.s <= tKey) L1 = Math.max(L1, fitEnd(n));
for (const e of tasks) if (e.s <= tKey) L1 = Math.max(L1, e.s + e.d);
if (!(L1 > 0)) L1 = END;
const LOAD = [0, Math.min(END * 1.01, L1 * 1.035 + 4)];
const ALL = [0, END * 1.015];

const early = reqNs.filter(n => n.s <= tKey || n.crit), late = reqNs.filter(n => !(n.s <= tKey || n.crit));
const groupN = late.length ? mk("later", { kind: "group", s: late[0].s, e: Math.max(...late.map(subEnd)) }) : null;
if (groupN) for (const n of late) { groupN.kids.push(n); n.parent = groupN; }
const open = new Set();
for (const n of reqNs) if (n.s <= tKey || n.crit) open.add(n.key);
for (const n of nodes.values()) if (n.kind === "srv" && n.kids.length) open.add(n.key);

/* ---------- labels ---------- */
const PH = ["queue", "dns", "connect", "ssl", "send", "wait", "download"];
const PHN = { queue: "queue", dns: "dns", connect: "connect", ssl: "tls", send: "send", wait: "wait (ttfb)", download: "download" };
const badge = v => {
  if (v == null || v === "") return "";
  const s = String(v), u = s.toUpperCase(), c = /^(HIT|L1|LOCAL|REVALIDATED|UPDATING)/.test(u) ? "hit" : /^(MISS|EXPIRED|STALE|BYPASS|DYNAMIC)/.test(u) ? "miss" : "";
  return '<span class="bd ' + c + '" title="cache: ' + esc(s) + '">' + esc(s.replace(/,/g, " ")) + "</span>";
};
const internalOf = x => { const r = reqByI.get(x.ri); return r && r.internal ? r.internal.find(v => v.trace === x.trace) : null; };
function srvName(x) {
  if (x.track === "waituntil") return { n: "Basin send", t: "waitUntil" };
  if (x.root && x.ep === "default") return { n: "<b>front door</b>", t: "worker · " + (x.a["cloudflare.colo"] || "") };
  if (x.root) { const p = x.a["url.path"] || (internalOf(x) || {}).path || ""; return { n: "<b>" + esc(x.ep) + "</b> " + esc(p.startsWith("/block/") ? "/block/…" : p), t: "entrypoint" }; }
  if (x.track === "r2") return { n: esc(x.name), t: "storage" };
  if (isRuntimeFetch(x)) return { n: "fetch", t: "subrequest" };
  return { n: esc(x.name), t: x.ep !== "default" ? x.ep : "" };
}
function srvCls(n) {
  const x = n.x;
  if (n.after) return "after";
  if (x.root) return x.ep === "default" ? "front" : "int";
  if (x.track === "r2") return "store";
  if (isRuntimeFetch(x)) return "sub";
  return x.ep !== "default" ? "int2" : "eff";
}
const ZERO = "Workers' clock only advances on I/O: compute reads 0 ms. Read the invocation's CPU instead.";
/* Workers' clock only advances on I/O: a span's wall is the I/O it waited on. Runtime spans (fetch, jsRpc, r2_*) are that
   I/O and print it; an Effect span with I/O below it (or 0 ms) prints "—"; CPU only on invocation rows. The detail keeps the value. */
const isIO = x => !x.root && !x.a["effect.span_id"];
const ioBelow = n => n.kids.reduce((m, c) => Math.max(m, c.kind === "srv" && isIO(c.x) ? c.e - c.s : 0, ioBelow(c)), 0);
const ms0 = d => fmt(d, d >= 1000 ? undefined : 0);
const frozen = n => { const d = n.e - n.s; return d < 0.5 || (!isIO(n.x) && !n.x.root && ioBelow(n) > 0); };
function srvLabel(n) {
  const x = n.x, d = n.e - n.s;
  if (x.root && x.ep === "default") {
    const r = reqByI.get(x.ri), cpu = r && r.front ? r.front.cpu : x.a.cpu_time_ms;
    if (x.respEnd == null) return ms0(d) + ' <span class="c">· cpu ' + ms0(cpu) + "</span>";
    return (x.bodyEnd != null ? "headers " + ms0(x.respEnd - x.s) + " · body " + ms0(x.bodyEnd - x.s) : "resp " + ms0(x.respEnd - x.s)) + ' <span class="c">· cpu ' + ms0(cpu) + " · wall " + ms0(d) + "</span>";
  }
  if (x.root) { const v = internalOf(x); return ms0(d) + (v ? ' <span class="c">· cpu ' + ms0(v.cpu) + "</span>" : ""); }
  if (n.after) return ms0(d);
  if (isIO(x)) return d < 0.5 ? '<span class="z">—</span>' : '<span class="c">i/o</span> ' + ms0(d);
  return frozen(n) ? '<span class="z">—</span>' : ms0(d);
}

/* ---------- view ---------- */
let v0 = LOAD[0], v1 = LOAD[1], sel = null, selEv = null, critOn = false, detOpen = false;
const P = t => (t - v0) / (v1 - v0) * 100;
const f3 = x => x.toFixed(3);
function bar(s, e, cls, title) {
  const a = P(s), b = P(e);
  if (b < 0 || a > 100) return "";
  const l = Math.max(a, 0), r = Math.min(b, 100);
  if (b > 100.2 && !/\b(cl|wh|base)\b/.test(cls)) cls += " cr";
  return '<i class="b ' + cls + '" style="left:' + f3(l) + "%;width:" + f3(r - l) + '%"' + (title ? ' title="' + esc(title) + '"' : "") + "></i>";
}
function lab(s, e, html, pad) {
  pad = pad || 0;
  const a = P(s - pad), b = P(e + pad);
  if (b < 0) return '<span class="edge l">← ' + esc(fmt(e)) + "</span>";
  if (a > 100) return '<span class="edge r">' + esc(fmt(s)) + " →</span>";
  if (b <= 78) return '<span class="lb" style="left:calc(' + f3(Math.max(b, 0)) + '% + 6px)">' + html + "</span>";
  if (a >= 24) return '<span class="lb" style="right:calc(' + f3(100 - a) + '% + 6px)">' + html + "</span>";
  return '<span class="lb in" style="right:calc(' + f3(100 - Math.min(b, 100)) + '% + 6px)">' + html + "</span>";
}
function flat() {
  const out = [];
  const walk = (n, d) => { n.depth = d; out.push(n); if (open.has(n.key)) for (const c of n.kids) walk(c, d + 1); };
  walk(mainN, 0); for (const n of early) walk(n, 0); if (groupN) walk(groupN, 0);
  return out;
}
const trackW = () => { const wf = $("wf"); return Math.max(100, wf.clientWidth - parseFloat(getComputedStyle(wf).getPropertyValue("--nw"))); };
function niceStep(span, n) { const raw = span / Math.max(1, n), mag = Math.pow(10, Math.floor(Math.log10(raw))); for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag; return 10 * mag; }
const tickFmt = (t, step) => t === 0 ? "0" : Math.abs(t) >= 1000 ? (t / 1000).toFixed(step >= 1000 ? 0 : step >= 100 ? 1 : 2) + " s" : (step < 1 ? t.toFixed(1) : String(Math.round(t))) + " ms";

/* markers */
const MK = [];
if (k.fcp != null) MK.push({ t: k.fcp, n: "FCP", c: "#6fb38a", w: "first contentful paint" });
if (k.lcp != null) MK.push({ t: k.lcp, n: "LCP", c: "#6fb38a", w: "largest contentful paint" });
if (k.data != null) MK.push({ t: k.data, n: "DATA DRAWN", c: "#6fd8f2", w: "first frame with an answer (ephem:data)", strong: 1 });
for (const m of M.marks) if (m.kind === "input") MK.push({ t: m.t, n: m.name.toUpperCase(), c: "#c9d1de", w: m.name + (m.latency != null ? ", latency " + fmt(m.latency) : ""), dash: 1 });
for (const nm of ["DOMContentLoaded", "load"]) { const m = M.marks.find(x => x.kind === "nav" && x.name === nm); if (m) MK.push({ t: m.t, n: nm === "load" ? "LOAD" : "DCL", c: "#555b64", w: nm, faint: 1 }); }
for (const m of M.marks) if (m.kind === "paint" && !/contentful/.test(m.name)) MK.push({ t: m.t, n: m.name.toUpperCase(), c: "#6fb38a", w: m.name });
MK.sort((a, b) => a.t - b.t);
const MKG = [];
for (const m of MK) { const g = MKG[MKG.length - 1]; if (g && Math.abs(g.t - m.t) < 0.5 && g.c === m.c) { g.n += " · " + m.n; g.w += "; " + m.w; } else MKG.push(Object.assign({}, m)); }

function axisHtml(tw) {
  const step = niceStep(v1 - v0, tw / 96);
  let h = "";
  for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) { const p = P(t); if (p < -0.01 || p > 100) continue; h += '<span class="tick" style="left:' + f3(p) + '%">' + esc(tickFmt(t, step)) + "</span>"; }
  const used = [[], []], rank = m => m.strong ? 0 : m.faint ? 3 : m.dash ? 2 : 1;
  for (const m of MKG.slice().sort((a, b) => rank(a) - rank(b) || a.t - b.t)) {
    const p = P(m.t); if (p < 0 || p > 100) continue;
    const x = p / 100 * tw, w = m.n.length * 6.6 + 8, right = x + w > tw;
    const x0 = right ? x - w : x, x1 = right ? x + 4 : x + w;
    const line = [0, 1].find(l => used[l].every(u => x1 + 4 < u[0] || x0 - 4 > u[1]));
    if (line == null) continue;
    used[line].push([x0, x1]);
    h += '<span class="ml" title="' + esc(m.w + " · " + fmt(m.t, 1)) + '" style="color:' + m.c + ";top:" + (22 + line * 13) + "px;" + (right ? "right:calc(" + f3(100 - p) + "% + 4px)" : "left:calc(" + f3(p) + "% + 4px)") + '">' + esc(m.n) + "</span>";
  }
  const nReq = M.reqs.length, nSpan = M.srv.length;
  return '<div class="row ax" id="ax" aria-hidden="true"><div class="nm"><span class="cap">' + nReq + " requests · " + nSpan + ' spans</span></div><div class="tk" id="axt">' + h + "</div></div>";
}
function markLayer(tw) {
  const step = niceStep(v1 - v0, tw / 96);
  let h = "";
  for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) { const p = P(t); if (p > 0 && p < 100) h += '<i class="g" style="left:' + f3(p) + '%"></i>'; }
  for (const m of MKG) {
    const p = P(m.t); if (p < 0 || p > 100) continue;
    const bg = m.dash ? "repeating-linear-gradient(to bottom," + m.c + " 0 3px,transparent 3px 6px)" : m.c;
    h += '<i style="left:' + f3(p) + "%;background:" + bg + ";opacity:" + (m.faint ? .5 : m.strong ? .85 : .55) + '"></i>';
  }
  return '<div class="mk">' + h + "</div>";
}

function nameCell(n) {
  const has = n.kids.length > 0, o = open.has(n.key);
  const tw = '<span class="tw' + (has ? (o ? " o" : "") : "") + '"' + (has ? ' data-tw="' + n.key + '"' : ' style="visibility:hidden"') + "></span>";
  const pad = ' style="padding-left:calc(' + n.depth + ' * var(--ind) + 6px)"';
  if (n.kind === "main") {
    const tot = CATS.filter(c => (busy[c] || 0) >= 0.5).sort((a, b) => busy[b] - busy[a]);
    return '<div class="nm"' + pad + ">" + tw + '<span class="n"><b>Main thread</b></span><span class="tg">browser</span>' + (longT.length ? '<span class="bd lt">' + longT.length + " long</span>" : "") +
      '<span class="sub">' + tot.map(c => '<span><i style="background:' + CATC[c] + '"></i>' + c + " " + Math.round(busy[c]) + "</span>").join("") + "</span></div>";
  }
  if (n.kind === "flame") return '<div class="nm"><span class="cap">call tree</span><span class="cap" style="color:var(--faint)">' + CATS.map(c => '<i style="display:inline-block;width:6px;height:6px;margin-right:4px;background:' + CATC[c] + '"></i>').join("") + "</span></div>";
  if (n.kind === "group") return '<div class="nm"' + pad + ">" + tw + '<span class="n"><b>' + n.kids.length + ' requests after load</b></span><span class="tg">polls · beacons</span></div>';
  if (n.kind === "req") {
    const r = n.r, st = r.status >= 400 || r.join === "failed" ? '<span class="bd err">' + esc(r.status || r.join) + "</span>" : "";
    const jn = r.join !== "joined" && r.join !== "failed" ? '<span class="bd">' + esc(r.join === "browser-cache" ? "browser cache" : r.join) + "</span>" : "";
    return '<div class="nm"' + pad + ' title="' + esc(r.method + " " + r.url) + '">' + tw + '<span class="n">' + esc(r.method) + " <b>" + esc(r.path) + "</b></span>" +
      '<span class="tg">' + esc(String(r.type || "").toLowerCase()) + "</span>" + badge(r.cache) + st + jn + "</div>";
  }
  const x = n.x, nm = srvName(x), cache = x.cache;
  return '<div class="nm"' + pad + ' title="' + esc(x.label) + '">' + tw + '<span class="n">' + nm.n + "</span>" + (nm.t ? '<span class="tg">' + esc(nm.t) + "</span>" : "") + badge(cache) + "</div>";
}
function trackCell(n) {
  let t = "";
  if (n.kind === "main" || n.kind === "flame") return '<div class="tk"><canvas data-c="' + n.kind + '"></canvas></div>';
  if (n.kind === "group") {
    for (const q of n.kids) t += bar(q.s, q.e, "p-download", q.r.method + " " + q.r.path + " · " + fmt(q.s));
    t += lab(n.s, n.e, esc(fmt(n.s)) + ' <span class="c">– ' + esc(fmt(n.e)) + "</span>");
    return '<div class="tk">' + t + "</div>";
  }
  if (n.kind === "req") {
    const r = n.r;
    t += bar(n.s, n.e, "base");
    for (const p of PH) if (r.ph && r.ph[p]) t += bar(r.ph[p][0], r.ph[p][1], "p-" + p, PHN[p] + " " + fmt(r.ph[p][1] - r.ph[p][0]));
    if (n.crit) t += bar(n.s, n.e, "cl");
    t += lab(n.s, n.e, esc(fmt(n.e - n.s)) + (r.bytes ? ' <span class="c">· ' + kb(r.bytes) + "</span>" : ""));
    return '<div class="tk">' + t + "</div>";
  }
  const x = n.x;
  if (x.root && PM) t += bar(n.s - PM, n.e + PM, "wh", "± " + fmt(PM, 1) + " clock offset");
  const respDone = x.bodyEnd != null ? x.bodyEnd : x.respEnd;
  if (x.root && x.ep === "default" && x.respEnd != null && !n.after) {
    t += bar(n.s, x.respEnd, "front", "headers: first byte " + ms0(x.respEnd - x.s));
    if (x.bodyEnd != null) t += bar(x.respEnd, x.bodyEnd, "body", "streaming body until " + fmt(x.bodyEnd, 1) + " (" + x.bodyEndFrom + ")");
    t += bar(respDone, n.e, "alive", "invocation alive after the response (waitUntil below)");
  } else t += bar(n.s, n.e, srvCls(n) + (n.e - n.s < 0.5 ? " zero" : ""), frozen(n) ? ZERO : "");
  if (n.crit) t += bar(n.s, x.root && respDone != null ? respDone : n.e, "cl");
  t += lab(n.s, n.e, srvLabel(n) + (x.cache ? ' <span class="mc">· ' + esc(x.cache) + "</span>" : ""), x.root ? PM : 0);
  return '<div class="tk">' + t + "</div>";
}
function rowHtml(n) {
  const c = ["row", n.kind];
  if (n.crit) c.push("crit"); if (n.key === sel) c.push("sel"); if (n.after) c.push("aft");
  if (n.kind !== "main" && n.kind !== "flame" && (subEnd(n) < v0 || subStart(n) > v1)) c.push("off");
  const has = n.kids.length > 0;
  return '<div class="' + c.join(" ") + '" id="row-' + n.key + '" data-k="' + n.key + '" role="treeitem" aria-level="' + (n.depth + 1) + '"' + (has ? ' aria-expanded="' + open.has(n.key) + '"' : "") +
    ' aria-selected="' + (n.key === sel) + '">' + nameCell(n) + trackCell(n) + "</div>";
}

let VIS = [];
function render() {
  const wf = $("wf"), tw = trackW();
  VIS = flat();
  let h = axisHtml(tw);
  for (const n of VIS) h += rowHtml(n);
  wf.innerHTML = h + markLayer(tw);
  wf.classList.toggle("critmode", critOn);
  if (sel) wf.setAttribute("aria-activedescendant", "row-" + sel); else wf.removeAttribute("aria-activedescendant");
  for (const c of wf.querySelectorAll("canvas")) c.dataset.c === "main" ? drawMain(c) : drawFlame(c);
  drawMini();
  $("bLoad").setAttribute("aria-pressed", String(Math.abs(v0 - LOAD[0]) < 1e-6 && Math.abs(v1 - LOAD[1]) < 1e-6));
  $("bAll").setAttribute("aria-pressed", String(Math.abs(v0 - ALL[0]) < 1e-6 && Math.abs(v1 - ALL[1]) < 1e-6));
  $("range").textContent = fmt(v0) + " – " + fmt(v1);
}
let raf = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

function ctx2d(c) {
  const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); return { g, w, h };
}
function drawMain(c) {
  const { g, w, h } = ctx2d(c), X = t => (t - v0) / (v1 - v0) * w;
  /* category activity (bottom band): self time per column, stacked */
  const COL = 2, ncol = Math.ceil(w / COL), colMs = (v1 - v0) / ncol, acc = {};
  for (const ct of CATS) acc[ct] = new Float32Array(ncol);
  for (const e of ev) {
    if (!acc[e.c] || e.self <= 0) continue;
    const a = X(e.s), b = X(e.s + e.d); if (b < 0 || a > w) continue;
    const c0 = Math.max(0, Math.floor(a / COL)), c1 = Math.min(ncol - 1, Math.floor(b / COL));
    const per = e.self / Math.max(e.d, 1e-6);
    for (let i = c0; i <= c1; i++) { const t0 = v0 + i * colMs, t1 = t0 + colMs, ov = Math.min(t1, e.s + e.d) - Math.max(t0, e.s); if (ov > 0) acc[e.c][i] += ov * per; }
  }
  const BH = 13, BY = h - 5;
  for (let i = 0; i < ncol; i++) {
    let y = BY;
    for (const ct of CATS) { const f = Math.min(1, acc[ct][i] / colMs); if (f <= 0) continue; const hh = Math.max(0.6, f * BH); g.fillStyle = CATC[ct]; g.fillRect(i * COL, y - hh, COL - 0.3, hh); y -= hh; if (y < BY - BH) break; }
  }
  g.fillStyle = "rgba(242,244,247,.06)"; g.fillRect(0, BY + 0.5, w, 1);
  /* tasks (top band), long ones labelled */
  const TY = 6, TH = 12;
  for (const e of tasks) {
    const a = X(e.s), b = X(e.s + e.d); if (b < 0 || a > w) continue;
    if (e.d >= 50) continue;
    g.fillStyle = "#2c3139"; g.fillRect(a, TY + 2, Math.max(1, b - a), TH - 4);
  }
  for (const e of tasks) if (critMain.has(e.i) && e.d < 50) { const a = X(e.s), b = X(e.s + e.d); g.strokeStyle = "#6fd8f2"; g.strokeRect(a + 0.5, TY + 0.5, Math.max(2, b - a) - 1, TH - 1); }
  g.font = "500 10px 'Ephem DIN', system-ui, sans-serif"; g.textBaseline = "middle";
  let lastLab = -1e9;
  for (const e of longT) {
    const a = X(e.s), b = X(e.s + e.d); if (b < 0 || a > w) continue;
    g.fillStyle = "rgba(239,106,94,.85)"; g.fillRect(a, TY, Math.max(2, b - a), TH);
    const over = X(e.s + 50); if (b - over > 3) { g.fillStyle = "rgba(6,7,8,.35)"; for (let hx = over; hx < b; hx += 4) g.fillRect(hx, TY, 1.5, TH); }
    if (critMain.has(e.i)) { g.strokeStyle = "#6fd8f2"; g.lineWidth = 1; g.strokeRect(a + 0.5, TY - 1.5, Math.max(2, b - a) - 1, TH + 3); }
    const txt = "LONG " + Math.round(e.d) + " MS", tx = Math.max(b, 0) + 5;
    const tw2 = g.measureText(txt).width;
    if (tx > lastLab && tx + tw2 < w) { g.fillStyle = "rgba(6,7,8,.88)"; g.fillRect(tx - 3, TY - 1, tw2 + 6, TH + 2); g.fillStyle = "#ef6a5e"; g.fillText(txt, tx, TY + TH / 2 + 0.5); lastLab = tx + tw2 + 6; }
  }
}
const FH = 15;
function drawFlame(c) {
  c.parentNode.parentNode.style.setProperty("--rh", (6 * FH + 8) + "px");
  const { g, w } = ctx2d(c), X = t => (t - v0) / (v1 - v0) * w;
  g.font = "10.5px -apple-system, system-ui, sans-serif"; g.textBaseline = "middle";
  const hits = [];
  for (const e of ev) {
    const a = X(e.s), b = X(e.s + e.d); if (b < 0 || a > w || b - a < 0.4) continue;
    const y = 4 + e.z * FH, x0 = Math.max(a, 0), x1 = Math.min(b, w);
    g.fillStyle = e.c === "task" ? (e.d >= 50 && e.z === 0 ? "rgba(239,106,94,.75)" : "#2c3139") : CATC[e.c] || CATC.other;
    g.globalAlpha = e.c === "other" || e.c === "task" ? 1 : .8;
    g.fillRect(x0, y, Math.max(0.8, x1 - x0 - 0.5), FH - 2);
    g.globalAlpha = 1;
    if (x1 - x0 > 36) { g.save(); g.beginPath(); g.rect(x0 + 3, y, x1 - x0 - 6, FH - 2); g.clip(); g.fillStyle = e.c === "other" || e.c === "task" ? "#c3c8d0" : "#0b0d10"; g.fillText(e.n, x0 + 3, y + (FH - 2) / 2 + 0.5); g.restore(); }
    if (sel === "flame" && selEv === e) { g.strokeStyle = "#6fd8f2"; g.strokeRect(x0 + 0.5, y + 0.5, Math.max(1, x1 - x0 - 1), FH - 3); }
    hits.push([x0, x1, y, y + FH - 2, e]);
  }
  c._hits = hits;
}

/* ---------- minimap ---------- */
function drawMini() {
  const c = $("mmc"), { g, w, h } = ctx2d(c), X = t => t / ALL[1] * w;
  const n = reqNs.length, lane = Math.max(1.5, Math.min(4, (h - 14) / Math.max(1, n)));
  reqNs.forEach((q, j) => {
    const y = 4 + j * ((h - 14) / Math.max(1, n));
    g.fillStyle = q.crit ? "rgba(111,216,242,.9)" : "rgba(201,209,222,.55)";
    g.fillRect(X(q.s), y, Math.max(1.5, X(q.e) - X(q.s)), Math.max(1, lane - 0.5));
    for (const ch of q.kids) { g.fillStyle = "rgba(245,184,96,.7)"; g.fillRect(X(ch.s), y + lane * 0.15, Math.max(1, X(ch.e) - X(ch.s)), Math.max(1, lane * 0.7 - 0.5)); }
  });
  for (const e of tasks) { g.fillStyle = e.d >= 50 ? "rgba(239,106,94,.9)" : "rgba(242,244,247,.18)"; g.fillRect(X(e.s), h - 7, Math.max(1, X(e.s + e.d) - X(e.s)), 4); }
  for (const m of MKG) if (!m.faint) { g.fillStyle = m.c; g.globalAlpha = .7; g.fillRect(X(m.t), 0, 1, h); g.globalAlpha = 1; }
  const wl = Math.max(0, X(v0)), wr = Math.min(w, X(v1));
  const mw = $("mmw"); mw.style.left = wl + "px"; mw.style.width = Math.max(3, wr - wl) + "px";
}

/* ---------- zoom / pan ---------- */
function clampView() {
  let span = Math.max(0.5, Math.min(v1 - v0, ALL[1] * 1.2));
  if (v1 - v0 !== span) { const m = (v0 + v1) / 2; v0 = m - span / 2; v1 = m + span / 2; }
  const lo = -ALL[1] * 0.02, hi = ALL[1] * 1.03;
  if (v0 < lo) { v1 += lo - v0; v0 = lo; }
  if (v1 > hi) { v0 -= v1 - hi; v1 = hi; }
  if (v0 < lo) v0 = lo;
}
function zoomAt(t, f) { v0 = t - (t - v0) * f; v1 = t + (v1 - t) * f; clampView(); schedule(); }
function pan(dt) { v0 += dt; v1 += dt; clampView(); schedule(); }
function setView(a, b) { v0 = a; v1 = b; clampView(); schedule(); }
function tAtClient(clientX) { const ax = $("axt"); if (!ax) return (v0 + v1) / 2; const r = ax.getBoundingClientRect(); return v0 + (clientX - r.left) / r.width * (v1 - v0); }

/* ---------- detail ---------- */
const kv = rows => '<dl class="kv">' + rows.filter(r => r && r[1] != null && r[1] !== "" && r[1] !== "–").map(r => "<dt>" + esc(r[0]) + "</dt><dd" + (r[2] ? ' class="mono"' : "") + ">" + (r[3] ? r[1] : esc(r[1])) + "</dd>").join("") + "</dl>";
function detailHtml(n) {
  const head = (cap, title) => '<div class="dh"><div class="t"><div class="cap">' + cap + "</div><h2>" + title + '</h2></div><button class="ic" id="dclose" aria-label="Close detail">×</button></div>';
  if (n.kind === "flame" && selEv) {
    const e = selEv;
    return head("main thread · " + esc(e.c), esc(e.n)) + kv([["start", fmt(e.s, 2)], ["duration", fmt(e.d, 2)], ["self", fmt(e.self, 2)], ["depth", String(e.z)], ["detail", e.x], ["long task", e.z === 0 && e.d >= 50 ? "yes (≥ 50 ms)" : null], ["critical path", critMain.has(e.i) ? "yes: data drawn ran in this task" : null]]);
  }
  if (n.kind === "main" || n.kind === "flame") {
    const rows = CATS.concat(["other"]).filter(c => busy[c] != null).map(c => [c, fmt(busy[c]) + (busyToData && busyToData[c] != null ? "  ·  " + fmt(busyToData[c]) + " before data drawn" : "")]);
    return head("browser", "Main thread") + "<h3 class=cap>self time" + (rumSrc ? " (RUM: long animation frames only)" : "") + "</h3>" + kv(rows) +
      "<h3 class=cap>long tasks (≥ 50 ms)</h3>" + (longT.length ? kv(longT.map(e => [fmt(e.s), fmt(e.d, 1) + (critMain.has(e.i) ? " · critical path" : "")])) : '<p class="cap" style="color:var(--faint)">none</p>') +
      kv([["tasks", String(tasks.length)], ["longest", fmt(k.longestTask || Math.max(0, ...tasks.map(e => e.d)), 1)], ["events", String(ev.length) + " (≥ 0.25 ms)"]]) +
      '<p class="cap" style="color:var(--faint);margin-top:14px">expand the row for the call tree; click a block for its detail</p>';
  }
  if (n.kind === "group") return head("after load", n.kids.length + " requests") + kv(n.kids.map(q => [fmt(q.s), q.r.method + " " + q.r.path + " · " + fmt(q.e - q.s) + (q.r.cache ? " · " + q.r.cache : "")]));
  if (n.kind === "req") {
    const r = n.r, tot = Math.max(0.001, n.e - n.s);
    const ph = PH.filter(p => r.ph && r.ph[p]).map(p => { const [a, z] = r.ph[p]; return '<i style="background:var(--' + p + ')"></i><span class="cap">' + PHN[p] + '</span><span class="bar"><span style="left:' + ((a - n.s) / tot * 100) + "%;width:" + Math.max(0.5, (z - a) / tot * 100) + "%;background:var(--" + p + ')"></span></span><span class="tn">' + esc(fmt(z - a)) + "</span>"; }).join("");
    const f = r.front;
    return head(esc(String(r.type || "request").toLowerCase()) + (n.crit ? ' · <span style="color:var(--accent)">critical path</span>' : ""), esc(r.method) + " " + esc(r.url)) +
      "<h3 class=cap>timing</h3>" + kv([["start", fmt(r.start, 1)], ["end", fmt(n.e, 1)], ["duration", fmt(n.e - n.s, 1)], ["size", r.bytes ? kb(r.bytes) + " (" + r.bytes + " B)" : null], ["status", String(r.status || "")], ["protocol", r.protocol]]) +
      (ph ? '<div class="ph" style="margin-top:10px">' + ph + "</div>" : "") +
      "<h3 class=cap>server</h3>" + kv([["join", r.join + (r.byTrace ? " (trace id + cf-ray)" : r.join === "joined" ? " (cf-ray)" : "")], ["note", r.reason], ["cf-ray", r.ray, 1], ["cache", r.cache], ["browser cache", r.fromCache],
        ["worker cpu", f ? fmt(f.cpu) : null], ["worker wall", f ? fmt(f.wall) + " (incl. waitUntil)" : null], ["colo", f && f.colo], ["outcome", f && f.outcome], ["version", (f && f.version) || r.version, 1],
        ["loopbacks", r.internal && r.internal.length ? r.internal.map(v => v.ep + " " + v.path + " · cpu " + fmt(v.cpu) + " · wall " + fmt(v.wall)).join("; ") : null]]) +
      "<h3 class=cap>trace</h3>" + kv([["trace id", r.traceId, 1], ["span id", r.spanId, 1], ["server trace", f && f.trace, 1], ["server-timing", r.serverTiming, 1]]);
  }
  const x = n.x, r = reqByI.get(x.ri), nm = srvName(x), d = n.e - n.s;
  const attrs = Object.keys(x.a).sort().map(key => [key, typeof x.a[key] === "object" ? JSON.stringify(x.a[key]) : String(x.a[key]), 1]);
  const v = x.root && x.ep !== "default" ? internalOf(x) : null;
  return head(esc(nm.t || (x.ep === "default" ? "front door span" : x.ep)) + (n.after ? " · waitUntil, after the response" : "") + (n.crit ? ' · <span style="color:var(--accent)">critical path</span>' : ""), nm.n.replace(/<\/?b>/g, "") + (x.cache ? " · " + esc(x.cache) : "")) +
    "<h3 class=cap>timing (browser clock)</h3>" + kv([["start", fmt(x.s, 1)], ["end", fmt(x.e, 1)], ["duration", d < 0.5 ? "0 ms · " + ZERO : fmt(d, 1)],
      ["headers", x.respEnd != null ? fmt(x.respEnd - x.s, 1) + " to first byte (runtime time_to_first_byte_ms)" : null],
      ["body", x.bodyEnd != null ? "streams until " + fmt(x.bodyEnd, 1) + " (" + fmt(x.bodyEnd - x.s, 1) + " after the start); end from the " + x.bodyEndFrom + ": the model has no span for the last chunk" : null],
      ["frozen clock", !x.root && frozen(n) ? "this wall time is the frozen-clock artefact: " + (d < 0.5 ? "no I/O inside it" : "its wall is the I/O below it (longest subrequest " + fmt(ioBelow(n), 1) + ")") + "; its compute is in the invocation's CPU" : null],
      ["cpu", x.root && x.ep === "default" && r && r.front ? fmt(r.front.cpu) : v ? fmt(v.cpu) : null],
      ["clock", PM ? "server − client θ = " + fmt(off.thetaMs, 1) + " ± " + fmt(PM, 1) + " (" + off.agree + "/" + off.n + " bounds agree)" : null]]) +
    "<h3 class=cap>span</h3>" + kv([["name", x.name], ["entrypoint", x.ep], ["request", r ? '<a data-go="r' + r.i + '">' + esc(r.method + " " + r.path) + "</a>" : null, 0, 1], ["cf-ray", r && r.ray, 1], ["trace id", x.trace, 1], ["span id", x.id, 1], ["parent", x.parent, 1]]) +
    (attrs.length ? "<h3 class=cap>attributes</h3>" + kv(attrs) : "");
}
function showDetail() {
  const n = nodes.get(sel); if (!n || !detOpen) return;
  $("det").innerHTML = detailHtml(n);
  $("dclose").onclick = closeDetail;
  for (const a of $("det").querySelectorAll("[data-go]")) a.onclick = () => select(a.dataset.go, true);
}
function openDetail() { if (!sel) return; detOpen = true; document.body.classList.add("dopen"); $("det").setAttribute("aria-hidden", "false"); showDetail(); schedule(); }
function closeDetail() { detOpen = false; document.body.classList.remove("dopen"); $("det").setAttribute("aria-hidden", "true"); schedule(); $("wf").focus({ preventScroll: true }); }
function select(key, detail) {
  let n = nodes.get(key); if (!n) return;
  for (let p = n.parent; p; p = p.parent) open.add(p.key);
  if (key !== "flame") selEv = null;
  sel = key; render();
  const el = $("row-" + key); if (el) el.scrollIntoView({ block: "nearest" });
  if (detail || detOpen) openDetail();
}

/* ---------- events ---------- */
const wf = $("wf"), sc = $("sc");
wf.addEventListener("click", e => {
  const tw = e.target.closest("[data-tw]");
  if (tw) { const kk = tw.dataset.tw; open.has(kk) ? open.delete(kk) : open.add(kk); sel = kk; schedule(); return; }
  const row = e.target.closest(".row"); if (!row || row.id === "ax") return;
  if (row.dataset.k === "flame" && e.target.tagName === "CANVAS") {
    const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const hit = (e.target._hits || []).filter(h => x >= h[0] - 1 && x <= h[1] + 1 && y >= h[2] && y <= h[3]).pop();
    selEv = hit ? hit[4] : null;
  }
  select(row.dataset.k, true);
  wf.focus({ preventScroll: true });
});
wf.addEventListener("dblclick", e => { const row = e.target.closest(".row"); if (!row || row.id === "ax") return; zoomTo(nodes.get(row.dataset.k)); });
function zoomTo(n) { if (!n) return; const a = subStart(n), b = subEnd(n), pad = Math.max(2, (b - a) * 0.08); setView(a - pad, b + pad * 2.5); }
wf.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const i = VIS.findIndex(n => n.key === sel), cur = VIS[i];
  const go = j => { const n = VIS[Math.max(0, Math.min(VIS.length - 1, j))]; if (n) select(n.key, false); };
  const span = v1 - v0;
  switch (e.key) {
    case "ArrowDown": case "j": go(i < 0 ? 0 : i + 1); break;
    case "ArrowUp": case "k": go(i < 0 ? 0 : i - 1); break;
    case "Home": go(0); break;
    case "End": go(VIS.length - 1); break;
    case "ArrowRight": if (cur && cur.kids.length) { if (!open.has(cur.key)) { open.add(cur.key); schedule(); } else go(i + 1); } break;
    case "ArrowLeft": if (cur && cur.kids.length && open.has(cur.key)) { open.delete(cur.key); schedule(); } else if (cur && cur.parent) select(cur.parent.key, false); break;
    case "Enter": case " ": if (cur) openDetail(); else go(0); break;
    case "Escape": if (detOpen) closeDetail(); else if (critOn) toggleCrit(); break;
    case "w": case "+": case "=": zoomAt((v0 + v1) / 2, 0.7); break;
    case "s": case "-": case "_": zoomAt((v0 + v1) / 2, 1 / 0.7); break;
    case "a": case "[": pan(-span * 0.15); break;
    case "d": case "]": pan(span * 0.15); break;
    case "0": viewAll(); break;
    case "1": viewLoad(); break;
    case "c": toggleCrit(); break;
    case "z": zoomTo(cur); break;
    default: return;
  }
  e.preventDefault();
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && detOpen && document.activeElement !== wf) closeDetail(); });

/* wheel: on the axis and the minimap the wheel zooms; on the rows ⌘/ctrl-wheel (and trackpad pinch) zooms, horizontal or shift-wheel pans */
const wheelZoom = (e, t) => { const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; zoomAt(t, Math.exp(Math.max(-0.5, Math.min(0.5, dy * 0.0025)))); };
sc.addEventListener("wheel", e => {
  const onAxis = !!e.target.closest("#ax");
  if (e.ctrlKey || e.metaKey || onAxis) { e.preventDefault(); wheelZoom(e, tAtClient(e.clientX)); return; }
  const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
  if (Math.abs(dx) > Math.abs(e.deltaY) || e.shiftKey) {
    if (sc.scrollWidth > sc.clientWidth + 1) return;   /* narrow: the container scrolls natively */
    e.preventDefault(); pan(dx / trackW() * (v1 - v0));
  }
}, { passive: false });
$("mm").addEventListener("wheel", e => { e.preventDefault(); const r = $("mm").getBoundingClientRect(); wheelZoom(e, (e.clientX - r.left) / r.width * ALL[1]); }, { passive: false });

/* drag the axis to pan; two-finger pinch on the rows to zoom */
const ptrs = new Map(); let drag = null, pinch = null;
sc.addEventListener("pointerdown", e => {
  ptrs.set(e.pointerId, e.clientX);
  if (ptrs.size === 2) {
    const xs = [...ptrs.values()], d = Math.abs(xs[0] - xs[1]);
    if (d > 10) pinch = { d, t: tAtClient((xs[0] + xs[1]) / 2), a: v0, b: v1 };
    drag = null; return;
  }
  if (e.target.closest("#ax") && e.button === 0) { drag = { x: e.clientX, a: v0, b: v1 }; sc.setPointerCapture(e.pointerId); }
});
sc.addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, e.clientX);
  if (pinch && ptrs.size === 2) {
    const xs = [...ptrs.values()], d = Math.max(10, Math.abs(xs[0] - xs[1])), f = pinch.d / d;
    v0 = pinch.t - (pinch.t - pinch.a) * f; v1 = pinch.t + (pinch.b - pinch.t) * f; clampView(); schedule(); e.preventDefault();
  } else if (drag) { const dt = (e.clientX - drag.x) / trackW() * (drag.b - drag.a); v0 = drag.a - dt; v1 = drag.b - dt; clampView(); schedule(); }
});
const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) drag = null; };
sc.addEventListener("pointerup", up); sc.addEventListener("pointercancel", up);

/* minimap: drag the window to move it, drag elsewhere to choose a range, click to centre */
let mmDrag = null;
$("mm").addEventListener("pointerdown", e => {
  const r = $("mm").getBoundingClientRect(), t = (e.clientX - r.left) / r.width * ALL[1];
  $("mm").setPointerCapture(e.pointerId);
  mmDrag = t >= v0 && t <= v1 ? { mode: "move", g: t - v0, s: v1 - v0, x: e.clientX } : { mode: "brush", t0: t, x: e.clientX };
});
$("mm").addEventListener("pointermove", e => {
  if (!mmDrag) return;
  const r = $("mm").getBoundingClientRect(), t = (e.clientX - r.left) / r.width * ALL[1];
  if (mmDrag.mode === "move") { v0 = t - mmDrag.g; v1 = v0 + mmDrag.s; clampView(); schedule(); }
  else { const a = Math.min(mmDrag.x, e.clientX) - r.left, b = Math.max(mmDrag.x, e.clientX) - r.left; const bb = $("mmb"); bb.style.display = "block"; bb.style.left = a + "px"; bb.style.width = (b - a) + "px"; }
});
$("mm").addEventListener("pointerup", e => {
  if (!mmDrag) return;
  const r = $("mm").getBoundingClientRect(), t = (e.clientX - r.left) / r.width * ALL[1];
  if (mmDrag.mode === "brush") {
    $("mmb").style.display = "none";
    if (Math.abs(e.clientX - mmDrag.x) < 4) { const s = v1 - v0; setView(t - s / 2, t + s / 2); } else setView(Math.min(mmDrag.t0, t), Math.max(mmDrag.t0, t));
  }
  mmDrag = null;
});

function toggleCrit() { critOn = !critOn; $("bCrit").setAttribute("aria-pressed", String(critOn)); schedule(); }
/* each view brings its fold state: page load opens the requests the page waited for, whole journey folds them and opens the later ones */
function viewLoad() { for (const n of early) open.add(n.key); if (groupN) open.delete(groupN.key); setView(LOAD[0], LOAD[1]); }
function viewAll() { for (const n of early) open.delete(n.key); if (groupN) open.add(groupN.key); setView(ALL[0], ALL[1]); }
$("bLoad").onclick = viewLoad;
$("bAll").onclick = viewAll;
$("bIn").onclick = () => zoomAt((v0 + v1) / 2, 0.6);
$("bOut").onclick = () => zoomAt((v0 + v1) / 2, 1 / 0.6);
$("bCrit").onclick = toggleCrit;
$("bExp").onclick = () => {
  const all = [...nodes.values()].filter(n => n.kids.length && n.kind !== "main");
  const allOpen = all.every(n => open.has(n.key));
  for (const n of all) allOpen ? open.delete(n.key) : open.add(n.key);
  $("bExp").textContent = allOpen ? "Expand all" : "Collapse all"; schedule();
};
new ResizeObserver(() => schedule()).observe(sc);

/* ---------- header, key numbers, run details ---------- */
const page = meta.page === "instrument" ? "/instrument" : "/";
const dev = rumSrc ? "production RUM" : [String(meta.device || "").replace(/ @\dx$/, ""), meta.net === "none" || !meta.net ? "unthrottled" : String(meta.net).split(" (")[0], meta.cpu > 1 ? meta.cpu + "× CPU" : "", meta.mode].filter(Boolean).join(" · ");
$("h1").textContent = page + " · " + dev;
document.title = "Trace " + page + " · " + dev;
$("run").textContent = meta.run || (M.meta.traceId || "").slice(0, 16);
const cov = M.coverage, allJoined = cov.joined === cov.total;
const tiles = [
  ["TTFB", fmt(k.ttfb), null, "document: navigation start → first byte"],
  ["First paint", fmt(k.fcp), "#6fb38a", "first contentful paint" + (k.lcp != null ? "; LCP " + fmt(k.lcp) : "")],
  ["Data drawn", fmt(k.data), "#6fd8f2", "first frame with an answer (ephem:data)"],
  ["Requests joined", cov.joined + "/" + cov.total, allJoined ? "#7cc9a0" : "#e8a64a", "requests joined to a server invocation (" + cov.byTrace + " also by trace id)"],
  ["Server CPU", fmt(k.serverCpu), null, (k.invocations || 0) + " invocations (front door + loopbacks)"],
];
$("kpis").innerHTML = tiles.map(t => '<div class="kpi" title="' + esc(t[3]) + '"><div class="cap">' + (t[2] ? '<i style="background:' + t[2] + '"></i>' : "") + esc(t[0]) + '</div><span class="v">' + unitHtml(t[1]) + "</span></div>").join("");

const R = meta.rum, o = off;
const sumBits = [rumSrc ? "source RUM" : meta.chrome, "ephem " + (meta.versions || []).join(", "), PM ? "clock ± " + fmt(PM, 1) : "", R ? "RUM vs CDP " + R.within + "/" + R.checks : "", cov.unjoined.length ? cov.unjoined.length + " unjoined" : "all joined"].filter(Boolean);
$("rdsum").textContent = sumBits.join(" · ");
const hm = obj => Object.keys(obj || {}).map(x => x + " " + obj[x]).join(" · ");
const joinedNotes = M.reqs.filter(r => r.join === "joined" && r.reason);
const sec = (title, body) => "<section><h3 class=cap>" + esc(title) + "</h3>" + body + "</section>";
$("rdg").innerHTML =
  sec("Run", kv([["page", meta.url || page, 1], ["device", meta.device], ["network", meta.net], ["cpu", meta.cpu ? meta.cpu + "×" : null], ["cache", meta.mode], ["script", meta.script], ["browser", rumSrc ? meta.client : meta.chrome],
    ["started", meta.started], ["duration", meta.durationS ? meta.durationS + " s" : null], ["run id", meta.run, 1], ["ephem", (meta.versions || []).join(", "), 1],
    ["trace id", M.meta.traceId + (meta.pageTraceFrom ? " (page read it from " + meta.pageTraceFrom + ")" : ""), 1], ["source", rumSrc ? "Basin ephem.rum + ephem.requests_v2 + Workers Observability" : "Chrome DevTools Protocol + Workers Observability"]])) +
  sec("Clock offset", kv([["θ", o.thetaMs != null ? "server − client = " + fmt(o.thetaMs, 1) + " ± " + fmt(o.plusMinusMs, 1) : null], ["interval", o.lo != null ? fmt(o.lo, 1) + " … " + fmt(o.hi, 1) : null],
    ["bounds", o.n != null ? o.agree + " of " + o.n + " agree" : null, 0], ["tightest", o.tightest ? o.tightest.path + " (" + fmt(o.tightest.widthMs, 1) + " wide)" : null],
    ["outliers", (o.outliers || []).map(x => x.path).join(", ") || null], ["sntp", meta.sntp ? fmt(meta.sntp.offsetMs, 1) + " ± " + fmt(meta.sntp.errMs, 1) + " (" + meta.sntp.host + ")" : null],
    ["server inside client", M.inside ? M.inside.ok + " of " + M.inside.n + " front-door spans inside their request's send → first byte (± θ)" : null]]) +
    '<p style="color:var(--faint);font-size:11.5px;margin:6px 0 0">Each joined request bounds θ by (t3 − t4, t2 − t1); server times are whole ms.</p>') +
  sec("Checks", kv([["RUM vs CDP", R ? R.within + " of " + R.checks + " within " + R.tolMs + " ms (p50 " + fmt(R.p50, 2) + ", max " + fmt(R.max, 1) + ")" : null],
    ["first byte", R && R.firstByteUnderThrottling ? "RUM − CDP " + fmt(R.firstByteUnderThrottling.meanMs, 1) + " over " + R.firstByteUnderThrottling.n + ": the emulated latency" : null],
    ["worst", R && R.worst ? R.worst.slice(0, 3).map(w => w.what + " " + fmt(w.diff, 1)).join("; ") : null],
    ["LCP", fmt(k.lcp)], ["INP", fmt(k.inp) + (rumSrc ? "" : " (headless: not comparable)")], ["CLS", k.cls != null ? String(k.cls) : null],
    ["long tasks", k.longTasks != null ? k.longTasks + " (longest " + fmt(k.longestTask, 1) + ")" : null], ["Api cache", hm(k.cache) || null], ["blocks / geoid", hm(k.blocks) || null]])) +
  sec("Coverage", kv([["joined", cov.joined + " of " + cov.total + " (" + cov.byTrace + " also by trace id)"], ["fetches", cov.fetchesSameTrace + " of " + cov.fetches + " carried the document's trace id"],
    ["critical path", M.crit.req.length ? M.crit.req.map(i => (reqByI.get(i) || {}).path).join(" ← ") + " → data drawn" : "none found"]]) +
    (cov.unjoined.length || joinedNotes.length ? '<ul class="ls" style="margin-top:8px">' + cov.unjoined.map(u => '<li><a data-go="r' + u.i + '" style="color:var(--caution);cursor:pointer">#' + u.i + " " + esc(u.url) + "</a>: " + esc(u.join) + ", " + esc(u.reason) + "</li>").join("") +
      joinedNotes.map(r => '<li><a data-go="r' + r.i + '" style="color:var(--ink2);cursor:pointer">#' + r.i + " " + esc(r.url) + "</a>: " + esc(r.reason) + "</li>").join("") + "</ul>" : "")) +
  sec("Top client-side costs", '<ol class="ls">' + (M.costs || []).slice(0, 6).map(c => "<li><span class=tn>" + esc(fmt(c.ms)) + "</span> " + esc(c.what) + ' <span style="color:var(--faint)">' + esc(c.detail) + "</span></li>").join("") + "</ol>");
for (const a of $("rdg").querySelectorAll("[data-go]")) a.onclick = () => select(a.dataset.go, true);

$("legend").innerHTML = [
  '<span class="h">network</span>' + PH.map(p => "<span><i style=\"background:var(--" + p + ')"></i>' + PHN[p].replace(" (ttfb)", "") + "</span>").join(""),
  '<span class="h">server</span><span><i style="background:var(--front)"></i>front door</span><span><i style="background:var(--eff)"></i>span</span><span><i style="background:var(--int)"></i>entrypoint</span><span><i style="background:var(--store)"></i>storage</span><span><i class="sub"></i>subrequest</span><span><i style="background:rgba(245,184,96,.45)"></i>streaming body</span><span><i class="after"></i>waitUntil</span><span><i style="height:2px;vertical-align:2px;background:rgba(245,184,96,.5)"></i>invocation alive</span><span>|—| ± clock</span>',
  '<span class="h">main</span>' + CATS.map(c => '<span><i style="background:' + CATC[c] + '"></i>' + c + "</span>").join("") + '<span><i style="background:#ef6a5e"></i>long task</span>',
  '<span><i class="cl" style="background:var(--accent)"></i>critical path to data drawn</span>',
].map(x => "<span>" + x + "</span>").join("");
$("foot").textContent = "Generated by scripts/obs/journey.ts (or trace-view.ts). Times are ms since navigation start on the browser's clock; server spans are shifted by the clock offset θ. Workers' clock only advances on I/O, so compute spans read 0 ms: read the invocation's CPU. Perfetto: open the matching .perfetto.json at ui.perfetto.dev.";

render();
/* narrow: the waterfall scrolls sideways; open it with data drawn in view */
requestAnimationFrame(() => {
  if (sc.scrollWidth <= sc.clientWidth + 1) return;
  const t = k.data != null ? k.data : tKey, nw = parseFloat(getComputedStyle(wf).getPropertyValue("--nw"));
  sc.scrollLeft = Math.max(0, P(t) / 100 * trackW() - (sc.clientWidth - nw) * 0.6);
});
})();
`

export const viewerHtml = (model: unknown, title: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#060708">
<title>Journey trace</title>
<meta name="description" content="${title.replace(/[<>"&]/g, "")}: unified client and server trace">
<style>${DIN_CSS}${CSS}</style></head><body>
<main>
<header class="hd"><span class="brand">EPHEM</span><span class="cap">trace</span><h1 id="h1"></h1><span class="run mono" id="run"></span></header>
<section class="kpis" id="kpis" aria-label="Key numbers"></section>
<details class="rd"><summary><span class="cap">Run details</span><span class="sum cap" id="rdsum"></span></summary><div class="rdg" id="rdg"></div></details>
<div class="tb" role="toolbar" aria-label="Waterfall controls">
 <button id="bLoad" aria-pressed="true">Page load</button><button id="bAll" aria-pressed="false">Whole journey</button>
 <button class="ic" id="bOut" aria-label="Zoom out">−</button><button class="ic" id="bIn" aria-label="Zoom in">+</button>
 <button id="bCrit" aria-pressed="false">Critical path</button><button id="bExp">Expand all</button>
 <span class="cap tn" id="range" style="color:var(--faint);margin-left:6px"></span>
 <span class="sp"></span><span class="hint">wheel on axis or ⌘-wheel zoom · shift-wheel pan · ↑↓ rows · ←→ fold · enter detail · W S A D · 0 1 · C</span>
</div>
<div class="mm" id="mm" aria-label="Minimap of the whole journey: drag the window, or drag a range" role="img"><canvas id="mmc"></canvas><div id="mmb"></div><div id="mmw"></div></div>
<div class="sc" id="sc"><div class="wf" id="wf" tabindex="0" role="tree" aria-label="Trace waterfall. Up and down move between rows, right and left expand and collapse, Enter opens the detail."></div></div>
<div class="lg" id="legend"></div>
<footer id="foot"></footer>
</main>
<aside id="det" aria-label="Span detail" aria-hidden="true"></aside>
<script type="application/json" id="data">${JSON.stringify(model).replace(/</g, "\\u003c")}</script>
<script>${JSS()}</script>
</body></html>`

// The client script, with the one sequence that would end the inline <script> early escaped.
const JSS = () => JS.replace(/<\/script/gi, "<\\/script")
