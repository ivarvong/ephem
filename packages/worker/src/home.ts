// GET /: the live sky over wherever the visitor is. Location comes from Cloudflare (request.cf) unless ?lat&lon override it;
// every number on the page comes from this Worker's own /v1 API, fetched by the page from the same origin.
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { isValidZone } from "@ephem/core"
import { RUM_JS } from "./rum.ts"
import { ICON_LINK } from "./favicon.ts"
import { CLIENT_TRACE_JS, documentTrace, documentTraceHeaders, traceparentMeta, type DocumentTrace } from "./clienttrace.ts"

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
  const tid = yield* documentTrace(req)   // on the root span; the page's fetches are its children (src/clienttrace.ts)
  return yield* Effect.gen(function* () {
    const url = Option.getOrElse(HttpServerRequest.toURL(req), () => new URL("http://localhost/"))
    const v = visitor(url, (req.source as { cf?: CfLocation }).cf)
    yield* Effect.annotateCurrentSpan({ "home.source": v.source, "home.colo": v.colo ?? "", "home.tz": v.tz })
    return HttpServerResponse.text(page(v, tid), { contentType: "text/html; charset=utf-8", headers: { "cache-control": "private, no-store", ...documentTraceHeaders(tid) } })
  }).pipe(Effect.withSpan("home"))
}))

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
    best.id = it.id; best.clear = hard === 0; out.push(best);
    if (it.optional && !best.clear) best.dropped = true; else taken.push(best);   // an optional label with no clear spot is not drawn
  });
  return out;
}
function overlaps(rects) {
  var bad = [];
  for (var i = 0; i < rects.length; i++) for (var j = i + 1; j < rects.length; j++) if ((rects[i].text || rects[j].text) && overlapArea(rects[i], rects[j]) > 0) bad.push(rects[i].id + " x " + rects[j].id);
  return bad;
}
// Does segment s = [x1, y1, x2, y2] touch rect r? (Liang-Barsky clipping.)
function segHitsRect(s, r) {
  var x1 = s[0], y1 = s[1], dx = s[2] - x1, dy = s[3] - y1, t0 = 0, t1 = 1;
  var p = [-dx, dx, -dy, dy], q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  for (var i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    var t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}
// Altitude-ring labels ("30\\u00b0") are part of the layout too: each takes the first spot along its ring (left edge, right edge,
// then stepping inward from both, above the line before below it) whose rect, grown by pad px, touches no path segment and no
// obstacle rect. null when the whole ring is crossed: the label is dropped rather than drawn under a line.
function ringLabelSpot(y, w, h, bounds, segs, obstacles, pad) {
  pad = pad == null ? 3 : pad;
  var xs = [], step = 24, mid = (bounds.x0 + bounds.x1) / 2;
  for (var k = 0; ; k++) {
    var l = bounds.x0 + 6 + k * step, r = bounds.x1 - 6 - w - k * step, any = false;
    if (l + w <= mid + step) { xs.push(l); any = true; }
    if (r >= mid - step) { xs.push(r); any = true; }
    if (!any) break;
  }
  for (var i = 0; i < xs.length; i++) for (var side = 0; side < 2; side++) {
    var rect = { x: xs[i], y: side ? y + 3 : y - h - 3, w: w, h: h };
    if (rect.y < bounds.y0 || rect.y + h > bounds.y1) continue;
    var grown = { x: rect.x - pad, y: rect.y - pad, w: w + 2 * pad, h: h + 2 * pad }, clear = true;
    for (var j = 0; j < segs.length && clear; j++) if (segHitsRect(segs[j], grown)) clear = false;
    for (var o = 0; o < obstacles.length && clear; o++) if (overlapArea(grown, obstacles[o]) > 0) clear = false;
    if (clear) return rect;
  }
  return null;
}
// ---- the sky chart: all 360° of azimuth by the whole altitude range, zenith to nadir ----
// Altitude to chart units: true scale from the zenith down to -18° (the sky and the three twilight bands), a quarter scale
// below (the deep ground, -18° to the nadir). 126 units in all; the sky above the horizon gets 90 of them.
var DEEP = 0.25;
function altU(a) { a = Math.max(-90, Math.min(90, a)); return a >= -18 ? a : -18 + (a + 18) * DEEP; }
var U_TOP = 90, U_BOT = altU(-90);
// A continuous azimuth sequence (no 360° jumps), so a track crosses the chart's seam as one line.
function unwrapAz(azs) { var out = [], prev = null; for (var i = 0; i < azs.length; i++) { var a = prev == null ? azs[i] : prev + wrap180(azs[i] - prev); out.push(a); prev = a; } return out; }
// The default frame shows all 360°, centred on the meridian (south in the north, north in the south) unless that puts a body
// within 30° of the seam (the chart's left/right edge, centre ± 180°); then the nearest centre, in 5° steps, that keeps both clear.
function chartCenter(lat, azs) {
  var mer = lat >= 0 ? 180 : 0, best = mer, bestS = -Infinity;
  for (var k = 0; k < 72; k++) {
    var c = wrap360(mer + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 5), d = 180;
    azs.forEach(function (a) { d = Math.min(d, Math.abs(wrap180(a - c - 180))); });
    var s = Math.min(d, 30) - 0.01 * Math.abs(wrap180(c - mer));
    if (s > bestS) { bestS = s; best = c; }
  }
  return best;
}
// Horizon crossings and culminations from track samples [{t, alt (true), az}]: h0 is the centre's true altitude at rise/set.
// Crossings interpolate linearly between samples; transit and anti-transit (upper and lower culmination) take the vertex of a
// parabola through three samples. Times here are within a minute or so; the page prefers /v1/day's exact time when it has one.
function trackEvents(s, h0) {
  var out = [], az = unwrapAz(s.map(function (p) { return p.az; }));
  for (var i = 1; i < s.length; i++) {
    var a = s[i - 1].alt - h0, b = s[i].alt - h0;
    if ((a < 0) !== (b < 0)) { var f = a / (a - b); out.push({ kind: b > a ? "rise" : "set", t: s[i - 1].t + f * (s[i].t - s[i - 1].t), az: wrap360(az[i - 1] + f * (az[i] - az[i - 1])), alt: h0 }); }
    if (i < s.length - 1) {
      var y0 = s[i - 1].alt, y1 = s[i].alt, y2 = s[i + 1].alt;
      if ((y1 > y0 && y1 >= y2) || (y1 < y0 && y1 <= y2)) {
        var den = y0 - 2 * y1 + y2, v = den ? Math.max(-1, Math.min(1, 0.5 * (y0 - y2) / den)) : 0;
        var azv = v >= 0 ? az[i] + v * (az[i + 1] - az[i]) : az[i] + v * (az[i] - az[i - 1]);
        out.push({ kind: y1 > y0 ? "transit" : "antitransit", t: s[i].t + v * (s[i].t - s[i - 1].t), az: wrap360(azv), alt: y1 - 0.25 * (y0 - y2) * v });
      }
    }
  }
  return out.sort(function (x, y) { return x.t - y.t; });
}
// Pointing: where the phone's back camera looks, from a deviceorientation event. The camera is the device's -z axis; with the
// W3C rotation R = Rz(alpha) Rx(beta) Ry(gamma) its east/north/up components give the altitude, and its azimuth too when alpha is
// absolute (Android's deviceorientationabsolute). iOS gives webkitCompassHeading instead. Both headings are magnetic, so the
// WMM declination (east positive) turns them true. Returns {az, alt} in degrees, or null without a heading.
function poseFrom(e, decl) {
  if (e.beta == null || e.gamma == null) return null;
  var a = (e.alpha || 0) * Math.PI / 180, b = e.beta * Math.PI / 180, g = e.gamma * Math.PI / 180;
  var vx = -Math.sin(g) * Math.cos(a) - Math.cos(g) * Math.sin(b) * Math.sin(a), vy = -Math.sin(g) * Math.sin(a) + Math.cos(g) * Math.sin(b) * Math.cos(a), vz = -Math.cos(b) * Math.cos(g);
  var mag = e.webkitCompassHeading != null ? e.webkitCompassHeading : e.absolute && e.alpha != null ? Math.atan2(vx, vy) * 180 / Math.PI : null;
  if (mag == null) return null;
  return { az: wrap360(mag + (decl || 0)), alt: Math.asin(Math.max(-1, Math.min(1, vz))) * 180 / Math.PI };
}
// "Moon, 23.4° below the horizon: turn 40° left, tilt 41° down". b: {az, alt}; pose: {az, alt}. Within 3° is on target.
function aimText(name, b, pose) {
  var d = wrap180(b.az - pose.az), e = b.alt - pose.alt, parts = [];
  if (Math.abs(d) >= 3) parts.push("turn " + Math.round(Math.abs(d)) + "\\u00b0 " + (d < 0 ? "left" : "right"));
  if (Math.abs(e) >= 3) parts.push("tilt " + Math.round(Math.abs(e)) + "\\u00b0 " + (e < 0 ? "down" : "up"));
  return name + (b.alt < 0 ? ", " + Math.abs(b.alt).toFixed(1) + "\\u00b0 below the horizon" : "") + ": " + (parts.length ? parts.join(", ") : "dead ahead");
}
`

export const page = (v: Visitor, trace?: DocumentTrace) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
${traceparentMeta(trace)}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ephem · the sky over ${v.city.replace(/[<>&"]/g, "")}</title>
<meta name="description" content="Where the Sun and the Moon are right now, from JPL DE440, computed on Cloudflare's edge.">
<meta name="theme-color" content="#05070b" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#f3f4f6" media="(prefers-color-scheme: light)">
${ICON_LINK}
<style>
/* Mission-ops idiom: near-black, 1px hairlines, a strict grid, uppercase tracked labels, tabular mono readouts,
   one accent (--accent) plus status colours (--ok, --caution, --alert). System fonts only: no web-font bytes. */
:root{--bg:#05070b;--ink:#e9edf3;--muted:#8c95a7;--faint:#586174;--line:rgba(255,255,255,.09);--line2:rgba(255,255,255,.18);
--accent:#7cc4ff;--ok:#3ddc97;--caution:#ffb547;--alert:#ff6b5e;--sun:#ffc361;--moon:#d9e3ff;--maxw:1120px;
--sans:"Helvetica Neue",Helvetica,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f3f4f6;--ink:#0c1016;--muted:#535c6c;--faint:#7c8595;--line:rgba(12,16,22,.11);--line2:rgba(12,16,22,.24);
--accent:#0a63bd;--ok:#0b7f55;--caution:#9a5600;--alert:#c02d1d;--sun:#a86200;--moon:#3e4f82;color-scheme:light}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.num,.tn{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:0}
.lbl{font:500 11px/1.3 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.gut{padding-left:max(16px,env(safe-area-inset-left),calc((100% - var(--maxw)) / 2));padding-right:max(16px,env(safe-area-inset-right),calc((100% - var(--maxw)) / 2))}
/* the page header, then the sky chart: an instrument display, always dark (it is the sky), framed like the cards below */
.hero{padding-top:max(14px,env(safe-area-inset-top));padding-bottom:12px}
.sky{padding-top:0;padding-bottom:0}
.scr{position:relative;height:clamp(232px,40svh,460px);border:1px solid var(--line);border-radius:2px;overflow:hidden;background:#05070b;touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none}
.scr:active{cursor:grabbing}
.scr canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.brand{display:flex;align-items:center;gap:14px;font:600 11px/1 var(--sans);letter-spacing:.22em;color:var(--ink)}
.live{display:inline-flex;align-items:center;gap:6px;font:500 10px/1 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.live i{width:6px;height:6px;border-radius:50%;background:var(--muted)}
.live.ok i{background:var(--ok)}.live.caution i{background:var(--caution)}.live.alert i{background:var(--alert)}.live.alert{color:var(--alert)}
h1{font:500 clamp(30px,4.8vw,56px)/1.05 var(--sans);letter-spacing:-.025em;margin:12px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1.coords{font-size:clamp(22px,3.4vw,44px);font-family:var(--mono);letter-spacing:-.02em;margin-top:14px}
.now{text-align:right;flex:none}
.now .lbl{display:block;margin-top:2px}
.clock{font:400 clamp(24px,2.6vw,32px)/1 var(--mono);font-variant-numeric:tabular-nums;margin-top:6px}
.ctl{position:absolute;top:0;right:0;z-index:2;display:flex}
.ctl button{min-height:44px;font:500 10px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:#eef1f6;background:transparent;border:0;padding:0 12px;cursor:pointer}
.ctl button span{display:inline-block;padding:6px 9px;background:rgba(5,7,11,.72);border:1px solid rgba(255,255,255,.24);border-radius:2px}
.ctl button:hover span{border-color:#eef1f6}
.bottom{max-width:42rem;padding-top:14px;padding-bottom:4px}
.guide{margin:0 0 10px;font:12.5px/1.5 var(--mono);color:var(--accent);white-space:pre-line}
.lede{font:400 clamp(19px,2.3vw,26px)/1.3 var(--sans);letter-spacing:-.01em;margin:0;text-wrap:pretty}
.next{margin:10px 0 0;font:14px/1.45 var(--sans);color:var(--muted);display:flex;gap:12px;align-items:baseline}
.next .lbl{flex:none;color:var(--accent)}
.next b{color:var(--ink);font-weight:500}
main{counter-reset:sec;padding-bottom:40px}
.blk{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;padding:28px 0 32px;border-top:1px solid var(--line)}
.blk:first-child{border-top:0}
.blk>h2,.hood>summary{margin:0;font:500 11px/1.3 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.blk>h2::before,.hood>summary::before{counter-increment:sec;content:counter(sec,decimal-leading-zero);font-family:var(--mono);letter-spacing:0;color:var(--faint);margin-right:12px}
.bodies{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
.card{border:1px solid var(--line);border-radius:2px;min-width:0}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line)}
.card h3{margin:0;font:600 12px/1.2 var(--sans);letter-spacing:.2em;text-transform:uppercase;display:flex;align-items:center;gap:10px}
.card h3::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.sunc h3{color:var(--sun)}.moonc h3{color:var(--moon)}
.card .state{font:500 10.5px/1.3 var(--sans);letter-spacing:.12em;text-transform:uppercase;color:var(--muted);text-align:right}
dl.cells{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin:0}
dl.cells>div{padding:12px 16px 14px;min-width:0;border-top:1px solid var(--line)}
dl.cells>div:nth-child(-n+2){border-top:0}
dl.cells>div:nth-child(2n){border-left:1px solid var(--line)}
dl.cells dt{font:500 10.5px/1.3 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
dl.cells dd{margin:6px 0 0;font-size:16px;line-height:1.35;display:flex;flex-direction:column;white-space:nowrap}
dl.cells dd span+span{color:var(--muted)}
.card .foot{margin:0;padding:12px 16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
.big{font:400 22px/1.2 var(--sans);letter-spacing:-.01em;margin:0}
.sub{color:var(--muted);margin:6px 0 16px;font-size:13px}
.strip svg{display:block;width:100%;height:auto}
.strip text{font-family:var(--mono);fill:var(--muted)}
.strip .nowl{stroke:var(--ink)}
.strip line.es{stroke:var(--sun)}.strip circle.es{fill:var(--sun)}.strip line.em{stroke:var(--moon)}.strip circle.em{fill:var(--moon)}
.evs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0 32px;margin-top:16px;font-size:14px}
.evs>div{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}
.evs .past{color:var(--faint)}
.evs details.more{grid-column:1/-1;margin-top:4px}.evs details.more .evs{margin-top:0}
.evs .s::before,.evs .m::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:10px;vertical-align:1px}
.evs .s::before{background:var(--sun)}.evs .m::before{background:var(--moon)}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px;align-items:center}
.btn{min-height:44px;display:inline-flex;align-items:center;font:500 11px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--ink);background:transparent;border:1px solid var(--line2);border-radius:2px;padding:0 16px;cursor:pointer}
.btn:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.note{font-size:13px;color:var(--muted)}
.wxc{display:grid;gap:16px}
.wxtop{display:flex;align-items:center;gap:8px 20px;flex-wrap:wrap}
.temp{font:300 44px/1 var(--sans);letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.wxtop .cond{font:500 16px/1.3 var(--sans)}
.wxtop .wind{color:var(--muted);font:13px/1.4 var(--mono)}
.wxc dl.cells{grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:2px}
.wxc dl.cells>div{border-top:0;border-left:1px solid var(--line)}
.wxc dl.cells>div:first-child{border-left:0}
.wxc dl.cells dd{font-size:14px;white-space:normal;display:block}
.station{margin:0;color:var(--muted);font:12.5px/1.6 var(--mono)}
.age{white-space:nowrap}
.age::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ok);margin-right:7px;vertical-align:1px}
.age.warn{color:var(--caution)}.age.warn::before{background:var(--caution)}
details>summary{cursor:pointer;list-style:none;min-height:44px;display:flex;align-items:center;gap:10px;color:var(--accent);font:500 11px/1.3 var(--sans);letter-spacing:.14em;text-transform:uppercase}
details>summary::-webkit-details-marker{display:none}
details:not(.hood)>summary::before{content:"+";font:400 14px/1 var(--mono);width:10px}
details:not(.hood)[open]>summary::before{content:"\\2212"}
details.raw pre{margin:4px 0 0;padding:12px 14px;border-left:1px solid var(--line2);font:12px/1.65 var(--mono);color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
pre .c{color:var(--faint)}
.hood{border-top:1px solid var(--line);padding:16px 0 28px}
.hood>summary{justify-content:flex-start;gap:0}
.hood>summary::after{content:"+";margin-left:auto;font:400 16px/1 var(--mono);color:var(--muted)}
.hood[open]>summary::after{content:"\\2212"}
.hood .in{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px;margin-top:16px}
.hood h3{font:500 11px/1.3 var(--sans);letter-spacing:.14em;text-transform:uppercase;margin:0 0 8px}
.hood p{color:var(--muted);font-size:14px;margin:0 0 14px}
.hood pre{margin:0;border:1px solid var(--line);border-radius:2px;padding:14px 16px;overflow-x:auto;font:12px/1.7 var(--mono);color:var(--ink)}
footer.tel{border-top:1px solid var(--line);padding-top:14px;padding-bottom:max(14px,env(safe-area-inset-bottom));display:flex;flex-wrap:wrap;gap:6px 24px;font:11.5px/1.5 var(--mono);color:var(--muted)}
footer.tel i{font:500 10px/1 var(--sans);font-style:normal;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-right:8px}
:focus-visible{outline:1px solid var(--accent);outline-offset:3px}
.err{color:var(--alert)}
.inst{margin:0 0 8px;font:500 11px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase}.inst a{color:var(--faint);display:inline-flex;align-items:center;min-height:44px}.inst a:hover{color:var(--accent)}
@media (max-width:760px){.bodies,.hood .in{grid-template-columns:minmax(0,1fr)}.wxc dl.cells{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.wxc dl.cells>div:nth-child(n+3){border-top:1px solid var(--line)}.wxc dl.cells>div:nth-child(3){border-left:0}}
@media (min-width:900px){.blk{grid-template-columns:200px minmax(0,1fr);gap:32px}.blk>h2{padding-top:3px}.hero{padding-top:max(22px,env(safe-area-inset-top))}}
</style>
</head><body>
<header class="hero gut">
  <div class="top" id="top">
    <div style="min-width:0">
      <div class="brand">EPHEM<span class="live" id="live" role="status"><i></i><span id="liveT">Acquiring</span></span></div>
      <h1 id="place"></h1>
    </div>
    <div class="now">
      <span class="lbl">Local time</span>
      <div class="clock" id="clock">--:--</div>
    </div>
  </div>
</header>
<section class="sky gut" id="sky" aria-label="The Sun and the Moon on a chart of the whole sky, above and below the horizon">
  <div class="scr" id="scr">
    <canvas id="cv" tabindex="0" aria-label="Sky chart"></canvas>
    <div class="ctl" id="ctl"><button type="button" id="point" aria-pressed="false" hidden><span>Point phone</span></button><button type="button" id="recenter" hidden><span>Recenter</span></button></div>
  </div>
</section>
<div class="bottom gut" id="bottom">
  <p class="guide" id="guide" aria-live="polite" hidden></p>
  <p class="lede" id="lede">Finding the Sun and the Moon…</p>
  <p class="next"><span class="lbl">Next</span><span id="next">&nbsp;</span></p>
</div>
<main class="gut">
  <section class="blk">
    <h2>Ephemeris</h2>
    <div class="bodies" id="bodies" aria-label="Sun and Moon"></div>
  </section>
  <section class="blk day">
    <h2>Day</h2>
    <div>
      <p class="big" id="dayTitle">Today</p>
      <p class="sub">The sky's colour at the horizon, hour by hour.</p>
      <div class="strip" id="strip"></div>
      <div class="evs" id="evs"></div>
      <div class="row">
        <button class="btn" type="button" id="locate">Use my exact location</button>
        <button class="btn" type="button" id="share">Copy link</button>
        <span class="note" id="locnote"></span>
      </div>
    </div>
  </section>
  <section class="blk wx" aria-live="polite">
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
  <p class="inst"><a href="/instrument" id="inst">Instrument view</a></p>
  <footer class="tel" id="foot"></footer>
</main>
<script>const LOC = ${json(v)};</script>
<script>
(function () {
"use strict";
${CORE_JS}
${CLIENT_TRACE_JS}
${RUM_JS}
var D2R = Math.PI / 180, AU = 149597870.7;
var loc = { lat: LOC.lat, lon: LOC.lon, place: LOC.place, city: LOC.city, tz: LOC.tz, source: LOC.source, acc: null };
var $ = function (id) { return document.getElementById(id); };
// Debug only: ?at=<ISO time> freezes the page's clock there (and asks /v1/position for that time), so any sky state renders
// deterministically for screenshots; ?pose=<az>,<alt> with it fakes the phone's pointing. Real visitors never send it; / is
// no-store either way, and a timed position is the same immutable answer the API gives anyone.
var QS = new URLSearchParams(location.search), AT = (function () { var t = Date.parse(QS.get("at") || ""); return isFinite(t) && t > 63e9 && t < 5.6e12 ? t : null; })();
var AT_ISO = AT == null ? null : new Date(AT).toISOString();
function tNow() { return AT == null ? Date.now() : AT; }
var S = { decl: null, wx: null, wxAt: 0, rawOpen: false, to: null, pose: null, day: null, tomorrow: null, tomorrowFor: null, track: [], trackDay: null, center: null, userPanned: false, last: null, err: null };
if (AT != null && /^-?[0-9.]+,-?[0-9.]+$/.test(QS.get("pose") || "")) S.pose = { az: Number(QS.get("pose").split(",")[0]), alt: Number(QS.get("pose").split(",")[1]) };

// ---------- API ----------
function api(path, q, quiet) {
  var url = path + "?" + new URLSearchParams(q).toString(), t0 = performance.now();
  return __tfetch(url).then(function (r) {
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

// ---------- canvas: the sky chart ----------
// All 360° of azimuth (the default frame always shows all of it, so nothing is ever off-screen) by the whole altitude range:
// the sky (true scale), the horizon, the civil, nautical and astronomical twilight bands (true scale), then the deep ground at a
// quarter scale (altU, CORE_JS). Each body's 24 h track (now ± 12 h, from the one /v1/track answer) runs through sky and ground,
// past solid and future dashed; the bodies are always drawn where they are, dimmed below the horizon, with their depth.
// It draws only when something changes (requestDraw): data, resize, drag, pointing, fonts, or once a minute for the clock.
var cv = $("cv"), ctx = cv.getContext("2d"), W = 0, H = 0, dpr = 1, PAD_T = 10, AXIS = 20;
function geom() { var ky = (H - PAD_T - AXIS) / (U_TOP - U_BOT); return { kx: W / 360, ky: ky, top: PAD_T, hy: Math.round(PAD_T + U_TOP * ky) + 0.5, bot: H - AXIS }; }
function X(az, g) { return W / 2 + wrap180(az - S.center) * g.kx; }
function Y(alt, g) { return g.top + (U_TOP - altU(alt)) * g.ky; }
var drawQueued = false, drawnAt = 0;
function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(function () { drawQueued = false; draw(); }); } }
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  var r = cv.getBoundingClientRect(); if (r.width === W && r.height === H) return;
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); requestDraw();
}
function defaultCenter(p) { return S.pose ? S.pose.az : chartCenter(loc.lat, [p.sun.azimuth, p.moon.azimuth]); }
function drawMoon(x, y, r, m) {
  var k = m.phase.illuminatedFraction;
  var chi = (m.phase.brightLimbAngle - parallactic(altOf(m), m.azimuth, m.declination, loc.lat)) * D2R; // bright limb from the zenith, toward east
  var rot = Math.atan2(-Math.cos(chi), -Math.sin(chi));
  ctx.save(); ctx.translate(x, y);
  var g = ctx.createRadialGradient(0, 0, r, 0, 0, r * 3); g.addColorStop(0, "rgba(217,227,255," + (0.05 + 0.12 * k) + ")"); g.addColorStop(1, "rgba(217,227,255,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * 3, 0, 2 * Math.PI); ctx.fill();
  ctx.rotate(rot);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fillStyle = "rgba(60,70,100,.75)"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(0, 0, Math.max(0.01, r * Math.abs(1 - 2 * k)), r, 0, Math.PI / 2, -Math.PI / 2, k < 0.5);
  ctx.fillStyle = "#e9eeff"; ctx.fill();
  ctx.restore();
}
function drawSun(x, y, r, alt) {
  var g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 4);
  g.addColorStop(0, "rgba(255,214,140,.38)"); g.addColorStop(1, "rgba(255,214,140,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, 2 * Math.PI); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = alt > 6 ? "#fff3d6" : "#ffc46b"; ctx.fill();
}
var FONT = "600 11px 'Helvetica Neue', Helvetica, -apple-system, system-ui, sans-serif", SMALL = "400 10px ui-monospace, 'SF Mono', Menlo, monospace", TINY = "600 8.5px 'Helvetica Neue', Helvetica, -apple-system, system-ui, sans-serif";
var LH = { }; LH[FONT] = 15; LH[SMALL] = 13; LH[TINY] = 11;
function track(font) { if ("letterSpacing" in ctx) ctx.letterSpacing = font === SMALL ? "0.3px" : font === TINY ? "1.4px" : "1.4px"; }
function textW(text, font) { ctx.font = font; track(font); return Math.ceil(ctx.measureText(text).width) + 2; }
// A label: one or two lines (t, then t2 in SMALL), boxed to {w, h}.
function labelBox(t, font, t2) { var w = textW(t, font), h = LH[font]; if (t2) { w = Math.max(w, textW(t2, SMALL)); h += LH[SMALL]; } return { w: w, h: h }; }
function drawLabel(it, r) {
  ctx.save(); ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.shadowColor = "rgba(4,6,13,.9)"; ctx.shadowBlur = 4;
  var font = it.font || FONT, h1 = LH[font];
  ctx.font = font; track(font); ctx.fillStyle = it.color; ctx.fillText(it.t, r.x + 1, r.y + h1 / 2);
  if (it.t2) { ctx.font = SMALL; track(SMALL); ctx.fillStyle = it.color2 || it.color; ctx.fillText(it.t2, r.x + 1, r.y + h1 + LH[SMALL] / 2); }
  ctx.restore();
}
// An instrument reticle: a hairline ring RET px outside the disc, with four short ticks; dashed when the body is below the horizon.
var RET = 5;
function reticle(x, y, r, color, below) {
  var R = r + RET;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = 0.6; if (below) ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
  [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (d) { ctx.beginPath(); ctx.moveTo(x + d[0] * R, y + d[1] * R); ctx.lineTo(x + d[0] * (R + 4), y + d[1] * (R + 4)); ctx.stroke(); });
  ctx.restore();
}
// The tracks and their events, recomputed only when the track, today's events or the minute change (not per drag frame).
var TI = { key: "" };
function trackInfo(nowMs) {
  var key = S.track.length + ":" + (S.track[0] && S.track[0].t) + ":" + (S.day && S.day.date) + ":" + (S.day && S.day.events.length) + ":" + Math.floor(nowMs / 60e3);
  if (TI.key === key) return TI;
  var win = S.track.filter(function (x) { return Math.abs(x.t - nowMs) <= 12 * 3600e3 + 1; }), out = { key: key, win: win };
  var dayEv = [].concat(S.day ? S.day.events : [], S.tomorrow ? S.tomorrow.events : []);
  ["sun", "moon"].forEach(function (body) {
    var s = win.map(function (x) { return { t: x.t, alt: x[body].altitude, az: x[body].azimuth }; });
    out[body] = trackEvents(s, -0.833).map(function (e) {   // the exact /v1/day time when it has this event
      var k = e.kind === "antitransit" ? null : e.kind, m = k && dayEv.find(function (d) { return d.body === body && d.kind === k && Math.abs(Date.parse(d.time) - e.t) < 40 * 60e3; });
      return m ? Object.assign({}, e, { t: Date.parse(m.time) }) : e;
    });
  });
  TI = out; return out;
}
// One body's track: unwrapped azimuths so it crosses the seam as one line, drawn at every 360° offset that lands on the chart.
// Past solid, future dashed; the ground part at half strength. Segments go to out (for the ring labels and label avoidance).
function trackPath(win, p, key, color, g, nowMs, out) {
  var pts = win.slice(), at = pts.findIndex(function (x) { return x.t > nowMs; }); pts.splice(at < 0 ? pts.length : at, 0, Object.assign({ t: nowMs }, p));
  var az = unwrapAz(pts.map(function (x) { return x[key].azimuth; })), xs = [], ys = [], lo = Infinity, hi = -Infinity;
  for (var i = 0; i < pts.length; i++) { var xr = W / 2 + (az[i] - S.center) * g.kx; xs.push(xr); ys.push(Y(altOf(pts[i][key]), g)); lo = Math.min(lo, xr); hi = Math.max(hi, xr); }
  var span = 360 * g.kx, offs = [];
  for (var o = Math.floor((-hi) / span) - 1; o <= Math.ceil((W - lo) / span) + 1; o++) if (hi + o * span >= 0 && lo + o * span <= W) offs.push(o * span);
  [[0, g.hy, 1], [g.hy, g.bot - g.hy, 0.5]].forEach(function (clip) {
    ctx.save(); ctx.beginPath(); ctx.rect(0, clip[0], W, clip[1]); ctx.clip();
    for (var pass = 0; pass < 2; pass++) {   // 0: the past 12 h, solid; 1: the next 12 h, dashed
      ctx.beginPath();
      offs.forEach(function (dx) {
        var started = false;
        for (var j = 0; j < pts.length; j++) {
          if (pass === 0 ? pts[j].t > nowMs : pts[j].t < nowMs) continue;
          if (!started) { ctx.moveTo(xs[j] + dx, ys[j]); started = true; } else { ctx.lineTo(xs[j] + dx, ys[j]); if (clip[2] === 1) out.push([xs[j - 1] + dx, ys[j - 1], xs[j] + dx, ys[j]]); }
        }
      });
      ctx.strokeStyle = color; ctx.globalAlpha = (pass ? 0.85 : 0.5) * clip[2]; ctx.lineWidth = pass ? 1.4 : 1.1; ctx.setLineDash(pass ? [4, 3] : []); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
  });
  if (out.length === 0 && false) return;
}
// Every x at which azimuth az appears on the chart (one, or two at the seam).
function xsOf(az, g) { var x = X(az, g), r = [x]; if (x - 360 * g.kx >= -40) r.push(x - 360 * g.kx); if (x + 360 * g.kx <= W + 40) r.push(x + 360 * g.kx); return r; }
var COL = { sun: "#ffc361", moon: "#d9e3ff" }, LBL = { sun: "rgba(255,226,170,.97)", moon: "rgba(232,238,255,.96)" };
function draw() {
  if (!W) return;
  var p = S.to, g = geom(), hy = g.hy, sunAlt = p ? altOf(p.sun) : -30, c = skyAt(sunAlt), nowMs = tNow();
  drawnAt = nowMs;
  // sky above the horizon, coloured for the Sun's altitude; the glow on the horizon toward the Sun
  var grad = ctx.createLinearGradient(0, 0, 0, hy); grad.addColorStop(0, c[0]); grad.addColorStop(1, c[1]);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, hy);
  if (p && sunAlt > -18) {
    var a = Math.max(0, 1 - Math.abs(sunAlt - 2) / 20) * 0.55;
    xsOf(p.sun.azimuth, g).forEach(function (gx) { var rg = ctx.createRadialGradient(gx, hy, 0, gx, hy, Math.max(W, H) * 0.45); rg.addColorStop(0, "rgba(255,170,90," + a + ")"); rg.addColorStop(1, "rgba(255,170,90,0)"); ctx.fillStyle = rg; ctx.fillRect(0, 0, W, hy); });
  }
  // the ground: three twilight bands (the one the Sun is in, brighter), then the deep ground, then the compass axis
  ctx.fillStyle = "#07090e"; ctx.fillRect(0, hy, W, H - hy);
  var bands = [[0, -6, "CIVIL", 0.20], [-6, -12, "NAUTICAL", 0.12], [-12, -18, "ASTRONOMICAL", 0.065]], fixed = [], sunBand = -1;
  if (p) bands.forEach(function (b, i) { if (sunAlt <= b[0] && sunAlt > b[1]) sunBand = i; });
  bands.forEach(function (b, i) {
    var y0 = Y(b[0], g), y1 = Y(b[1], g), on = i === sunBand;
    ctx.fillStyle = "rgba(110,140,215," + (b[3] + (on ? 0.14 : 0)) + ")"; ctx.fillRect(0, y0, W, y1 - y0);
    if (y1 - y0 >= 9) fixed.push({ id: "band" + i, t: b[2], x: W - 6 - textW(b[2], TINY), y: (y0 + y1) / 2 - LH[TINY] / 2, w: textW(b[2], TINY), h: LH[TINY], font: TINY, color: on ? "rgba(225,233,255,.95)" : "rgba(190,205,240,.5)", text: true });
  });
  var y18 = Y(-18, g);
  ctx.fillStyle = "#04050a"; ctx.fillRect(0, y18, W, g.bot - y18);
  ctx.fillStyle = "#05070b"; ctx.fillRect(0, g.bot, W, H - g.bot);
  // grid: altitude rings at 30° and 60°, -45° in the deep ground, verticals at the eight compass points; the scale break at -18°
  var rings = [];
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,.09)";
  [30, 60].forEach(function (alt) { var y = Math.round(Y(alt, g)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); rings.push({ alt: alt, y: y }); });
  ctx.strokeStyle = "rgba(255,255,255,.05)";
  var y45 = Math.round(Y(-45, g)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y45); ctx.lineTo(W, y45); ctx.stroke();
  for (var vz = 0; vz < 360; vz += 45) xsOf(vz, g).forEach(function (vx) { vx = Math.round(vx) + 0.5; if (vx < 0 || vx > W) return; ctx.beginPath(); ctx.moveTo(vx, 0); ctx.lineTo(vx, g.bot); ctx.stroke(); });
  ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, Math.round(y18) + 0.5); ctx.lineTo(W, Math.round(y18) + 0.5); ctx.stroke(); ctx.setLineDash([]);
  var deepH = g.bot - y18, sc = "\\u221218\\u00b0 \\u00b7 \\u00bc scale below", nad = "\\u221290\\u00b0";
  var scaleNote = deepH >= 18 ? { t: sc, w: textW(sc, SMALL) } : null;   // placed with the ring labels, below the -18° line
  if (deepH >= 30) {
    fixed.push({ id: "nadir", t: nad, x: W - 6 - textW(nad, SMALL), y: g.bot - LH[SMALL] - 1, w: textW(nad, SMALL), h: LH[SMALL], font: SMALL, color: "rgba(255,255,255,.32)", text: true });
  }
  // horizon: the strong line, with compass ticks under it; names on the axis at the bottom
  ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke(); ctx.lineWidth = 1;
  var ticks = [];
  for (var az = 0; az < 360; az += 15) xsOf(az, g).forEach(function (x) {
    if (x < -2 || x > W + 2) return;
    var major = az % 45 === 0, len = major ? 6 : 3;
    ctx.strokeStyle = "rgba(255,255,255," + (major ? 0.6 : 0.3) + ")"; ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, hy + len); ctx.stroke();
    if (major) { var t2 = compass(az); ctx.font = SMALL; track(SMALL); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = az % 90 ? "rgba(255,255,255,.45)" : "rgba(255,255,255,.8)"; if (x > 6 && x < W - 6) ctx.fillText(t2, x, g.bot + AXIS / 2); }
  });
  ticks.push({ id: "horizon", x: -1e4, y: hy - 2, w: 2e4, h: 8 });
  // the tracks, their events, the bodies
  var segs = [], items = [], discs = [], marks = [], info = S.track.length ? trackInfo(nowMs) : null, r = Math.max(6, Math.min(10, W / 70));
  if (info) [["sun", COL.sun], ["moon", COL.moon]].forEach(function (o) { if (p) trackPath(info.win, p, o[0], o[1], g, nowMs, segs); });
  if (p) [["sun", "Sun", p.sun], ["moon", "Moon", p.moon]].forEach(function (o) {
    var key = o[0], b = o[2], alt = altOf(b), below = alt < 0, evs = info ? info[key] : [];
    // events: crossings on the horizon (time, azimuth), culminations on the track (time, altitude); future ones labelled first
    evs.forEach(function (e) {
      var future = e.t > nowMs, ex = X(e.az, g), ey = e.kind === "rise" || e.kind === "set" ? hy : Y(e.alt, g);
      ctx.save(); ctx.globalAlpha = future ? 0.95 : 0.5; ctx.strokeStyle = COL[key]; ctx.fillStyle = COL[key];
      if (e.kind === "rise" || e.kind === "set") { ctx.beginPath(); ctx.moveTo(ex, hy - 5); ctx.lineTo(ex, hy + 5); ctx.lineWidth = 1.5; ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(ex, ey, 2.5, 0, 2 * Math.PI); ctx.fillStyle = "#05070b"; ctx.fill(); ctx.stroke(); }
      ctx.restore();
      marks.push({ id: key + e.kind + "-mark", x: ex - 3, y: ey - 5, w: 6, h: 10 });
      var tt = (e.kind === "rise" ? "\\u2191" : e.kind === "set" ? "\\u2193" : "") + hm(e.t) + " " + (e.kind === "rise" || e.kind === "set" ? Math.round(wrap360(e.az)) % 360 : (e.alt < 0 ? "\\u2212" : "") + Math.abs(e.alt).toFixed(0)) + "\\u00b0";
      items.push({ id: key + "-" + e.kind + "-" + Math.round(e.t / 60e3), t: tt, font: SMALL, x: ex, y: ey, r: 3, w: textW(tt, SMALL), h: LH[SMALL], color: future ? LBL[key] : "rgba(222,228,240,.72)", optional: true, prio: future ? (e.kind === "rise" || e.kind === "set" ? 2 : 3) : 4 });
    });
    // the body itself, always: dimmed under the horizon, with its depth and its next crossing
    var bx = X(b.azimuth, g), by = Y(alt, g), nx = evs.filter(function (e) { return e.t > nowMs && (e.kind === "rise" || e.kind === "set"); })[0];
    ctx.save(); if (below) ctx.globalAlpha = 0.55;
    if (key === "sun") drawSun(bx, by, r, alt); else drawMoon(bx, by, r, b);
    ctx.restore();
    reticle(bx, by, r, LBL[key], below);
    var rr = r + RET + 4; discs.push({ id: o[1] + "-disc", x: bx - rr, y: by - rr, w: 2 * rr, h: 2 * rr });
    var t1 = o[1].toUpperCase() + " " + (alt < 0 ? "\\u2212" : "") + Math.abs(alt).toFixed(1) + "\\u00b0";
    var t2 = nx ? (nx.kind === "rise" ? "rises " : "sets ") + hm(nx.t) + " " + compass(nx.az) : info ? (below ? "stays down" : "stays up") + " next 12 h" : "";
    var bb = labelBox(t1, FONT, t2);
    items.push({ id: o[1], t: t1, t2: t2, x: bx, y: by, r: rr - 4, w: bb.w, h: bb.h, color: below ? "rgba(215,222,240,.88)" : LBL[key], color2: "rgba(225,232,245,.72)", prio: 0 });
  });
  // pointing mode: where the phone looks
  if (S.pose) {
    var px = X(S.pose.az, g), py = Y(S.pose.alt, g);
    ctx.save(); ctx.strokeStyle = "#7cc4ff"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(px, py, 14, 0, 2 * Math.PI); ctx.stroke();
    [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (d) { ctx.beginPath(); ctx.moveTo(px + d[0] * 8, py + d[1] * 8); ctx.lineTo(px + d[0] * 20, py + d[1] * 20); ctx.stroke(); });
    ctx.restore();
    discs.push({ id: "pose", x: px - 20, y: py - 20, w: 40, h: 40 });
  }
  // the buttons over the chart's top-right corner are in the way too
  var ce = $("ctl"); if (!$("point").hidden || !$("recenter").hidden) discs.push({ id: "ctl", x: W - ce.offsetWidth, y: 0, w: ce.offsetWidth, h: ce.offsetHeight });
  // ring labels: the first spot along each ring that no path line, disc or band label touches (dropped if none)
  var bounds = { x0: 4, y0: 2, x1: W - 4, y1: g.bot - 2 }, ringRects = [];
  rings.forEach(function (rg) {
    var t = rg.alt + "\\u00b0", w = textW(t, SMALL), spot = ringLabelSpot(rg.y, w, LH[SMALL], { x0: 4, y0: 2, x1: W - 4, y1: hy - 3 }, segs, discs.concat(ringRects, fixed), 3);
    if (!spot) return;
    var f = { id: "alt" + rg.alt, t: t, x: spot.x, y: spot.y, w: w, h: LH[SMALL], font: SMALL, color: "rgba(255,255,255,.5)", text: true };
    ringRects.push(f); fixed.push(f);
  });
  if (scaleNote) {   // the scale break is always labelled: the first clear spot along the -18° line, just below it
    var sn = ringLabelSpot(Math.round(y18) - 1, scaleNote.w, LH[SMALL], { x0: 4, y0: y18 + 1, x1: W - 4, y1: g.bot - 1 }, segs, discs.concat(fixed), 2);
    if (sn) fixed.push({ id: "scale", t: sc, x: sn.x, y: sn.y, w: scaleNote.w, h: LH[SMALL], font: SMALL, color: "rgba(255,255,255,.5)", text: true, keep: true });
  }
  // Path lines near a label's anchor become small soft obstacles, so a name sits beside its line rather than on it.
  items.sort(function (a, b) { return a.prio - b.prio; });
  var pathDots = [];
  segs.forEach(function (sg) {
    var n = Math.max(1, Math.ceil(Math.hypot(sg[2] - sg[0], sg[3] - sg[1]) / 5));
    for (var i = 0; i <= n; i++) { var qx = sg[0] + (sg[2] - sg[0]) * i / n, qy = sg[1] + (sg[3] - sg[1]) * i / n;
      if (items.some(function (it) { return Math.abs(qx - it.x) < 120 && Math.abs(qy - it.y) < 70; })) pathDots.push({ id: "path", x: qx - 1.5, y: qy - 1.5, w: 3, h: 3 }); }
  });
  // Two passes: the bodies' own labels first (only discs, markers and the horizon in the way); the scale labels then yield to
  // them; then the event labels, optional, wherever there is still clear room.
  var mine = items.filter(function (it) { return it.prio === 0; }), rest = items.filter(function (it) { return it.prio > 0; });
  var p1 = placeLabels(mine, discs.concat(ticks, marks, fixed.filter(function (f) { return f.keep; })), bounds);   // nearest clear spot, even across a track line
  var hard1 = discs.concat(p1);
  fixed = fixed.filter(function (f) { return f.keep || !hard1.some(function (o) { return overlapArea(f, o) > 0; }); });
  var p2 = placeLabels(rest, discs.concat(ticks, marks, fixed, p1), bounds, pathDots), placed = p1.concat(p2);
  items = mine.concat(rest);
  fixed.forEach(function (f) { drawLabel(f, f); });
  var shownLabels = [];
  placed.forEach(function (pl, i) { if (pl.dropped) return; drawLabel(items[i], pl); shownLabels.push(Object.assign({ text: true }, pl)); });
  var drawn = discs.concat(fixed, shownLabels);
  window.__sky = { rects: drawn, overlaps: overlaps(drawn), band: { top: g.top, hy: hy, bottom: g.bot }, segs: segs, rings: fixed.filter(function (f) { return f.id.indexOf("alt") === 0; }), ringLines: rings,
    labels: placed.map(function (pl) { return { id: pl.id, clear: pl.clear, dropped: !!pl.dropped }; }), draws: (window.__sky ? window.__sky.draws : 0) + 1 };
  if (p && !draw.marked && window.performance && performance.mark) { draw.marked = true; performance.mark("ephem:data"); __rum.mark("first-sky-draw"); }   // first frame with an answer (journey.ts, RUM)
}

// pan; Recenter appears once you've looked away and restores the default frame
function panned() { S.userPanned = true; $("recenter").hidden = false; requestDraw(); }
var drag = null;
cv.parentElement.addEventListener("pointerdown", function (e) { if (e.target.closest("button")) return; drag = { x: e.clientX, c: S.center, t0: performance.now(), moved: false }; });
addEventListener("pointermove", function (e) { if (!drag || S.center == null || S.pose) return; if (Math.abs(e.clientX - drag.x) < 3) return; S.center = (drag.c - (e.clientX - drag.x) / (W / 360) + 720) % 360; drag.moved = true; panned(); });
addEventListener("pointerup", function () { if (drag && drag.moved) __rum.interaction("drag", drag.t0, performance.now()); drag = null; });
addEventListener("pointercancel", function () { drag = null; });
cv.addEventListener("keydown", function (e) { if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && S.center != null) { S.center = (S.center + (e.key === "ArrowLeft" ? -10 : 10) + 360) % 360; panned(); e.preventDefault(); } });
$("recenter").addEventListener("click", function () { S.userPanned = false; if (S.to) S.center = defaultCenter(S.to); $("recenter").hidden = true; requestDraw(); });

// ---------- pointing ("Point phone"): only on a tap; iOS asks permission from that tap; silently absent without a compass ----------
var poseFrame = false, poseText = "";
function onOrient(e) {
  var ps = poseFrom(e, S.decl); if (!ps) return;
  S.pose = ps;
  if (!poseFrame) { poseFrame = true; requestAnimationFrame(function () { poseFrame = false; if (S.pose) { S.center = S.pose.az; draw(); aimUpdate(); } }); }
}
function aimUpdate() {
  if (!S.pose || !S.to) return;
  var t = [["Sun", S.to.sun], ["Moon", S.to.moon]].map(function (o) { return aimText(o[0], { az: o[1].azimuth, alt: altOf(o[1]) }, S.pose); }).join("\\n");
  if (t !== poseText) { poseText = t; $("guide").textContent = t; }
}
var orientEv = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
function pointStop() { removeEventListener(orientEv, onOrient); S.pose = null; $("guide").hidden = true; $("point").textContent = "Point phone"; $("point").setAttribute("aria-pressed", "false"); if (S.to && !S.userPanned) S.center = defaultCenter(S.to); requestDraw(); }
function pointStart() {
  addEventListener(orientEv, onOrient); $("point").textContent = "Stop"; $("point").setAttribute("aria-pressed", "true"); $("guide").hidden = false; $("guide").textContent = "Hold the phone upright and point it at the sky\\u2026";
  setTimeout(function () { if (!S.pose && $("point").getAttribute("aria-pressed") === "true") { pointStop(); $("point").hidden = true; } }, 3000);   // no compass: quietly gone
}
if (window.DeviceOrientationEvent && matchMedia("(pointer: coarse)").matches) $("point").hidden = false;
if (S.pose) $("guide").hidden = false;   // ?at&pose (debug): show the guidance as a phone would
$("point").addEventListener("click", function () {
  if ($("point").getAttribute("aria-pressed") === "true") { pointStop(); return; }
  var D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === "function") D.requestPermission().then(function (s) { if (s === "granted") pointStart(); else $("point").hidden = true; }, function () { $("point").hidden = true; });
  else pointStart();
});

// ---------- readouts ----------
function cardsHtml(p) {
  function state(b) {
    var a = altOf(b), rising = wrap360(b.azimuth) < 180;
    return (a >= 0 ? (rising ? "Rising" : "Setting") : (rising ? "Below the horizon" : "Set")) + ", " + dirWord(b.azimuth);
  }
  function cell(label, value, title) { return '<div><dt' + (title ? ' title="' + title + '"' : "") + '>' + label + '</dt><dd class="num">' + value + '</dd></div>'; }
  function nums(b, dist) {
    var m = azM(b.azimuth);
    return '<dl class="cells">' + cell("Azimuth", '<span>' + azT(b.azimuth) + '</span>' + (m ? '<span>' + m + '</span>' : "")) + cell("Altitude", d2(b.altitude)) +
      cell("Apparent alt.", b.apparentAltitude == null ? "below horizon" : d2(b.apparentAltitude), "Altitude with atmospheric refraction") + cell("Distance", dist) + '</dl>';
  }
  var s = p.sun, m = p.moon, ph = m.phase;
  return '<article class="card sunc"><header><h3>Sun</h3><span class="state">' + state(s) + '</span></header>' + nums(s, (s.distanceKm / AU).toFixed(5) + " au") + '</article>' +
    '<article class="card moonc"><header><h3>Moon</h3><span class="state">' + state(m) + '</span></header>' + nums(m, Math.round(m.distanceKm).toLocaleString("en-US") + " km") +
    '<p class="foot">' + ph.name.charAt(0).toUpperCase() + ph.name.slice(1) + ', <span class="tn">' + (ph.illuminatedFraction * 100).toFixed(1) + '%</span> lit</p></article>';
}
function setPos(p) {
  if (!S.to) __rum.mark("data-ready");
  // The chart redraws for a new answer only when it shows: the first one, a body crossing the horizon, a new frame, or a minute
  // since the last draw (a 5 s step moves a body well under a pixel). The cards and the sentence are DOM, updated when they change.
  var prev = S.to, c0 = S.center; S.to = p;
  if (S.center == null || (!S.userPanned && !S.pose)) S.center = defaultCenter(p);
  if (!prev || S.center !== c0 || (altOf(prev.sun) < 0) !== (altOf(p.sun) < 0) || (altOf(prev.moon) < 0) !== (altOf(p.moon) < 0) || tNow() - drawnAt >= 60e3) requestDraw();
  setHtml("bodies", cardsHtml(p)); setText("lede", lede(p.sun, p.moon)); aimUpdate();
  function ariaAlt(b) { return b.apparentAltitude == null ? "below the horizon (true altitude " + b.altitude.toFixed(2) + " degrees)" : b.apparentAltitude.toFixed(2) + " degrees apparent altitude"; }
  cv.setAttribute("aria-label", "Sun " + ariaAlt(p.sun) + ", azimuth " + p.sun.azimuth.toFixed(2) + " degrees true; Moon " + ariaAlt(p.moon) + ", azimuth " + p.moon.azimuth.toFixed(2) + " degrees true");
  diag();
}
var domMemo = {};
function setHtml(id, h) { if (domMemo[id] !== h) { domMemo[id] = h; $(id).innerHTML = h; } }
function setText(id, t) { if (domMemo[id] !== t) { domMemo[id] = t; $(id).textContent = t; } }

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
  var now = tNow();
  setText("clock", hm(now));
  var age = S.posAt ? (Date.now() - S.posAt) / 1000 : null, st = S.posErr ? "alert" : age == null ? "" : age < 15 ? "ok" : "caution";
  if (domMemo.live !== st) { domMemo.live = st; $("live").className = "live " + st; }
  setText("liveT", st === "alert" ? "No signal" : AT != null && st ? "Fixed time" : st === "ok" ? "Live" : st === "caution" ? "Delayed" : "Acquiring");
  if (S.to && now - drawnAt >= 60e3) requestDraw();   // the chart's paths and markers: once a minute
  var up = upcoming(now), html = lastNext;
  if (up.length) {
    var e = up[0], t = Date.parse(e.time);
    html = '<b>' + evName(e) + '</b> ' + (localDate(t) !== localDate(now) ? "tomorrow " : "") + 'at <span class="tn">' + hm(t) + '</span>, <span class="tn" style="white-space:nowrap">' + countdown(t - now) + '</span>';
  } else if (S.day && !S.day.loading && S.tomorrowFor === S.day.date) {
    if (S.tomorrow) html = "No rise, set or twilight in the next two days.";
  } else if (S.day && !S.day.loading) loadTomorrow();   // today has nothing left: only now is tomorrow's /v1/day needed
  if (html !== lastNext) { lastNext = html; $("next").innerHTML = html; }
  if (S.day && localDate(now) !== S.day.date) loadDay();
  if (S.trackDay != null && Math.floor(now / 864e5) !== S.trackDay) loadTrack();   // a new UTC day: the next track window
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
  S.track.forEach(function (p) { var f = (p.t - s) / span; if (f >= 0 && f <= 1) lg.appendChild(el("stop", { offset: f.toFixed(4), "stop-color": skyAt(altOf(p.sun))[1] })); });
  defs.appendChild(lg); svg.appendChild(defs);
  svg.appendChild(el("rect", { x: 0, y: y0, width: w, height: bh, rx: 2, fill: S.track.length ? "url(#dayg)" : "#111628" }));
  for (var hh = 0; hh <= 24; hh += w < 600 ? 6 : 3) { var x = Math.min(w, hh * 3600e3 / span * w); svg.appendChild(el("text", { x: x, y: y0 + bh + 20, "text-anchor": hh === 0 ? "start" : x >= w - 1 ? "end" : "middle", "font-size": 10.5 }, String(hh).padStart(2, "0") + ":00")); }
  S.day.events.forEach(function (e) {
    if (!(e.kind === "rise" || e.kind === "set" || e.kind === "transit")) return;
    var x = (Date.parse(e.time) - s) / span * w, col = e.body === "sun" ? "#ffc361" : "#d9e3ff", cls = e.body === "sun" ? "es" : "em";
    svg.appendChild(el("line", { x1: x, x2: x, y1: y0 - 6, y2: y0 + bh, stroke: col, "stroke-width": 1, "stroke-opacity": 0.9, class: cls }));
    svg.appendChild(el("circle", { cx: x, cy: y0 - 8, r: 2.5, fill: col, class: cls }));
  });
  stripSvg = { svg: svg, now: el("line", { y1: y0 - 3, y2: y0 + bh + 3, stroke: "#fff", "stroke-width": 2, class: "nowl" }), s: s, span: span, w: w };
  svg.appendChild(stripSvg.now); box.appendChild(svg); drawStripNow();
}
function drawStripNow() {   // only when the line moves a visible half pixel (24 h over a few hundred px: every few minutes)
  if (!stripSvg) return; var f = (tNow() - stripSvg.s) / stripSvg.span, x = Math.round(f * stripSvg.w * 2) / 2;
  if (stripSvg.x === x) return; stripSvg.x = x;
  stripSvg.now.setAttribute("x1", x); stripSvg.now.setAttribute("x2", x); stripSvg.now.style.display = f >= 0 && f <= 1 ? "" : "none";
}
var evMoreOpen = false;
function drawEvents() {
  var now = tNow();
  function row(e) { var t = Date.parse(e.time); return '<div class="' + (t < now ? "past" : "") + '"><span class="' + (e.body === "sun" ? "s" : "m") + '">' + evName(e) + '</span><span class="tn">' + hm(t) + "</span></div>"; }
  var main = S.day.events.filter(function (e) { return e.kind === "rise" || e.kind === "set" || e.kind === "transit"; }), more = S.day.events.filter(function (e) { return main.indexOf(e) < 0; });
  $("evs").innerHTML = (main.map(row).join("") || '<div>No rise or set today.</div>') +
    (more.length ? '<details class="more" id="evmore"' + (evMoreOpen ? " open" : "") + '><summary>Twilight, golden and blue hours</summary><div class="evs">' + more.map(row).join("") + '</div></details>' : "");
  if ($("evmore")) $("evmore").addEventListener("toggle", function (e) { evMoreOpen = e.target.open; });
  $("dayTitle").textContent = fmt({ weekday: "long", day: "numeric", month: "long" }).format(new Date(Date.parse(S.day.start) + 12 * 3600e3));
}

// ---------- loading ----------
function err(e) { S.err = e.message || String(e); var s = document.createElement("span"); s.className = "err"; s.textContent = "The API answered with an error: " + S.err; $("foot").replaceChildren(s); domMemo.foot = null; }
// The live answer: no time parameter, so the front door computes it (never forwarded, never cached; a timed URL would add an
// Api hop and a single-use immutable cache entry every 5 s).
function loadPos() {
  return api("/v1/position", AT == null ? q() : Object.assign(q(), { time: AT_ISO })).then(function (p) { S.posAt = Date.now(); S.posErr = null; setPos(p); })
    .catch(function (e) { S.posErr = e; err(e); });
}
function loadDay() {
  var today = localDate(tNow());
  S.day = { date: today, events: [], start: new Date(tNow()).toISOString(), end: new Date(tNow()).toISOString(), loading: true }; S.tomorrow = null; S.tomorrowFor = null;
  return api("/v1/day", Object.assign(q(), { date: today, tz: loc.tz }))
    .then(function (r) { S.day = r; drawEvents(); drawStrip(); tick(); }).catch(err);
}
// Tomorrow's events matter only once today's have all passed (the Next line); fetched then, once per day.
function loadTomorrow() {
  var d = S.day; S.tomorrowFor = d.date;
  return api("/v1/day", Object.assign(q(), { date: nextDate(d.date), tz: loc.tz }), true).then(function (b) { if (S.day === d) { S.tomorrow = b; tick(); } }).catch(function () {});
}
// Declination comes with the weather answer (observer.magneticDeclination, the same WMM2025 value); /v1/magnetic only if weather fails.
function setDecl(x) { S.decl = x; if (S.to) setHtml("bodies", cardsHtml(S.to)); diag(); }
function loadMag() {
  return api("/v1/magnetic", q(), true).then(function (b) { S.decl = b.magnetic.declination; if (S.to) setHtml("bodies", cardsHtml(S.to)); if (S.wx) drawWx(); diag(); })
    .catch(function () { S.decl = null; });
}
function loadWx() {
  return api("/v1/weather", Object.assign(q(), { n: 3 }), true).then(function (b) {
    S.wx = b; S.wxAt = Date.now(); if (S.decl !== b.observer.magneticDeclination) setDecl(b.observer.magneticDeclination); drawWx(); diag();
  }).catch(function (e) { $("wx").innerHTML = '<span class="err">Weather unavailable: ' + esc(e.message || e) + '</span>'; if (S.decl == null) loadMag(); });
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
  var cn = "age" + (oa > 4500 ? " warn" : ""), tx = "updated " + ago(oa); if (e.className !== cn) e.className = cn; if (e.textContent !== tx) e.textContent = tx;
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
    '<dl class="cells"><div><dt>Dew point</dt><dd class="num">' + num(s.dewpointC, 1, "\\u00b0C") + '</dd></div><div><dt>Visibility</dt><dd class="num">' + vis + '</dd></div>' +
    '<div><dt>Pressure</dt><dd class="num">' + (s.altimeterHpa != null ? num(s.altimeterHpa, 1, " hPa") : num(s.altimeterInHg, 2, " inHg")) + '</dd></div><div><dt>Clouds</dt><dd>' + clouds(s) + '</dd></div></dl>' +
    '<p class="station">' + esc(s.stationId) + ' \\u00b7 ' + s.distanceKm.toFixed(2) + ' km \\u00b7 bearing ' + azT(s.bearing.true) + ' \\u00b7 ' + s.bearing.magnetic.toFixed(2) + '\\u00b0 M<br><span class="age" id="wxage"></span></p>' +
    '<details class="raw" id="rawd"' + (S.rawOpen ? " open" : "") + '><summary>Raw METAR</summary><pre>' + raws + '</pre></details>';
  $("rawd").addEventListener("toggle", function (e) { S.rawOpen = e.target.open; });
  wxAges();
}
// One /v1/track answer, 20-minute UTC grid (217 samples), over [D - 24 h, D + 48 h] for D = this UTC midnight: that covers now +- 12 h
// (the paths) and the local day in any zone from UTC-12 to UTC+14 (the strip; a local day can start up to 24 h before D, e.g.
// New York at 23:30 EDT is already D), and the URL is the same for everyone here all UTC day, so it is one immutable, shared
// cache entry. Fetched at once, in parallel with the rest; again when the UTC date changes.
function loadTrack() {
  var D = Math.floor(tNow() / 864e5), t0 = (D - 1) * 864e5, iso = function (ms) { return new Date(ms).toISOString().slice(0, 19) + "Z"; };
  S.trackDay = D;
  return api("/v1/track", Object.assign(q(), { start: iso(t0), end: iso(t0 + 72 * 3600e3) }), true).then(function (r) {
    if (S.trackDay !== D) return;
    var out = [], step = r.stepSeconds * 1000, s0 = Date.parse(r.start);
    function b(x, i) { return { azimuth: x.azimuth[i], altitude: x.altitude[i], apparentAltitude: x.apparentAltitude[i] }; }
    for (var i = 0; i < r.count; i++) out.push({ t: s0 + i * step, sun: b(r.sun, i), moon: b(r.moon, i) });
    S.track = out; drawStrip(); requestDraw();
    if (window.performance && performance.mark) performance.mark("ephem:track");
  }).catch(err);
}
function pad(k) { return (k.toUpperCase() + "                    ").slice(0, 18); }
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
  setHtml("diag", out.join("\\n"));
  var prov = S.last && S.last.prov;
  // the telemetry bar: provenance stays on screen, the detail lives in Under the hood
  function tel(k, v) { return "<span><i>" + k + "</i>" + v + "</span>"; }
  var dg = prov && prov.diagnostics, c1 = dg && dg.cache;
  if (!S.err) setHtml("foot", tel("ephem", esc((prov && prov.version) || "")) + tel("Ephemeris", esc((prov && prov.ephemeris) || "JPL DE440")) +
    (S.last ? tel("Round trip", S.last.ms.toFixed(1) + " ms") : "") + (c1 ? tel("Block cache", esc(["L1 " + c1.l1].concat(Object.keys(c1).filter(function (k) { return k.indexOf("blocks_") === 0; }).map(function (k) { return k.slice(7) + " " + c1[k]; })).join(" \\u00b7 "))) : "") + tel("Edge", esc(LOC.colo || "\\u2014")) +
    tel("Location", loc.source === "cloudflare" ? "approximate, from Cloudflare" : loc.source === "device" ? "from your device" : loc.source === "query" ? "from the link" : "default"));
}
function header() {
  $("place").textContent = loc.city;
  $("place").classList.toggle("coords", /^[0-9.]+\u00b0 [NS], [0-9.]+\u00b0 [EW]$/.test(loc.city)); // a bare coordinate title: smaller, so it fits on one line at 390 px
  document.title = "ephem \\u00b7 the sky over " + loc.city;
  var b = location.origin;
  $("curl").textContent = "curl '" + b + "/v1/position?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "'\\n\\n" +
    "curl '" + b + "/v1/track?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&start=" + new Date((Math.floor(tNow() / 864e5) - 1) * 864e5).toISOString().slice(0, 19) + "Z&end=" + new Date((Math.floor(tNow() / 864e5) + 2) * 864e5).toISOString().slice(0, 19) + "Z'\\n\\n" +
    "curl '" + b + "/v1/day?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&date=" + localDate(tNow()) + "&tz=" + loc.tz + "'\\n\\n" +
    "curl '" + b + "/v1/weather?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&n=3'";
}
function reloadAll() { S.track = []; S.from = null; S.decl = null; header(); diag(); return Promise.all([loadTrack(), loadPos(), loadDay(), loadWx()]); }

$("locate").addEventListener("click", function () {
  if (!navigator.geolocation) { $("locnote").textContent = "This browser has no location API."; return; }
  $("locnote").textContent = "Asking your browser…";
  navigator.geolocation.getCurrentPosition(function (g) {
    loc = { lat: g.coords.latitude, lon: g.coords.longitude, place: "your location", city: "Your location", tz: loc.tz, source: "device", acc: g.coords.accuracy };
    $("locnote").textContent = ""; history.replaceState(null, "", "?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&tz=" + encodeURIComponent(loc.tz)); reloadAll();
  }, function (e) { $("locnote").textContent = e.code === 1 ? "Location permission denied; using Cloudflare's estimate." : "Couldn't get a location fix."; }, { enableHighAccuracy: true, timeout: 10000 });
});
if (location.search) $("inst").href = "/instrument" + location.search;
$("share").addEventListener("click", function () {
  var u = location.origin + "/?lat=" + loc.lat.toFixed(4) + "&lon=" + loc.lon.toFixed(4) + "&tz=" + encodeURIComponent(loc.tz) + (loc.source === "device" ? "" : "&place=" + encodeURIComponent(loc.city));
  (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { $("locnote").textContent = "Link copied."; }, function () { $("locnote").textContent = u; });
});
$("hood").addEventListener("toggle", diag);

var rsT = 0; addEventListener("resize", function () { resize(); clearTimeout(rsT); rsT = setTimeout(drawStrip, 150); });
document.addEventListener("visibilitychange", function () { if (!document.hidden) loadPos(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(requestDraw);
resize(); header();
reloadAll();
if (AT == null) setInterval(function () { if (!document.hidden) loadPos(); }, 5000);
setInterval(tick, 1000); tick();
setInterval(function () { if (!document.hidden) loadWx(); }, 60e3);
})();
</script>
</body></html>`
