// GET /: the live sky over wherever the visitor is. Location comes from Cloudflare (request.cf) unless ?lat&lon override it;
// every number on the page comes from this Worker's own /v1 API, fetched by the page from the same origin.
import { Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { isValidZone } from "@ephem/core"

interface CfLocation {
  readonly latitude?: string; readonly longitude?: string; readonly city?: string; readonly region?: string
  readonly country?: string; readonly timezone?: string; readonly colo?: string
}
export interface Visitor {
  readonly lat: number; readonly lon: number; readonly place: string; readonly city: string; readonly tz: string
  readonly colo: string | null; readonly source: "query" | "cloudflare" | "default"
}

const DEFAULT = { lat: 40.6892, lon: -74.0445, place: "Liberty Island, New York", city: "Liberty Island", tz: "America/New_York" } as const
const inRange = (x: number, m: number) => Number.isFinite(x) && Math.abs(x) <= m
const zone = (tz: string | null | undefined, fallback: string) => (tz && isValidZone(tz) ? tz : fallback)
const coords = (lat: number, lon: number) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`

/** Where to compute for: explicit ?lat&lon, else Cloudflare's IP geolocation, else Liberty Island. `city` is the short title. */
export const visitor = (url: URL, cf: CfLocation | undefined): Visitor => {
  const colo = cf?.colo ?? null
  const qLat = Number(url.searchParams.get("lat")), qLon = Number(url.searchParams.get("lon"))
  if (url.searchParams.has("lat") && url.searchParams.has("lon") && inRange(qLat, 90) && inRange(qLon, 180)) {
    const place = (url.searchParams.get("place") ?? "").slice(0, 80) || coords(qLat, qLon)
    return { lat: qLat, lon: qLon, place, city: place, tz: zone(url.searchParams.get("tz"), zone(cf?.timezone, "UTC")), colo, source: "query" }
  }
  const lat = Number(cf?.latitude), lon = Number(cf?.longitude)
  if (cf?.latitude && cf.longitude && inRange(lat, 90) && inRange(lon, 180)) {
    const place = [cf.city, cf.region && cf.region !== cf.city ? cf.region : undefined, cf.country].filter(Boolean).join(", ") || coords(lat, lon)
    return { lat, lon, place, city: cf.city || place, tz: zone(cf.timezone, "UTC"), colo, source: "cloudflare" }
  }
  return { ...DEFAULT, colo, source: "default" }
}

export const Home = HttpRouter.add("GET", "/", req => Effect.gen(function* () {
  const url = Option.getOrElse(HttpServerRequest.toURL(req), () => new URL("http://localhost/"))
  const v = visitor(url, (req.source as { cf?: CfLocation }).cf)
  yield* Effect.annotateCurrentSpan({ "home.source": v.source, "home.colo": v.colo ?? "", "home.tz": v.tz })
  return HttpServerResponse.text(page(v), { contentType: "text/html; charset=utf-8", headers: { "cache-control": "private, no-store" } })
}).pipe(Effect.withSpan("home")))

const json = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c")

/**
 * The page's pure helpers, shared by the client script and test/home.test.ts (which evaluates this string).
 * Like the rest of the client JS it lives in a TS template: no backticks, no dollar-brace, and backslashes doubled.
 */
export const CORE_JS = `
function wrap360(x) { return ((x % 360) + 360) % 360; }
function wrap180(x) { return ((x % 360) + 540) % 360 - 180; }
var DIRS = ["north", "north-northeast", "northeast", "east-northeast", "east", "east-southeast", "southeast", "south-southeast", "south", "south-southwest", "southwest", "west-southwest", "west", "west-northwest", "northwest", "north-northwest"];
function dirWord(az) { return DIRS[Math.round(wrap360(az) / 22.5) % 16]; }
function countdown(ms) {
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "in " + s + " s";
  var m = Math.round(s / 60), h = Math.floor(m / 60); m = m % 60;
  return "in " + (h ? h + " h" + (m ? " " + m + " min" : "") : m + " min");
}
function ago(s) {
  s = Math.max(0, Math.round(s));
  if (s < 90) return s + " s ago";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  return (s / 3600).toFixed(1) + " h ago";
}
// apparentAltitude is null below the observer's horizon (API 2026-10-29); drawing falls back to the true altitude there.
function altOf(b) { return b.apparentAltitude == null ? b.altitude : b.apparentAltitude; }
// Screen y of a body's centre (hy = horizon line, k = px per degree), and whether its disc (radius r px) is wholly below the horizon.
function skyY(b, hy, k) { return hy - altOf(b) * k; }
function isSet(b, k, r) { return altOf(b) * k < -r; }
function bodyPhrase(name, b) {
  var a = altOf(b), dir = dirWord(b.azimuth);
  if (a < 0) return null;
  if (a < 8) return name + " is low in the " + dir;
  if (a < 40) return name + " is in the " + dir;
  return name + " is high in the " + dir;
}
function lede(sun, moon) {
  var sa = altOf(sun), east = wrap360(sun.azimuth) < 180;
  var s = bodyPhrase("The Sun", sun) || (sa >= -6 ? (east ? "It's dawn" : "It's dusk") : sa >= -18 ? "It's twilight" : "It's night");
  var ph = moon.phase, mname = ph && ph.illuminatedFraction >= 0.03 ? "the " + ph.name.toLowerCase() + " Moon" : "the Moon";
  var m = bodyPhrase(mname, moon);
  return s + (m ? ", and " + m : " and the Moon is down") + ".";
}
// METAR present-weather codes to words (WMO 306 / FAA 7900.5 subset); unknown tokens fall through verbatim.
var WXD = { MI: "shallow", BC: "patchy", PR: "partial", DR: "drifting", BL: "blowing", TS: "thunderstorm with", FZ: "freezing" };
var WXP = { DZ: "drizzle", RA: "rain", SN: "snow", SG: "snow grains", IC: "ice crystals", PL: "ice pellets", GR: "hail", GS: "small hail", UP: "precipitation",
  BR: "mist", FG: "fog", FU: "smoke", VA: "volcanic ash", DU: "dust", SA: "sand", HZ: "haze", PY: "spray", PO: "dust whirls", SQ: "squalls", FC: "funnel cloud", SS: "sandstorm", DS: "duststorm" };
function wxWord(tok) {
  var m = /^([-+]?)(VC)?((?:MI|BC|PR|DR|BL|SH|TS|FZ)*)((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*)$/.exec(tok);
  if (!m || !(m[3] || m[4])) return tok;
  var ds = m[3].match(/../g) || [], sh = ds.indexOf("SH") >= 0, p = (m[4].match(/../g) || []).map(function (x) { return WXP[x]; });
  var d = ds.filter(function (x) { return x !== "SH"; }).map(function (x) { return WXD[x]; });
  var w = d.concat(p.length ? [p.join(" and ") + (sh ? " showers" : "")] : sh ? ["showers"] : []).join(" ").replace(/ with$/, "");
  return (m[1] === "-" ? "light " : m[1] === "+" ? "heavy " : "") + w + (m[2] ? " nearby" : "");
}
var COVER = { SKC: "Clear", CLR: "Clear", NCD: "Clear", NSC: "Clear", CAVOK: "Clear", FEW: "Mostly clear", SCT: "Partly cloudy", BKN: "Mostly cloudy", OVC: "Overcast", OVX: "Sky obscured" };
function condition(st) {
  if (st.wx) { var w = st.wx.split(/ +/).map(wxWord).join(", "); return w.charAt(0).toUpperCase() + w.slice(1); }
  if (st.verticalVisibilityFt != null) return "Sky obscured";
  var rank = ["SKC", "CLR", "NCD", "NSC", "CAVOK", "FEW", "SCT", "BKN", "OVC", "OVX"], top = null;
  (st.sky || []).forEach(function (l) { if (top == null || rank.indexOf(l.cover) > rank.indexOf(top)) top = l.cover; });
  if (top) return COVER[top] || top;
  return / (CLR|SKC|CAVOK|NSC) /.test(" " + st.raw + " ") ? "Clear" : "Sky not reported";
}
// METAR wind direction is reported to the nearest 10 degrees, so whole degrees here (the one exception to the page's
// two-decimal rule for bearings: "260.00°" would claim precision the report doesn't have). decl: magnetic declination, east positive.
function windText(w, decl) {
  if (w.speedKt == null) return "Wind not reported";
  if (w.calm) return "Wind calm";
  var dir = w.variable || w.directionDegTrue == null ? "variable" : Math.round(wrap360(w.directionDegTrue)) + "\\u00b0 T" + (decl == null ? "" : " \\u00b7 " + Math.round(wrap360(w.directionDegTrue - decl)) % 360 + "\\u00b0 M");
  return "Wind " + dir + " at " + w.speedKt + " kt" + (w.gustKt ? ", gusting " + w.gustKt + " kt" : "");
}
// ---- canvas label layout: every label gets a spot that overlaps no text, tick, disc or reserved band ----
function overlapArea(a, b) { var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; }
function labelSpots(it) {
  var out = [], h = it.h, w = it.w;
  if (it.edge) { var ex = it.edge === "left" ? it.x : it.x - w; [0, -1, 1, -2, 2, -3, 3, -4, 4, -6, 6].forEach(function (k) { out.push([ex, it.y - h / 2 + k * (h + 4)]); }); return out; }
  [1, 2, 3.5, 6].forEach(function (m) {
    var d = (it.r || 0) + 6 * m, e = d * 0.72;
    out.push([it.x - w / 2, it.y - d - h], [it.x + d, it.y - h / 2], [it.x - d - w, it.y - h / 2], [it.x + e, it.y - e - h], [it.x - e - w, it.y - e - h],
      [it.x - w / 2, it.y + d], [it.x + e, it.y + e], [it.x - e - w, it.y + e]);
  });
  return out;
}
// items: {id, x, y, w, h, r} (anchor = disc centre and radius) or {id, x, y, w, h, edge: "left"|"right"} (pinned to a side);
// obstacles: rects {x, y, w, h} a label must not touch (text, ticks, discs, bands); soft: rects it would rather avoid (path lines).
// bounds {x0, y0, x1, y1}. Returns top-left rects in item order; clear=false only if every spot hit a hard obstacle.
function placeLabels(items, obstacles, bounds, soft) {
  var taken = obstacles.slice(), out = [];
  soft = soft || [];
  function hit(r, list) { var c = 0; for (var j = 0; j < list.length; j++) c += overlapArea(r, list[j]); return c; }
  items.forEach(function (it) {
    var spots = labelSpots(it), best = null, hard = Infinity, sft = Infinity;
    for (var i = 0; i < spots.length && (hard > 0 || sft > 0); i++) {
      var r = { x: Math.max(bounds.x0, Math.min(bounds.x1 - it.w, spots[i][0])), y: Math.max(bounds.y0, Math.min(bounds.y1 - it.h, spots[i][1])), w: it.w, h: it.h };
      var h = hit(r, taken), s = h > hard ? Infinity : hit(r, soft);
      if (h < hard || (h === hard && s < sft)) { hard = h; sft = s; best = r; }
    }
    best.id = it.id; best.clear = hard === 0; out.push(best); taken.push(best);
  });
  return out;
}
function overlaps(rects) {
  var bad = [];
  for (var i = 0; i < rects.length; i++) for (var j = i + 1; j < rects.length; j++) if ((rects[i].text || rects[j].text) && overlapArea(rects[i], rects[j]) > 0) bad.push(rects[i].id + " x " + rects[j].id);
  return bad;
}
`

export const page = (v: Visitor) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ephem · the sky over ${v.city.replace(/[<>&"]/g, "")}</title>
<meta name="description" content="Where the Sun and the Moon are right now, from JPL DE440, computed on Cloudflare's edge.">
<meta name="theme-color" content="#070a14">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500&display=swap">
<style>
:root{--bg:#070a14;--ink:#eef1f8;--muted:#a1a9bf;--faint:#687190;--line:rgba(255,255,255,.08);--panel:#0c111f;--sun:#ffc361;--moon:#d9e3ff;--accent:#9fb7ff;--warn:#ffb86b;
--display:"Newsreader",Georgia,serif;--body:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 var(--body);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.01em}.tn{font-variant-numeric:tabular-nums}
.gut{padding-left:max(20px,env(safe-area-inset-left));padding-right:max(20px,env(safe-area-inset-right))}
.hud.gut{padding-left:max(20px,env(safe-area-inset-left),calc((100% - 1000px) / 2));padding-right:max(20px,env(safe-area-inset-right),calc((100% - 1000px) / 2))}
.sky{position:relative;height:min(76svh,740px);min-height:460px;overflow:hidden;touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none}
.sky:active{cursor:grabbing}
.sky canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.sky::before{content:"";position:absolute;left:0;right:0;top:0;height:150px;background:linear-gradient(rgba(4,6,13,.38),rgba(4,6,13,0));pointer-events:none;z-index:1}
.hud{position:absolute;inset:0;z-index:2;pointer-events:none;display:flex;flex-direction:column;justify-content:space-between;padding-top:max(20px,env(safe-area-inset-top));padding-bottom:22px;text-shadow:0 1px 10px rgba(0,0,0,.4)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.brand{font:500 12px/1 var(--body);letter-spacing:.08em;color:rgba(238,241,248,.6)}
h1{font:400 clamp(30px,4.6vw,52px)/1.1 var(--display);margin:8px 0 0;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1.coords{font-size:clamp(21px,3.4vw,44px);font-variant-numeric:tabular-nums;margin-top:12px}
.now{text-align:right;flex:none}
.clock{font:400 clamp(20px,2.4vw,28px)/1 var(--mono);font-variant-numeric:tabular-nums;margin-top:18px}
.ctl{margin-top:10px;height:26px;font:12px/26px var(--body);color:rgba(238,241,248,.62)}
#hint{transition:opacity .6s}#hint.gone{opacity:0}
.ctl button{pointer-events:auto;font:500 12px/1 var(--body);color:var(--ink);background:rgba(7,10,20,.35);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:6px 12px;cursor:pointer}
.ctl button:hover{border-color:rgba(255,255,255,.5)}
.bottom{max-width:44rem}
.lede{font:400 clamp(21px,2.6vw,30px)/1.25 var(--display);margin:0;text-wrap:pretty}
.next{margin:8px 0 0;font:15px/1.4 var(--body);color:rgba(238,241,248,.75)}
.next b{color:var(--ink);font-weight:500}
main{max-width:1040px;margin:0 auto;display:grid;gap:56px;padding-top:28px;padding-bottom:56px}
h2{font:400 24px/1.2 var(--display);margin:0 0 14px}
.sub{color:var(--muted);margin:-8px 0 14px;font-size:14px}
.bodies{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;min-width:0}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:12px}
.card h3{margin:0;font:500 15px/1.2 var(--body)}
.card .state{color:var(--muted);font-size:14px;text-align:right}
.sunc h3{color:var(--sun)}.moonc h3{color:var(--moon)}
dl.nums{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;margin:0;font-size:14px}
dl.nums dt{color:var(--muted)}
dl.nums dd{margin:0;white-space:nowrap;display:flex;gap:16px}
.card .foot{margin:12px 0 0;color:var(--muted);font-size:13px}
.strip svg{display:block;width:100%;height:auto}
.strip text{font-family:var(--mono);fill:var(--muted)}
.evs{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0 32px;margin-top:14px;font-size:14px}
.evs>div{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--line)}
.evs .past{color:var(--faint)}
.evs details.more{grid-column:1/-1;margin-top:8px}.evs details.more .evs{margin-top:4px}
.evs .s::before,.evs .m::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:9px;vertical-align:2px}
.evs .s::before{background:var(--sun)}.evs .m::before{background:var(--moon)}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px;align-items:center}
.btn{font:500 14px/1 var(--body);color:var(--ink);background:transparent;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:10px 16px;cursor:pointer;display:inline-block}
.btn:hover{border-color:var(--accent);text-decoration:none}
.note{font-size:13px;color:var(--muted)}
.wxc{display:grid;gap:14px}
.wxtop{display:flex;align-items:center;gap:6px 18px;flex-wrap:wrap}
.temp{font:400 40px/1 var(--display)}
.wxtop .cond{font:500 16px/1.3 var(--body)}
.wxtop .wind{color:var(--muted);font-size:14px}
dl.wxs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px 18px;margin:0}
dl.wxs div{min-width:0}
dl.wxs dt{color:var(--muted);font-size:13px}
dl.wxs dd{margin:2px 0 0;font-size:14px}
.station{margin:0;color:var(--muted);font-size:13px}
.age{white-space:nowrap}
.warn{color:var(--warn)}
details summary{cursor:pointer;color:var(--accent);font:500 13px/1.6 var(--body)}
details.raw pre{margin:8px 0 0;font:12.5px/1.6 var(--mono);color:#cfd6ea;white-space:pre-wrap;overflow-wrap:anywhere}
pre .c{color:var(--faint)}
.hood{border-top:1px solid var(--line);padding-top:18px}
.hood>summary{font:400 20px/1.3 var(--display);color:var(--ink);list-style:none}
.hood>summary::-webkit-details-marker{display:none}
.hood>summary::after{content:"+";color:var(--faint);margin-left:10px;font-family:var(--body)}
.hood[open]>summary::after{content:"\\2212"}
.hood .in{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px;margin-top:18px}
.hood h3{font:500 14px/1.3 var(--body);margin:0 0 6px}
.hood p{color:var(--muted);font-size:14px;margin:0 0 12px}
.hood pre{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto;font:12.5px/1.65 var(--mono);color:#cfd6ea}
footer{font-size:12px;color:var(--faint);display:flex;flex-wrap:wrap;gap:4px 20px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.err{color:#ff8a80}
@media (max-width:760px){.bodies,.hood .in{grid-template-columns:minmax(0,1fr)}dl.wxs{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}main{gap:48px}}
@media (min-width:761px){.hud{padding-bottom:30px}.clock{margin-top:22px}}
</style>
</head><body>
<section class="sky" id="sky" aria-label="Live panorama of the sky">
  <canvas id="cv" tabindex="0" aria-label="Sky panorama"></canvas>
  <div class="hud gut">
    <div class="top" id="top">
      <div style="min-width:0">
        <div class="brand">ephem</div>
        <h1 id="place"></h1>
      </div>
      <div class="now">
        <div class="clock" id="clock">--:--</div>
        <div class="ctl"><span id="hint">Drag to look around</span><button type="button" id="recenter" hidden>Recenter</button></div>
      </div>
    </div>
    <div class="bottom" id="bottom">
      <p class="lede" id="lede">Finding the Sun and the Moon…</p>
      <p class="next" id="next">&nbsp;</p>
    </div>
  </div>
</section>
<main class="gut">
  <section class="bodies" id="bodies" aria-label="Sun and Moon"></section>
  <section class="day">
    <h2 id="dayTitle">Today</h2>
    <p class="sub">The sky's colour at the horizon, hour by hour.</p>
    <div class="strip" id="strip"></div>
    <div class="evs" id="evs"></div>
    <div class="row">
      <button class="btn" type="button" id="locate">Use my exact location</button>
      <button class="btn" type="button" id="share">Copy link</button>
      <span class="note" id="locnote"></span>
    </div>
  </section>
  <section class="wx" aria-live="polite">
    <h2>Weather</h2>
    <div class="wxc" id="wx"><span class="note">Finding the nearest station…</span></div>
  </section>
  <details class="hood" id="hood">
    <summary>Under the hood</summary>
    <div class="in">
      <div>
        <h3>It's an API</h3>
        <p>Apparent topocentric positions from JPL DE440, rise, set and twilight, Moon phase and landmark alignments, in TypeScript on Cloudflare Workers and cross-checked against Skyfield. These are calls this page made:</p>
        <pre id="curl"></pre>
        <div class="row"><a class="btn" href="/docs">API reference</a><a class="btn" href="/openapi.json">openapi.json</a></div>
      </div>
      <div>
        <h3>Diagnostics</h3>
        <p>Each answer reads 8 KiB Chebyshev blocks of DE440 through an isolate LRU, the Workers Cache, then a byte-range read of the 102 MB file in R2.</p>
        <pre id="diag"><span class="c">waiting for the first answer…</span></pre>
      </div>
    </div>
  </details>
  <footer id="foot"></footer>
</main>
<script>const LOC = ${json(v)};</script>
<script>
(function () {
"use strict";
${CORE_JS}
var D2R = Math.PI / 180, AU = 149597870.7;
var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
var loc = { lat: LOC.lat, lon: LOC.lon, place: LOC.place, city: LOC.city, tz: LOC.tz, source: LOC.source, acc: null };
var $ = function (id) { return document.getElementById(id); };
var S = { decl: null, wx: null, wxAt: 0, rawOpen: false, from: null, to: null, tween0: 0, day: null, tomorrow: null, track: [], center: null, userPanned: false, last: null, err: null };

// ---------- API ----------
function api(path, q, quiet) {
  var url = path + "?" + new URLSearchParams(q).toString(), t0 = performance.now();
  return fetch(url).then(function (r) {
    return r.json().then(function (b) {
      var ms = performance.now() - t0;
      if (!r.ok) throw new Error((b && b.message) || ("HTTP " + r.status));
      if (!quiet) S.last = { url: url, ms: ms, prov: b.provenance };
      return b;
    });
  });
}
var fmtCache = {};
function fmt(opts) { var k = JSON.stringify(opts) + loc.tz; return fmtCache[k] || (fmtCache[k] = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: loc.tz, hour12: false }, opts))); }
function localDate(ms) { return new Intl.DateTimeFormat("en-CA", { timeZone: loc.tz }).format(new Date(ms)); }
function hm(ms) { return fmt({ hour: "2-digit", minute: "2-digit" }).format(new Date(ms)); }
function nextDate(d) { var p = d.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1)).toISOString().slice(0, 10); }
function q() { return { lat: loc.lat.toFixed(5), lon: loc.lon.toFixed(5) }; }

// ---------- sky model ----------
var KEYS = [ // sun altitude → [zenith, horizon]
  [-90, "#04060d", "#080b18"], [-18, "#04060d", "#0b0f22"], [-13, "#0a1029", "#1f2450"], [-8, "#121a3c", "#4d3f78"],
  [-4, "#1d2a55", "#a85a7c"], [0, "#2b4479", "#ee8148"], [4, "#31599c", "#e9ac68"], [15, "#2a64b0", "#8ab5df"], [90, "#1d5bb5", "#73a8e0"]];
function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
function mix(a, b, t) { var x = hex(a), y = hex(b); return "rgb(" + [0, 1, 2].map(function (i) { return Math.round(x[i] + (y[i] - x[i]) * t); }).join(",") + ")"; }
function skyAt(alt) {
  for (var i = 0; i < KEYS.length - 1; i++) {
    var a = KEYS[i], b = KEYS[i + 1];
    if (alt <= b[0]) { var t = Math.max(0, (alt - a[0]) / (b[0] - a[0])); return [mix(a[1], b[1], t), mix(a[2], b[2], t)]; }
  }
  return [KEYS[KEYS.length - 1][1], KEYS[KEYS.length - 1][2]];
}
// Angles: Sun/Moon azimuth and altitudes, and bearings, at two decimals with units, true and magnetic (WMM2025 declination,
// east positive). They appear in the readout cards and the station line only; the sky itself carries names.
function d2(x) { return x.toFixed(2) + "\\u00b0"; }
function azT(x) { var v = wrap360(x); return (v >= 359.995 ? 0 : v).toFixed(2) + "\\u00b0 T"; }
function azM(x) { if (S.decl == null) return ""; var v = wrap360(x - S.decl); return (v >= 359.995 ? 0 : v).toFixed(2) + "\\u00b0 M"; }
function esc(x) { return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function compass(az) { return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(wrap360(az) / 22.5) % 16]; }

// Parallactic angle q (deg): position angle of the zenith, from altitude/azimuth, declination and latitude.
function parallactic(alt, az, dec, lat) {
  var h = alt * D2R, A = az * D2R, p = lat * D2R, d = dec * D2R;
  var H = Math.atan2(-Math.cos(h) * Math.sin(A), Math.cos(p) * Math.sin(h) - Math.sin(p) * Math.cos(h) * Math.cos(A));
  return Math.atan2(Math.sin(H), Math.tan(p) * Math.cos(d) - Math.sin(d) * Math.cos(H)) / D2R;
}

// ---------- canvas ----------
// Layout, top to bottom: the title band (HUD, nothing drawn under it), the sky from 94° down to the horizon, a strip of
// ground with compass ticks, and the bottom band (the sentence). Paths and labels stay inside the sky; bodies set behind the horizon.
var cv = $("cv"), ctx = cv.getContext("2d"), W = 0, H = 0, dpr = 1, GROUND = 40;
var G = null;
function geom() {
  var sky = $("sky").getBoundingClientRect(), top = $("top").getBoundingClientRect().bottom - sky.top + 14, bot = $("bottom").getBoundingClientRect().top - sky.top - 6;
  var hy = Math.round(bot - GROUND), k = Math.max(W / 360, (hy - top) / 94);
  return { k: k, top: top, hy: hy, bot: bot };
}
function X(az, g) { return W / 2 + wrap180(az - S.center) * g.k; }
function Y(alt, g) { return g.hy - alt * g.k; }
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  var r = cv.getBoundingClientRect(); W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); dirty = true;
}
function interp() {
  if (!S.to) return null;
  if (!S.from || reduce) return S.to;
  var t = Math.min(1, (performance.now() - S.tween0) / 900); t = t * (2 - t);
  function lerpB(a, b) { return Object.assign({}, b, { apparentAltitude: altOf(a) + (altOf(b) - altOf(a)) * t, azimuth: (a.azimuth + wrap180(b.azimuth - a.azimuth) * t + 360) % 360 }); }
  return { sun: lerpB(S.from.sun, S.to.sun), moon: lerpB(S.from.moon, S.to.moon), tweening: t < 1 };
}
function defaultCenter(p) {
  if (altOf(p.sun) > -2) return p.sun.azimuth;
  if (altOf(p.moon) > -2) return p.moon.azimuth;
  return loc.lat >= 0 ? 180 : 0;
}
function drawMoon(x, y, r, m) {
  var k = m.phase.illuminatedFraction;
  var chi = (m.phase.brightLimbAngle - parallactic(altOf(m), m.azimuth, m.declination, loc.lat)) * D2R; // bright limb from the zenith, toward east
  var rot = Math.atan2(-Math.cos(chi), -Math.sin(chi));
  ctx.save(); ctx.translate(x, y);
  var g = ctx.createRadialGradient(0, 0, r, 0, 0, r * 4.5); g.addColorStop(0, "rgba(217,227,255," + (0.10 + 0.22 * k) + ")"); g.addColorStop(1, "rgba(217,227,255,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * 4.5, 0, 2 * Math.PI); ctx.fill();
  ctx.rotate(rot);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fillStyle = "rgba(60,70,100,.55)"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(0, 0, Math.max(0.01, r * Math.abs(1 - 2 * k)), r, 0, Math.PI / 2, -Math.PI / 2, k < 0.5);
  ctx.fillStyle = "#e9eeff"; ctx.fill();
  ctx.restore();
}
function drawSun(x, y, r, alt) {
  var g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 6);
  g.addColorStop(0, "rgba(255,214,140,.55)"); g.addColorStop(1, "rgba(255,214,140,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 6, 0, 2 * Math.PI); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = alt > 6 ? "#fff3d6" : "#ffc46b"; ctx.fill();
}
var FONT = "500 13px 'IBM Plex Sans', system-ui, sans-serif", SMALL = "400 11px 'IBM Plex Mono', ui-monospace, monospace";
function textBox(text, font) { ctx.font = font; return { w: Math.ceil(ctx.measureText(text).width) + 2, h: font === SMALL ? 13 : 16 }; }
function drawText(text, r, font, color) { // r: top-left rect
  ctx.font = font; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.save(); ctx.shadowColor = "rgba(4,6,13,.55)"; ctx.shadowBlur = 6;
  ctx.fillStyle = color; ctx.fillText(text, r.x + 1, r.y + r.h / 2); ctx.restore();
}
function path(pts, key, color, g, nowMs, out) {
  ctx.save(); ctx.beginPath(); ctx.rect(0, g.top, W, g.hy - g.top); ctx.clip();
  for (var pass = 0; pass < 2; pass++) { // pass 0: the past 12 h, faint; pass 1: the next 12 h
    ctx.beginPath(); var prev = null;
    pts.forEach(function (p) {
      var t = p.time ? Date.parse(p.time.utc) : nowMs;
      if (pass === 0 ? t > nowMs : t < nowMs) { return; }
      var b = p[key], x = X(b.azimuth, g), y = Y(Math.max(-2, altOf(b)), g);
      if (prev && Math.abs(x - prev[0]) < W / 2) { ctx.lineTo(x, y); out.push([prev[0], prev[1], x, y]); } else ctx.moveTo(x, y);
      prev = [x, y];
    });
    ctx.strokeStyle = color; ctx.globalAlpha = pass ? 0.55 : 0.22; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.restore(); ctx.globalAlpha = 1;
}
var dirty = true;
function draw() {
  var p = interp(); if (!W) return;
  var g = geom(), hy = g.hy, sunAlt = p ? altOf(p.sun) : -30, c = skyAt(sunAlt), nowMs = Date.now(), drawn = [];
  // sky
  var grad = ctx.createLinearGradient(0, 0, 0, hy); grad.addColorStop(0, c[0]); grad.addColorStop(1, c[1]);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, hy + 1);
  if (p && sunAlt > -18) { // glow on the horizon toward the Sun
    var gx = X(p.sun.azimuth, g), a = Math.max(0, 1 - Math.abs(sunAlt - 2) / 20) * 0.55;
    var rg = ctx.createRadialGradient(gx, hy, 0, gx, hy, Math.max(W, H) * 0.55); rg.addColorStop(0, "rgba(255,170,90," + a + ")"); rg.addColorStop(1, "rgba(255,170,90,0)");
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, hy);
  }
  // altitude rings: two faint lines, one small label each at the left edge
  var fixed = [];
  ctx.lineWidth = 1; ctx.setLineDash([2, 6]); ctx.strokeStyle = "rgba(255,255,255,.12)";
  [30, 60].forEach(function (alt) {
    var y = Y(alt, g); if (y < g.top + 8) return;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    var t = alt + "\\u00b0", b = textBox(t, SMALL); fixed.push({ id: "alt" + alt, t: t, x: 14, y: y - b.h - 3, w: b.w, h: b.h, font: SMALL, color: "rgba(255,255,255,.4)", text: true });
  });
  ctx.setLineDash([]);
  // ground and compass: ticks every 15°, names at the eight points
  var gg = ctx.createLinearGradient(0, hy, 0, H); gg.addColorStop(0, "#0c1020"); gg.addColorStop(1, "#070a14");
  ctx.fillStyle = gg; ctx.fillRect(0, hy, W, H - hy);
  ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.beginPath(); ctx.moveTo(0, hy + 0.5); ctx.lineTo(W, hy + 0.5); ctx.stroke();
  var ticks = [];
  for (var az = 0; az < 360; az += 15) {
    var x = X(az, g); if (x < -20 || x > W + 20) continue;
    var major = az % 45 === 0, len = major ? 8 : 4;
    ctx.strokeStyle = "rgba(255,255,255," + (major ? 0.55 : 0.22) + ")"; ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, hy + len); ctx.stroke();
    ticks.push({ id: "tick" + az, x: x - 1, y: hy, w: 2, h: len });
    if (major && x - 14 > 0 && x + 14 < W) { var t2 = compass(az), b2 = textBox(t2, SMALL); fixed.push({ id: "cmp" + t2, t: t2, x: x - b2.w / 2, y: hy + 14, w: b2.w, h: b2.h, font: SMALL, color: "rgba(255,255,255,.72)", text: true }); }
  }
  var segs = [];
  if (S.track.length) {
    var win = S.track.filter(function (x) { return Math.abs(Date.parse(x.time.utc) - nowMs) <= 12 * 3600e3; });
    if (p) { var at = win.findIndex(function (x) { return Date.parse(x.time.utc) > nowMs; }); win.splice(at < 0 ? win.length : at, 0, p); }
    path(win, "sun", "#ffc361", g, nowMs, segs); path(win, "moon", "#d9e3ff", g, nowMs, segs);
  }
  var discs = [], items = [], colors = { Sun: "rgba(255,226,170,.96)", Moon: "rgba(232,238,255,.94)" };
  if (p) {
    var r = Math.max(10, Math.min(16, W / 80));
    [["Sun", p.sun], ["Moon", p.moon]].forEach(function (o) {
      var b = o[1], bx = X(b.azimuth, g), by = skyY(b, g.hy, g.k), box = textBox(o[0], FONT);
      if (isSet(b, g.k, r)) return; // fully set: the sentence says so
      if (bx < -r || bx > W + r) { // off to one side: a name and an arrow at that edge, at the body's height
        var left = bx < 0, t = left ? "\\u2190 " + o[0] : o[0] + " \\u2192", eb = textBox(t, FONT);
        items.push({ id: o[0] + "-edge", t: t, x: left ? 12 : W - 12, y: Math.max(g.top + eb.h, Math.min(hy - eb.h, by)), w: eb.w, h: eb.h, edge: left ? "left" : "right", color: colors[o[0]] });
        return;
      }
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, hy); ctx.clip(); // set behind the horizon
      if (o[0] === "Sun") drawSun(bx, by, r, altOf(b)); else drawMoon(bx, by, r, b);
      ctx.restore();
      var top = by - r, bottom = Math.min(hy, by + r);
      if (bottom > top) discs.push({ id: o[0] + "-disc", x: bx - r, y: top, w: 2 * r, h: bottom - top });
      items.push({ id: o[0], t: o[0], x: bx, y: by, r: r, w: box.w, h: box.h, color: colors[o[0]] });
    });
    if (p.tweening) dirty = true;
  }
  var band = { id: "ground", x: -1e4, y: hy - 2, w: 2e4, h: 1e4 };
  // Path lines near a label's anchor become small obstacles too, so a name sits beside its line rather than on it.
  var pathDots = [];
  segs.forEach(function (sg) {
    var n = Math.max(1, Math.ceil(Math.hypot(sg[2] - sg[0], sg[3] - sg[1]) / 5));
    for (var i = 0; i <= n; i++) { var px = sg[0] + (sg[2] - sg[0]) * i / n, py = sg[1] + (sg[3] - sg[1]) * i / n;
      if (items.some(function (it) { return Math.abs(px - it.x) < 140 && Math.abs(py - it.y) < 90; })) pathDots.push({ id: "path", x: px - 1.5, y: py - 1.5, w: 3, h: 3 }); }
  });
  var placed = placeLabels(items, discs.concat(fixed, ticks, [band]), { x0: 8, y0: g.top, x1: W - 8, y1: hy - 3 }, pathDots);
  // A fixed label (compass point, altitude ring) yields to a body or its label rather than being drawn under it.
  var shown = fixed.filter(function (f) { return !discs.concat(placed).some(function (o) { return overlapArea(f, o) > 0; }); });
  shown.forEach(function (f) { drawText(f.t, f, f.font, f.color); });
  placed.forEach(function (pl, i) { drawText(items[i].t, pl, FONT, items[i].color); });
  drawn = discs.concat(ticks, shown, placed.map(function (pl) { return Object.assign({ text: true }, pl); }));
  window.__sky = { rects: drawn, overlaps: overlaps(drawn), band: { top: g.top, hy: hy, bottom: g.bot } };
}
function frame() { if (dirty) { dirty = false; draw(); } requestAnimationFrame(frame); }

// pan; the hint goes after the first interaction or a few seconds, Recenter appears once you've looked away
var hintT = setTimeout(hideHint, 6000);
function hideHint() { clearTimeout(hintT); $("hint").classList.add("gone"); }
function panned() { S.userPanned = true; hideHint(); $("hint").hidden = true; $("recenter").hidden = false; dirty = true; }
var drag = null;
cv.parentElement.addEventListener("pointerdown", function (e) { if (e.target.closest("button")) return; drag = { x: e.clientX, c: S.center }; hideHint(); });
addEventListener("pointermove", function (e) { if (!drag || S.center == null) return; var g = geom(); if (Math.abs(e.clientX - drag.x) < 3) return; S.center = (drag.c - (e.clientX - drag.x) / g.k + 720) % 360; panned(); });
addEventListener("pointerup", function () { drag = null; });
addEventListener("pointercancel", function () { drag = null; });
cv.addEventListener("keydown", function (e) { if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && S.center != null) { S.center = (S.center + (e.key === "ArrowLeft" ? -10 : 10) + 360) % 360; panned(); e.preventDefault(); } });
$("recenter").addEventListener("click", function () { S.userPanned = false; if (S.to) S.center = defaultCenter(S.to); $("recenter").hidden = true; dirty = true; });

// ---------- readouts ----------
function cardsHtml(p) {
  function state(b) {
    var a = altOf(b), rising = wrap360(b.azimuth) < 180;
    return (a >= 0 ? (rising ? "Rising" : "Setting") : (rising ? "Below the horizon" : "Set")) + ", " + dirWord(b.azimuth);
  }
  function nums(b) {
    var m = azM(b.azimuth);
    return '<dl class="nums"><dt>Azimuth</dt><dd class="num"><span>' + azT(b.azimuth) + '</span>' + (m ? '<span>' + m + '</span>' : "") + '</dd>' +
      '<dt>Altitude</dt><dd class="num">' + d2(b.altitude) + '</dd><dt title="Altitude with atmospheric refraction">Apparent alt.</dt><dd class="num">' + (b.apparentAltitude == null ? "below horizon" : d2(b.apparentAltitude)) + '</dd></dl>';
  }
  var s = p.sun, m = p.moon, ph = m.phase;
  return '<article class="card sunc"><header><h3>Sun</h3><span class="state">' + state(s) + '</span></header>' + nums(s) +
    '<p class="foot"><span class="tn">' + (s.distanceKm / AU).toFixed(5) + '</span> au away</p></article>' +
    '<article class="card moonc"><header><h3>Moon</h3><span class="state">' + state(m) + '</span></header>' + nums(m) +
    '<p class="foot">' + ph.name.charAt(0).toUpperCase() + ph.name.slice(1) + ', <span class="tn">' + (ph.illuminatedFraction * 100).toFixed(1) + '%</span> lit, <span class="tn">' + Math.round(m.distanceKm).toLocaleString("en-US") + '</span> km away</p></article>';
}
function setPos(p) {
  S.from = S.to ? interp() : null; S.to = p; S.tween0 = performance.now();
  if (S.center == null || !S.userPanned) S.center = S.center == null ? defaultCenter(p) : (S.center + wrap180(defaultCenter(p) - S.center) + 360) % 360;
  $("bodies").innerHTML = cardsHtml(p); $("lede").textContent = lede(p.sun, p.moon);
  function ariaAlt(b) { return b.apparentAltitude == null ? "below the horizon (true altitude " + b.altitude.toFixed(2) + " degrees)" : b.apparentAltitude.toFixed(2) + " degrees apparent altitude"; }
  cv.setAttribute("aria-label", "Sun " + ariaAlt(p.sun) + ", azimuth " + p.sun.azimuth.toFixed(2) + " degrees true; Moon " + ariaAlt(p.moon) + ", azimuth " + p.moon.azimuth.toFixed(2) + " degrees true");
  dirty = true; diag();
}

var NAMES = { sun: { rise: "Sunrise", set: "Sunset", transit: "Solar noon", civilDawn: "Civil dawn", civilDusk: "Civil dusk", nauticalDawn: "Nautical dawn", nauticalDusk: "Nautical dusk",
  astronomicalDawn: "Astronomical dawn", astronomicalDusk: "Astronomical dusk", goldenHourStart: "Golden hour", goldenHourEnd: "Golden hour ends", blueHourStart: "Blue hour", blueHourEnd: "Blue hour ends" },
  moon: { rise: "Moonrise", set: "Moonset", transit: "Moon at its highest" } };
function evName(e) { return (NAMES[e.body] && NAMES[e.body][e.kind]) || e.kind; }
function upcoming(now) {
  var all = [].concat(S.day ? S.day.events : [], S.tomorrow ? S.tomorrow.events : []);
  var main = all.filter(function (e) { return e.kind === "rise" || e.kind === "set" || e.kind === "transit" || /Dawn|Dusk|HourStart/.test(e.kind); });
  return main.filter(function (e) { return Date.parse(e.time) > now; });
}
var lastNext = "";
function tick() {
  var now = Date.now();
  $("clock").textContent = hm(now);
  var up = upcoming(now), html = lastNext;
  if (up.length) {
    var e = up[0], t = Date.parse(e.time);
    html = '<b>' + evName(e) + '</b> ' + (localDate(t) !== localDate(now) ? "tomorrow " : "") + 'at <span class="tn">' + hm(t) + '</span>, <span class="tn" style="white-space:nowrap">' + countdown(t - now) + '</span>';
  } else if (S.day && !S.day.loading) html = "No rise, set or twilight in the next two days.";
  if (html !== lastNext) { lastNext = html; $("next").innerHTML = html; }
  if (S.day && localDate(now) !== S.day.date) loadDay();
  drawStripNow();
  wxAges();
}

// ---------- day strip ----------
var stripSvg = null;
function el(tag, a, txt) { var e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (var k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; }
function drawStrip() {
  var box = $("strip"); box.innerHTML = ""; if (!S.day || S.day.loading) return;
  var w = Math.max(300, Math.round(box.clientWidth || 1000)), h = 84, y0 = 16, bh = 36, s = Date.parse(S.day.start), span = Date.parse(S.day.end) - s;
  var svg = el("svg", { viewBox: "0 0 " + w + " " + h, role: "img", "aria-label": "Sky colour and events through the day" });
  var defs = el("defs", {}), lg = el("linearGradient", { id: "dayg", x1: "0", x2: "1", y1: "0", y2: "0" });
  S.track.forEach(function (p) { var f = (Date.parse(p.time.utc) - s) / span; if (f >= 0 && f <= 1) lg.appendChild(el("stop", { offset: f.toFixed(4), "stop-color": skyAt(altOf(p.sun))[1] })); });
  defs.appendChild(lg); svg.appendChild(defs);
  svg.appendChild(el("rect", { x: 0, y: y0, width: w, height: bh, rx: 8, fill: S.track.length ? "url(#dayg)" : "#111628" }));
  for (var hh = 0; hh <= 24; hh += w < 600 ? 6 : 3) { var x = Math.min(w, hh * 3600e3 / span * w); svg.appendChild(el("text", { x: x, y: y0 + bh + 20, "text-anchor": hh === 0 ? "start" : x >= w - 1 ? "end" : "middle", "font-size": 11 }, String(hh).padStart(2, "0") + ":00")); }
  S.day.events.forEach(function (e) {
    if (!(e.kind === "rise" || e.kind === "set" || e.kind === "transit")) return;
    var x = (Date.parse(e.time) - s) / span * w, col = e.body === "sun" ? "#ffc361" : "#d9e3ff";
    svg.appendChild(el("line", { x1: x, x2: x, y1: y0 - 6, y2: y0 + bh, stroke: col, "stroke-width": 1.5, "stroke-opacity": 0.9 }));
    svg.appendChild(el("circle", { cx: x, cy: y0 - 8, r: 2.5, fill: col }));
  });
  stripSvg = { svg: svg, now: el("line", { y1: y0 - 3, y2: y0 + bh + 3, stroke: "#fff", "stroke-width": 2.5 }), s: s, span: span, w: w };
  svg.appendChild(stripSvg.now); box.appendChild(svg); drawStripNow();
}
function drawStripNow() { if (!stripSvg) return; var f = (Date.now() - stripSvg.s) / stripSvg.span; stripSvg.now.setAttribute("x1", f * stripSvg.w); stripSvg.now.setAttribute("x2", f * stripSvg.w); stripSvg.now.style.display = f >= 0 && f <= 1 ? "" : "none"; }
var evMoreOpen = false;
function drawEvents() {
  var now = Date.now();
  function row(e) { var t = Date.parse(e.time); return '<div class="' + (t < now ? "past" : "") + '"><span class="' + (e.body === "sun" ? "s" : "m") + '">' + evName(e) + '</span><span class="tn">' + hm(t) + "</span></div>"; }
  var main = S.day.events.filter(function (e) { return e.kind === "rise" || e.kind === "set" || e.kind === "transit"; }), more = S.day.events.filter(function (e) { return main.indexOf(e) < 0; });
  $("evs").innerHTML = (main.map(row).join("") || '<div>No rise or set today.</div>') +
    (more.length ? '<details class="more" id="evmore"' + (evMoreOpen ? " open" : "") + '><summary>Twilight, golden and blue hours</summary><div class="evs">' + more.map(row).join("") + '</div></details>' : "");
  if ($("evmore")) $("evmore").addEventListener("toggle", function (e) { evMoreOpen = e.target.open; });
  $("dayTitle").textContent = fmt({ weekday: "long", day: "numeric", month: "long" }).format(new Date(Date.parse(S.day.start) + 12 * 3600e3));
}

// ---------- loading ----------
function err(e) { S.err = e.message || String(e); var s = document.createElement("span"); s.className = "err"; s.textContent = "The API answered with an error: " + S.err; $("foot").replaceChildren(s); }
function loadPos() { return api("/v1/position", Object.assign(q(), { time: new Date().toISOString() })).then(setPos).catch(err); }
function loadDay() {
  var today = localDate(Date.now());
  S.day = { date: today, events: [], start: new Date().toISOString(), end: new Date().toISOString(), loading: true };
  return Promise.all([api("/v1/day", Object.assign(q(), { date: today, tz: loc.tz })), api("/v1/day", Object.assign(q(), { date: nextDate(today), tz: loc.tz }))])
    .then(function (r) { S.day = r[0]; S.tomorrow = r[1]; drawEvents(); drawStrip(); tick(); return loadTrack(); }).catch(err);
}
function loadMag() {
  return api("/v1/magnetic", q(), true).then(function (b) { S.decl = b.magnetic.declination; if (S.to) $("bodies").innerHTML = cardsHtml(S.to); if (S.wx) drawWx(); diag(); })
    .catch(function () { S.decl = null; });
}
function loadWx() {
  return api("/v1/weather", Object.assign(q(), { n: 3 }), true).then(function (b) { S.wx = b; S.wxAt = Date.now(); drawWx(); diag(); })
    .catch(function (e) { $("wx").innerHTML = '<span class="err">Weather unavailable: ' + esc(e.message || e) + '</span>'; });
}
function num(x, digits, unit) { return x == null ? "\\u2014" : '<span class="tn">' + x.toFixed(digits) + '</span>' + unit; }
function clouds(s) {
  if (!s.sky.length) return s.verticalVisibilityFt != null ? "Vertical visibility " + s.verticalVisibilityFt + " ft" : (/ (CLR|SKC|CAVOK|NSC) /.test(" " + s.raw + " ") ? "None" : "Not reported");
  return s.sky.map(function (l) { return l.cover + (l.baseFtAgl != null ? ' <span class="tn">' + l.baseFtAgl.toLocaleString("en-US") + "</span> ft" : ""); }).join(", ");
}
function utcHm(iso) { return iso.slice(11, 16) + "Z"; }
// Seconds since the wall clock when the answer arrived (the observation's age is the API's, plus time on this page).
function wxDt() { return (Date.now() - S.wxAt) / 1000; }
function wxAges() {
  var e = $("wxage"); if (!e || !S.wx || !S.wx.stations.length) return;
  var oa = S.wx.stations[0].observationAgeSeconds + wxDt(); // METARs are hourly; amber once one is a quarter-hour overdue
  e.className = "age" + (oa > 4500 ? " warn" : ""); e.textContent = "updated " + ago(oa);
  if ($("hood").open) diag();
}
function drawWx() {
  var w = S.wx, box = $("wx");
  if (!w.stations.length) { box.innerHTML = '<span class="note">No station reported.</span>'; return; }
  var s = w.stations[0], decl = S.decl != null ? S.decl : w.observer && w.observer.magneticDeclination;
  var raws = w.stations.map(function (x) {
    return '<span class="c"># ' + esc(x.stationId) + ', ' + x.distanceKm.toFixed(2) + ' km, observed ' + esc(utcHm(x.observationTime)) + ' (' + hm(Date.parse(x.observationTime)) + ' local)</span>\\n' + esc(x.raw);
  }).join("\\n\\n");
  var vis = s.visibility.statuteMiles == null ? "\\u2014" : '<span class="tn">' + s.visibility.statuteMiles + (s.visibility.orMore ? "+" : "") + "</span> mi";
  box.innerHTML = '<div class="wxtop"><span class="temp tn">' + (s.temperatureC == null ? "\\u2014" : s.temperatureC.toFixed(1) + "\\u00b0C") + '</span>' +
    '<div><div class="cond">' + esc(condition(s)) + '</div><div class="wind tn">' + esc(windText(s.wind, decl)) + '</div></div></div>' +
    '<dl class="wxs"><div><dt>Dew point</dt><dd>' + num(s.dewpointC, 1, "\\u00b0C") + '</dd></div><div><dt>Visibility</dt><dd>' + vis + '</dd></div>' +
    '<div><dt>Pressure</dt><dd>' + (s.altimeterHpa != null ? num(s.altimeterHpa, 1, " hPa") : num(s.altimeterInHg, 2, " inHg")) + '</dd></div><div><dt>Clouds</dt><dd>' + clouds(s) + '</dd></div></dl>' +
    '<p class="station">' + esc(s.stationId) + ', <span class="tn">' + s.distanceKm.toFixed(2) + '</span> km away at <span class="tn">' + azT(s.bearing.true) + ' \\u00b7 ' + s.bearing.magnetic.toFixed(2) + '\\u00b0 M</span>, <span class="age" id="wxage"></span></p>' +
    '<details class="raw" id="rawd"' + (S.rawOpen ? " open" : "") + '><summary>Raw METAR</summary><pre>' + raws + '</pre></details>';
  $("rawd").addEventListener("toggle", function (e) { S.rawOpen = e.target.open; });
  wxAges();
}
function loadTrack() {
  // Samples cover the local day (for the strip) and now ± 12 h (for the paths), on a 20-minute grid aligned to UTC.
  var G = 1200e3, now = Date.now(), s = Math.floor(Math.min(Date.parse(S.day.start), now - 12 * 3600e3) / G) * G, e = Math.ceil(Math.max(Date.parse(S.day.end), now + 12 * 3600e3) / G) * G, jobs = [];
  for (var t = s; t <= e; t += G) jobs.push(api("/v1/position", Object.assign(q(), { time: new Date(t).toISOString() })));
  return Promise.all(jobs).then(function (rs) { S.track = rs; drawStrip(); dirty = true; });
}
function pad(k) { return (k + "                    ").slice(0, 18); }
function diag() {
  var out = [];
  if (S.last) {
    var d = S.last.prov && S.last.prov.diagnostics, c = d && d.cache;
    out.push('<span class="c"># last position answer</span>', "GET " + esc(S.last.url), pad("round trip") + S.last.ms.toFixed(1) + " ms");
    if (d) out.push(pad("DE440 blocks") + d.blocks.join(", "), pad("cache") + ["L1 " + c.l1].concat(Object.keys(c).filter(function (k) { return k.indexOf("blocks_") === 0; }).map(function (k) { return k.slice(7) + " " + c[k]; })).join(", "), pad("coefficient reads") + c.reads);
    out.push(pad("served by") + "Cloudflare " + esc(LOC.colo || "edge") + ", refreshed every 5 s");
  }
  if (S.wx) {
    var f = S.wx.feed, dt = wxDt();
    out.push("", '<span class="c"># weather feed</span>', pad("feed fetched") + ago(f.ageSeconds + dt) + (f.stale ? " (stale)" : "") + (f.tier === "stale-on-error" ? " (upstream unreachable)" : ""),
      pad("file updated") + (f.upstreamAgeSeconds != null ? ago(f.upstreamAgeSeconds + dt) : "\\u2014"), pad("stations in feed") + f.stations.toLocaleString("en-US"), pad("cache tier") + esc(f.tier));
  }
  out.push("", '<span class="c"># location</span>', pad("coordinates") + loc.lat.toFixed(5) + ", " + loc.lon.toFixed(5) + (loc.source === "device" ? " (\\u00b1" + Math.round(loc.acc) + " m)" : ""),
    pad("time zone") + esc(loc.tz), pad("source") + (loc.source === "cloudflare" ? "Cloudflare geolocation" + (LOC.colo ? ", " + esc(LOC.colo) : "") : loc.source === "device" ? "your device" : loc.source === "query" ? "the link" : "default"),
    pad("declination") + (S.decl == null ? "\\u2014" : d2(Math.abs(S.decl)) + (S.decl < 0 ? " W" : " E") + " (WMM2025)"));
  $("diag").innerHTML = out.join("\\n");
  var prov = S.last && S.last.prov;
  if (!S.err) $("foot").innerHTML = "<span>ephem " + esc((prov && prov.version) || "") + "</span><span>" + esc((prov && prov.ephemeris) || "JPL DE440") + "</span><span>" +
    (loc.source === "cloudflare" ? "Location approximate, from Cloudflare" : loc.source === "device" ? "Location from your device" : loc.source === "query" ? "Location from the link" : "Default location") + "</span>";
}
function header() {
  $("place").textContent = loc.city;
  $("place").classList.toggle("coords", /^[0-9.]+\u00b0 [NS], [0-9.]+\u00b0 [EW]$/.test(loc.city)); // a bare coordinate title: smaller, so it fits on one line at 390 px
  document.title = "ephem \\u00b7 the sky over " + loc.city;
  var b = location.origin;
  $("curl").textContent = "curl '" + b + "/v1/position?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&time=" + new Date().toISOString().slice(0, 19) + "Z'\\n\\n" +
    "curl '" + b + "/v1/day?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&date=" + localDate(Date.now()) + "&tz=" + loc.tz + "'\\n\\n" +
    "curl '" + b + "/v1/weather?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&n=3'";
}
function reloadAll() { S.track = []; S.from = null; S.decl = null; header(); diag(); return Promise.all([loadMag(), loadPos(), loadDay(), loadWx()]); }

$("locate").addEventListener("click", function () {
  if (!navigator.geolocation) { $("locnote").textContent = "This browser has no location API."; return; }
  $("locnote").textContent = "Asking your browser…";
  navigator.geolocation.getCurrentPosition(function (g) {
    loc = { lat: g.coords.latitude, lon: g.coords.longitude, place: "your location", city: "Your location", tz: loc.tz, source: "device", acc: g.coords.accuracy };
    $("locnote").textContent = ""; history.replaceState(null, "", "?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&tz=" + encodeURIComponent(loc.tz)); reloadAll();
  }, function (e) { $("locnote").textContent = e.code === 1 ? "Location permission denied; using Cloudflare's estimate." : "Couldn't get a location fix."; }, { enableHighAccuracy: true, timeout: 10000 });
});
$("share").addEventListener("click", function () {
  var u = location.origin + "/?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&tz=" + encodeURIComponent(loc.tz) + (loc.source === "device" ? "" : "&place=" + encodeURIComponent(loc.city));
  (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { $("locnote").textContent = "Link copied."; }, function () { $("locnote").textContent = u; });
});
$("hood").addEventListener("toggle", diag);

var rsT = 0; addEventListener("resize", function () { resize(); clearTimeout(rsT); rsT = setTimeout(drawStrip, 150); });
document.addEventListener("visibilitychange", function () { if (!document.hidden) loadPos(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { dirty = true; });
resize(); header(); requestAnimationFrame(frame);
reloadAll();
setInterval(function () { if (!document.hidden) loadPos(); }, 5000);
setInterval(tick, 1000); tick();
setInterval(function () { if (!document.hidden && S.day && !S.day.loading) loadTrack(); }, 3600e3);
setInterval(function () { if (!document.hidden) loadWx(); }, 60e3);
})();
</script>
</body></html>`
