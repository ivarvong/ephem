// GET /instrument: the live sky as a working RPN calculator (the RPN Instrument design system, vendored in src/instrument-ds.ts
// by scripts/instrument-ds.mjs). Same location as the homepage (visitor(): ?lat&lon, else request.cf, else Liberty Island).
// First load makes two API calls, /v1/position (live, no `time`) and /v1/day; then one live /v1/position every 30 s while
// the tab is visible (and /v1/day again when the local date changes). Fonts are served here under /assets/<sha12>/<file>,
// immutable; CSS and JS are inline. The SKY and DAY soft menus push those live values onto a real RPN stack.
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { visitor, type Visitor } from "./home.ts"
import { ASSETS, BUNDLE_CSS, BUNDLE_JS, TOKENS_CSS } from "./instrument-ds.ts"

/** The immutable URL of a vendored file (fonts, OFL licences). */
export const assetUrl = (name: string): string => `/assets/${ASSETS[name]!.sha}/${name}`

const bytes = new Map<string, Uint8Array>()   // base64 decoded once per isolate, on first use
const decode = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

const Assets = HttpRouter.add("GET", "/assets/:sha/:name", Effect.gen(function* () {
  const { sha, name } = yield* HttpRouter.params
  const a = name ? ASSETS[name] : undefined
  yield* Effect.annotateCurrentSpan({ "asset.name": a ? name! : "", "asset.hit": !!a && a.sha === sha })
  if (!a || a.sha !== sha) return HttpServerResponse.text("not found", { status: 404, headers: { "cache-control": "no-store" } })
  const headers = { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" }
  if (a.text != null) return HttpServerResponse.text(a.text, { contentType: a.type, headers })
  let b = bytes.get(name!)
  if (!b) { b = decode(a.b64!); bytes.set(name!, b) }
  return HttpServerResponse.uint8Array(b, { contentType: a.type, headers })
}).pipe(Effect.withSpan("asset")))

const Page = HttpRouter.add("GET", "/instrument", req => Effect.gen(function* () {
  const url = Option.getOrElse(HttpServerRequest.toURL(req), () => new URL("http://localhost/instrument"))
  const v = visitor(url, (req.source as { cf?: Parameters<typeof visitor>[1] }).cf)
  yield* Effect.annotateCurrentSpan({ "home.source": v.source, "home.colo": v.colo ?? "", "home.tz": v.tz })
  return HttpServerResponse.text(instrumentPage(v, url.search), { contentType: "text/html; charset=utf-8", headers: { "cache-control": "private, no-store" } })
}).pipe(Effect.withSpan("instrument")))

export const Instrument = Layer.mergeAll(Page, Assets)

const json = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c")
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

/**
 * The page's own CSS (on top of the design system's tokens.css + bundle.css): the bench, and the phone layout. At ≤ 560 px
 * the Calculator's two columns flatten into one 12-column grid (display: contents on its groups, `order` per key cell):
 * glass, soft keys, then rows of 6 (stack keys, functions), a full-width ENTER, and a 4-column number block with the
 * operators on the right, every key ≥ 44 px tall. Above 900 × 760 the instrument is drawn at 1.5× (zoom keeps the dots on
 * the ghost grid: every length scales together).
 */
const PAGE_CSS = `
html,body{margin:0;background:var(--surface);color:var(--ink)}
body{font-family:var(--font-legend);font-size:15px;line-height:22px;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;box-sizing:border-box;padding:12px 16px max(16px,env(safe-area-inset-bottom));overflow-x:hidden}
.bar{width:100%;max-width:700px;display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}
.bar h1{margin:0;font:700 13px/18px var(--font-legend);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-muted)}
.bar a,.help a{color:var(--ink-muted);text-decoration:none;font-size:13px;letter-spacing:.04em;min-height:44px;display:inline-flex;align-items:center;padding:0 2px;border-radius:3px}
.bar a:hover,.help a:hover{color:var(--ink);text-decoration:underline}
.bar a:focus-visible,.help a:focus-visible{outline:none;box-shadow:var(--shadow-focus)}
#calc{display:flex;justify-content:center;max-width:100%}
.help{max-width:520px;margin:16px 0 0;font-size:13px;line-height:18px;color:var(--ink-muted);text-align:center}
.help kbd{font-family:var(--font-legend);font-weight:700;color:var(--ink)}
@media (min-width:900px) and (min-height:760px){#calc{zoom:1.5;margin-top:12px}}
@media (max-width:560px){
  body{padding:8px 16px max(12px,env(safe-area-inset-bottom))}
  #calc{width:100%}
  .rpn-calc{--key-height:44px;--softkey-height:44px;display:grid;grid-template-columns:repeat(12,minmax(0,1fr));width:100%;box-sizing:border-box;padding:10px 6px 50px;column-gap:0}
  .rpn-calc .rpn-left,.rpn-calc .rpn-grid,.rpn-calc .rpn-right{display:contents}
  .rpn-calc .rpn-plate{grid-column:1/-1;order:1;display:flex;justify-content:center;margin:0 0 6px;padding:6px 0}
  .rpn-calc .rpn-softrow{grid-column:1/-1;order:2;padding:0 0 4px}
  .rpn-calc .rpn-softcell{padding:0 3px}
  .rpn-calc .rpn-grid .rpn-keycell{grid-column:span 2;padding:2px 3px 5px}
  .rpn-calc .rpn-key{width:100%}
  .rpn-calc .rpn-key.is-soft{width:100%}
  .rpn-calc .rpn-key.is-wide{width:100%}
  .rpn-calc .rpn-menu-item{pointer-events:none}
  .rpn-calc [data-cell="SHL"]{order:30}.rpn-calc [data-cell="SHR"]{order:31}.rpn-calc [data-cell="SWAP"]{order:32}
  .rpn-calc [data-cell="NEG"]{order:33}.rpn-calc [data-cell="EEX"]{order:34}.rpn-calc [data-cell="BACK"]{order:35}
  .rpn-calc [data-cell="y^x"]{order:40}.rpn-calc [data-cell="SQRT"]{order:41}.rpn-calc [data-cell="INV"]{order:42}
  .rpn-calc [data-cell="SIN"]{order:43}.rpn-calc [data-cell="COS"]{order:44}.rpn-calc [data-cell="TAN"]{order:45}
  .rpn-calc .rpn-grid [data-cell="ENTER"]{order:50;grid-column:1/-1}
  .rpn-calc .rpn-grid [data-cell="7"],.rpn-calc .rpn-grid [data-cell="8"],.rpn-calc .rpn-grid [data-cell="9"],.rpn-calc .rpn-grid [data-cell="/"],
  .rpn-calc .rpn-grid [data-cell="4"],.rpn-calc .rpn-grid [data-cell="5"],.rpn-calc .rpn-grid [data-cell="6"],.rpn-calc .rpn-grid [data-cell="*"],
  .rpn-calc .rpn-grid [data-cell="1"],.rpn-calc .rpn-grid [data-cell="2"],.rpn-calc .rpn-grid [data-cell="3"],.rpn-calc .rpn-grid [data-cell="-"],
  .rpn-calc .rpn-grid [data-cell="0"],.rpn-calc .rpn-grid [data-cell="."],.rpn-calc .rpn-grid [data-cell="NXT"],.rpn-calc .rpn-grid [data-cell="+"]{grid-column:span 3}
  .rpn-calc [data-cell="7"]{order:60}.rpn-calc [data-cell="8"]{order:61}.rpn-calc [data-cell="9"]{order:62}.rpn-calc [data-cell="/"]{order:63}
  .rpn-calc [data-cell="4"]{order:70}.rpn-calc [data-cell="5"]{order:71}.rpn-calc [data-cell="6"]{order:72}.rpn-calc [data-cell="*"]{order:73}
  .rpn-calc [data-cell="1"]{order:80}.rpn-calc [data-cell="2"]{order:81}.rpn-calc [data-cell="3"]{order:82}.rpn-calc [data-cell="-"]{order:83}
  .rpn-calc [data-cell="0"]{order:90}.rpn-calc [data-cell="."]{order:91}.rpn-calc [data-cell="NXT"]{order:92}.rpn-calc [data-cell="+"]{order:93}
  .rpn-click{min-height:44px;min-width:88px;justify-content:center;bottom:2px}
  .help{margin-top:12px}
}
@media (pointer:coarse) and (min-width:561px){.rpn-calc{--key-height:44px;--softkey-height:44px}}
`

/**
 * The live glue. Fills RPN.sky (the design system's SKY object, read by the SKY / DAY / CONST soft menus and the status
 * lines) from /v1/position and /v1/day, seeds the stack once, and refreshes the glass. Values are rounded the way the
 * design system's examples are: angles and the Moon's distance to 0.01, the Sun's distance to 0.1 km, illumination to
 * 0.1 %; event times are local decimal hours (`17.9114_h`), so SET RISE − is the day's length. window.__instrument records
 * request timings for scripts (resource timing has the rest). No backticks or dollar-brace below: it lives in a TS template.
 */
export const GLUE_JS = `
(function () {
"use strict";
var S = window.__instrument = { t0: performance.now(), dataAt: null, dayAt: null, calls: 0, errors: 0 };
var sky = RPN.sky, N = function (v, u, tag) { return { k: "n", v: v, u: u || "", tag: tag }; };
var r2 = function (x, k) { var m = Math.pow(10, k == null ? 2 : k); return x == null ? null : Math.round(x * m) / m; };
var blank = function () { return { AZ: null, ALT: null, DECL: null, DIST: [null, "km"], PHASE: null, ILLUM: null }; };
sky.SUN = blank(); sky.MOON = blank(); sky.DAY = null; sky.time = "--:--"; sky.hours = null;
sky.where = "{ " + RPN.format(r2(LOC.lat)) + " " + RPN.format(r2(LOC.lon)) + " }";
var calc = RPN.Calculator({});
RPN.mount("#calc", calc);
var tf = new Intl.DateTimeFormat("en-GB", { timeZone: LOC.tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
var df = new Intl.DateTimeFormat("en-CA", { timeZone: LOC.tz });
function localHours(ms) { var p = tf.format(new Date(ms)).split(":").map(Number); return r2((p[0] % 24) + p[1] / 60 + p[2] / 3600, 4); }
function clock() { var now = Date.now(); sky.time = tf.format(new Date(now)).slice(0, 5); sky.hours = localHours(now); }
function q(extra) { var o = { lat: LOC.lat.toFixed(5), lon: LOC.lon.toFixed(5) }; for (var k in extra) o[k] = extra[k]; return new URLSearchParams(o).toString(); }
function get(path, extra) {
  S.calls++;
  return fetch(path + "?" + q(extra)).then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b && b.message || "HTTP " + r.status); return b; }); });
}
function body(b) {
  return { AZ: r2(b.azimuth), ALT: r2(b.apparentAltitude == null ? b.altitude : b.apparentAltitude), DECL: r2(b.declination), DIST: [r2(b.distanceKm, b.distanceKm > 1e7 ? 1 : 2), "km"] };
}
var seeded = false;
function position() {
  return get("/v1/position").then(function (p) {
    sky.SUN = body(p.sun); sky.MOON = body(p.moon);
    sky.MOON.PHASE = p.moon.phase.name.toUpperCase(); sky.MOON.ILLUM = r2(p.moon.phase.illuminatedFraction * 100, 1);
    clock();
    if (!seeded) { seeded = true; calc.rpn.seed([N(sky.SUN.AZ, "\\u00b0", "AZ"), N(sky.SUN.ALT, "\\u00b0", "ALT"), { k: "s", v: sky.MOON.PHASE }]); }
    calc.rpn.refresh();
    if (S.dataAt == null) S.dataAt = performance.now();
  });
}
var dayFor = null;
function day() {
  var d = df.format(new Date());
  if (d === dayFor) return Promise.resolve();
  dayFor = d;
  return get("/v1/day", { date: d, tz: LOC.tz }).then(function (r) {
    var out = { SUN: {}, MOON: {} };
    r.events.forEach(function (e) {
      var B = e.body === "sun" ? out.SUN : e.body === "moon" ? out.MOON : null;
      if (B && (e.kind === "rise" || e.kind === "set" || e.kind === "transit") && B[e.kind] == null) B[e.kind] = localHours(Date.parse(e.time));
    });
    sky.DAY = out; calc.rpn.refresh();
    if (S.dayAt == null) S.dayAt = performance.now();
  });
}
function fail(e) { S.errors++; sky.time = "NO LINK"; calc.rpn.refresh(); if (window.console) console.warn("instrument:", e && e.message || e); }
position().catch(fail); day().catch(function (e) { dayFor = null; fail(e); });
setInterval(function () { clock(); calc.rpn.refresh(); }, 15000);
setInterval(function () { if (document.visibilityState === "visible") { position().catch(fail); day().catch(function () { dayFor = null; }); } }, 30000);
// Typing anywhere on the page drives the instrument (no autofocus: a focus ring on load would read as a border).
document.addEventListener("keydown", function (e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || calc.contains(document.activeElement)) return;
  if (!(e.key.length === 1 || /^(Enter|Backspace|Delete|Escape|F[1-6])$/.test(e.key))) return;   // Tab etc. keep their meaning
  if (document.activeElement && document.activeElement.tagName === "A" && (e.key === "Enter" || e.key === " ")) return;
  calc.focus({ preventScroll: true });
  calc.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, bubbles: true, cancelable: true }));
  e.preventDefault();
});
})();
`

export const instrumentPage = (v: Visitor, search = ""): string => {
  const fonts = Object.keys(ASSETS).filter(n => n.endsWith(".woff2"))
  const back = "/" + (search && /[?&]lat=/.test(search) ? search : "")
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ephem · instrument · ${v.city.replace(/[<>&"]/g, "")}</title>
<meta name="description" content="The live Sun and Moon from JPL DE440 on a working RPN calculator: SKY pushes real values onto the stack.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
${fonts.map(n => `<link rel="preload" href="${assetUrl(n)}" as="font" type="font/woff2" crossorigin>`).join("\n")}
<script>(function(){var m=matchMedia("(prefers-color-scheme: dark)");var s=function(){document.documentElement.setAttribute("data-theme",m.matches?"dark":"light")};s();m.addEventListener&&m.addEventListener("change",s)})();</script>
<style>${TOKENS_CSS}</style>
<style>${BUNDLE_CSS}</style>
<style>${PAGE_CSS}</style>
</head><body>
<header class="bar"><h1>ephem instrument</h1><a href="${attr(back)}">Sky view</a></header>
<div id="calc" aria-label="Sun and Moon calculator for ${attr(v.place)}"><noscript>The instrument needs JavaScript. <a href="${attr(back)}">The sky view</a> and <a href="/docs">the API</a> work without it.</noscript></div>
<p class="help">Live for ${attr(v.place)}. <kbd>F1</kbd>–<kbd>F6</kbd> or the soft keys push the Sun and Moon onto the stack; <kbd>NXT</kbd> pages SKY, DAY and CONST. Try DAY: SET, RISE, then <kbd>−</kbd>. Fonts: <a href="${assetUrl("RPNDot-OFL.txt")}">RPN Dot</a> and <a href="${assetUrl("SofiaSansCondensed-OFL.txt")}">Sofia Sans</a> (OFL).</p>
<script>${BUNDLE_JS.replace(/<\/script/gi, "<\\/script")}</script>
<script>const LOC = ${json(v)};</script>
<script>${GLUE_JS}</script>
</body></html>`
}
