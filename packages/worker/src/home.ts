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
import { DIN_CSS, DIN_LICENSE } from "./din.ts"
import { READ_EMBED_JS, jsonScript, routeText, streamHtml } from "./embed.ts"
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

/** The queries the page's first load makes, built exactly as the client builds them (q(), loadTrack, loadDay), so an embedded
 *  answer is the one the browser would have fetched: lat/lon at 5 decimals, the track window from this UTC day, today in tz. */
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z"
export const initialQueries = (v: Visitor, now: number) => {
  const q = { lat: v.lat.toFixed(5), lon: v.lon.toFixed(5) }, D = Math.floor(now / 864e5), t0 = (D - 1) * 864e5
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: v.tz }).format(new Date(now))
  return {
    "ephem-position": ["/v1/position", q],
    "ephem-track": ["/v1/track", { ...q, start: iso(t0), end: iso(t0 + 72 * 3600e3) }],
    "ephem-day": ["/v1/day", { ...q, date: today, tz: v.tz }],
  } as const satisfies Record<string, readonly [string, Record<string, string>]>
}

/** An answer slower than this is left out and the page fetches it (a cold Api isolate's /v1/day or /v1/track MISS is ~200–350 ms). */
const EMBED_TIMEOUT_MS = 1500
// GET /: the head (CSS, markup, boot script) is flushed at once; the three first-load answers follow, computed in-process
// through the router (src/embed.ts), then </body>. An answer that is not a 200 is left out and the page fetches it.
export const Home = HttpRouter.use(router => Effect.gen(function* () {
  // the licence of the page's inline font (src/din.ts), as the OFL asks
  yield* router.add("GET", "/licenses/din.txt", HttpServerResponse.text(DIN_LICENSE, { headers: { "cache-control": "public, max-age=86400" } }))
  yield* router.add("GET", "/", req => Effect.gen(function* () {
  const tid = yield* documentTrace(req)   // on the root span; the page's fetches are its children (src/clienttrace.ts)
  return yield* Effect.gen(function* () {
    const url = Option.getOrElse(HttpServerRequest.toURL(req), () => new URL("http://localhost/"))
    const v = visitor(url, (req.source as { cf?: CfLocation }).cf)
    yield* Effect.annotateCurrentSpan({ "home.source": v.source, "home.colo": v.colo ?? "", "home.tz": v.tz })
    const embeds = Effect.forEach(Object.entries(initialQueries(v, Date.now())), ([id, [path, query]]) =>
      routeText(router, req, path, query, tid.traceparent).pipe(Effect.timeoutOption(EMBED_TIMEOUT_MS),
        Effect.map(o => (o._tag === "Some" && o.value.status === 200 ? jsonScript(id, o.value.text) : ""))), { concurrency: "unbounded" })
    const tail = embeds.pipe(
      Effect.tap(parts => Effect.annotateCurrentSpan({ "home.embedded": parts.filter(Boolean).length })),
      Effect.withSpan("home.embed"),
      Effect.map(parts => parts.join("") + PAGE_END),
      Effect.catchCause(() => Effect.succeed(PAGE_END)))   // never fails: the page fetches what is missing
    return yield* streamHtml(pageHead(v, tid), tail, { "cache-control": "private, no-store", ...documentTraceHeaders(tid) })
  }).pipe(Effect.withSpan("home"))
  }))
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
// Altitude to chart units, smooth everywhere: linear above the horizon (y = alt), and below it a tanh compression with the same
// slope at 0° (s·tanh(alt/s): C2 at the horizon, no kink anywhere), so a track keeps its true sinusoid-like shape. s = 36: -18°
// maps to -16.6, -90° to -35.5 (the ground holds the whole depth). (Before 2026-10-31 it was piecewise linear, true to -18° and
// a quarter below: every track kinked at the break; Ivar: "that path… what!?")
var DEPTH_S = 36;
// The chart draws TRUE (geometric) altitude, for tracks and markers alike: the API's apparent altitude stops at the horizon
// (null below), so apparent-above / true-below would jump ~0.57° there, and any refraction taper below the horizon wiggles
// the curve. True altitude is smooth; refraction is at most 0.57° (about 1.5 px here). Every number on the page is the API's.
function chartAlt(h) { return h; }
function altU(a) { a = Math.max(-90, Math.min(90, a)); return a >= 0 ? a : DEPTH_S * Math.tanh(a / DEPTH_S); }
var U_TOP = 90, U_BOT = altU(-90);
// A continuous azimuth sequence (no 360° jumps), so a track crosses the chart's seam as one line.
function unwrapAz(azs) { var out = [], prev = null; for (var i = 0; i < azs.length; i++) { var a = prev == null ? azs[i] : prev + wrap180(azs[i] - prev); out.push(a); prev = a; } return out; }
// The default frame shows all 360°, centred between the two bodies (the middle of the shorter arc from one to the other, to
// the degree), so both sit well inside the frame and the seam (centre ± 180°) falls where neither is. lat is unused now.
function chartCenter(lat, azs) {
  if (azs.length < 2) return wrap360(Math.round(azs[0] == null ? (lat >= 0 ? 180 : 0) : azs[0]));
  return wrap360(Math.round(azs[0] + wrap180(azs[1] - azs[0]) / 2));
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
// ---- the chart model and its label layout: pure (no canvas), so test/home.test.ts runs them over every sky state ----
var CH_TOP = 14, CH_AXIS = 20;
function chartGeom(W, H, insetL, insetR) {
  var ky = (H - CH_TOP - CH_AXIS) / (U_TOP - U_BOT);
  return { W: W, H: H, kx: W / 360, ky: ky, top: CH_TOP, hy: Math.round(CH_TOP + U_TOP * ky) + 0.5, bot: H - CH_AXIS, x0: 4 + (insetL || 0), x1: W - 4 - (insetR || 0) };
}
function chX(az, g, c) { return g.W / 2 + wrap180(az - c) * g.kx; }
function chY(alt, g) { return g.top + (U_TOP - altU(alt)) * g.ky; }
function chXs(az, g, c) { var x = chX(az, g, c), r = [x], s = 360 * g.kx; if (x - s >= -40) r.push(x - s); if (x + s <= g.W + 40) r.push(x + s); return r; }
// Candidate spots for a label around an anchor, nearest first: above, beside, below, then the diagonals, at growing distances.
function spotsAround(it) {
  var out = [], w = it.w, h = it.h;
  (it.body ? [1, 1.7, 2.6, 3.8, 5.4, 7.5, 10] : [1, 1.7, 2.6, 3.8]).forEach(function (m) {   // an event label stays by its marker, or goes
    var d = (it.r || 0) + 5 * m, e = d * 0.72;
    out.push([it.x - w / 2, it.y - d - h], [it.x + d, it.y - h / 2], [it.x - d - w, it.y - h / 2], [it.x - w / 2, it.y + d],
      [it.x + e, it.y - e - h], [it.x - e - w, it.y - e - h], [it.x + e, it.y + e], [it.x - e - w, it.y + e]);
    if (it.body) out.push([it.x + d, it.y - 2], [it.x - d - w, it.y - 2], [it.x + d, it.y - h + 2], [it.x - d - w, it.y - h + 2]);   // beside, top- or bottom-aligned (a body near the horizon ticks)
  });
  return out;
}
// A body's name: many more candidates, nearest first (beside, above, below, out to ~90 px), so a clear spot is found before any
// fallback.
function bodySpots(it) {
  var out = spotsAround(it), R = it.r || 0;
  for (var dy = -60; dy <= 60; dy += 4) for (var dx = 0; dx <= 90; dx += 6) {
    out.push([it.x + R + 4 + dx, it.y - it.h / 2 + dy], [it.x - R - 4 - dx - it.w, it.y - it.h / 2 + dy]);
    if (dx <= 40) out.push([it.x - it.w / 2 + (dy % 8 ? dx : -dx), it.y - R - 4 - it.h - Math.abs(dy)], [it.x - it.w / 2 + (dy % 8 ? dx : -dx), it.y + R + 4 + Math.abs(dy)]);
  }
  return out.map(function (s) { return [s, Math.hypot(s[0] + it.w / 2 - it.x, s[1] + it.h / 2 - it.y)]; }).sort(function (a, b) { return a[1] - b[1]; }).map(function (x) { return x[0]; });
}
// Spots along a horizontal line y (a ring or a band edge): from the left and right edges inward, above the line, then below.
function spotsAlong(y, w, h, b, below) {
  var xs = [], step = 22, mid = (b.x0 + b.x1) / 2;
  for (var k = 0; ; k++) {
    var l = b.x0 + 2 + k * step, r = b.x1 - 2 - w - k * step, any = false;
    if (l + w <= mid + step) { xs.push(l); any = true; } if (r >= mid - step) { xs.push(r); any = true; } if (!any) break;
  }
  var out = []; (below ? [1] : [0, 1]).forEach(function (side) { xs.forEach(function (x) { out.push([x, side ? y + 3 : y - h - 3]); }); });
  return out;
}
function segBox(s) { return { x: Math.min(s[0], s[2]), y: Math.min(s[1], s[3]), w: Math.abs(s[2] - s[0]), h: Math.abs(s[3] - s[1]) }; }
// Every label goes through one layout, highest priority first. A label takes the first candidate spot (nearest first) inside the
// bounds that touches, with pad px to spare, no hard rect (discs, markers, the horizon band, buttons), no label already placed,
// and no path segment. A body's own label (and the scale-break note, must: true), when every spot is crossed by a path, takes the
// nearest spot clear of everything else (crossed: true). Anything else without a clear spot is dropped: a label never lands on a higher-priority one.
// items: {id, w, h, prio, x, y, r?, spots?, body?}. Returns [{id, x, y, w, h, dropped?, crossed?}] in priority order.
function layoutLabels(items, hard, segs, bounds, pad) {
  pad = pad == null ? 2 : pad;
  var placed = [], out = [], sb = segs.map(segBox);
  function clearOf(r, list) { for (var j = 0; j < list.length; j++) if (overlapArea(r, list[j]) > 0) return false; return true; }
  function crossed(r) { for (var j = 0; j < segs.length; j++) if (overlapArea(r, { x: sb[j].x - 0.5, y: sb[j].y - 0.5, w: sb[j].w + 1, h: sb[j].h + 1 }) > 0 && segHitsRect(segs[j], r)) return true; return false; }
  items.map(function (it, i) { return { it: it, i: i }; }).sort(function (a, b) { return a.it.prio - b.it.prio || a.i - b.i; }).forEach(function (o) {
    var it = o.it, spots = it.spots || (it.body ? bodySpots(it) : spotsAround(it)), best = null, fall = null;
    for (var k = 0; k < spots.length; k++) {
      var x = spots[k][0], y = spots[k][1];
      if (x < bounds.x0 || y < bounds.y0 || x + it.w > bounds.x1 || y + it.h > bounds.y1) continue;
      var pd = it.pad == null ? pad : it.pad, r = { x: x, y: y, w: it.w, h: it.h }, gr = { x: x - pd, y: y - pd, w: it.w + 2 * pd, h: it.h + 2 * pd };
      if (!clearOf(gr, hard) || !clearOf(gr, placed)) continue;
      if (!crossed({ x: x - 3, y: y - 3, w: it.w + 6, h: it.h + 6 })) { best = r; break; }
      if ((it.body || it.must) && !fall) fall = r;
    }
    var r2 = best || fall;
    if (!r2 && it.body) {   // a body is always named: the spot in bounds clear of the other labels that covers the least
      var least = Infinity;
      for (k = 0; k < spots.length; k++) {
        var q = { x: spots[k][0], y: spots[k][1], w: it.w, h: it.h }, cover = 0;
        if (q.x < bounds.x0 || q.y < bounds.y0 || q.x + q.w > bounds.x1 || q.y + q.h > bounds.y1 || !clearOf(q, placed)) continue;
        for (var j = 0; j < hard.length; j++) cover += overlapArea(q, hard[j]);
        if (cover < least) { least = cover; r2 = q; fall = q; }
      }
    }
    if (!r2) { out.push({ id: it.id, dropped: true, prio: it.prio }); return; }
    r2.id = it.id; r2.prio = it.prio; if (!best) r2.crossed = true;
    placed.push(r2); out.push(r2);
  });
  return out;
}
// A smooth curve through the 20-minute samples: centripetal Catmull-Rom (alpha 0.5: no cusps, no overshoot loops), as the
// cubic Bezier control points of the piece from sample i to i + 1 (the ends reuse their neighbours).
function crBezier(xs, ys, i) {
  var n = xs.length, i0 = Math.max(0, i - 1), i3 = Math.min(n - 1, i + 2);
  var p0 = [xs[i0], ys[i0]], p1 = [xs[i], ys[i]], p2 = [xs[i + 1], ys[i + 1]], p3 = [xs[i3], ys[i3]];
  function dist(a, b) { return Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5); }
  var d1 = dist(p0, p1), d2 = dist(p1, p2), d3 = dist(p2, p3), b1 = p1.slice(), b2 = p2.slice();
  if (d1 > 1e-6 && d2 > 1e-6) for (var k = 0; k < 2; k++) b1[k] = (d1 * d1 * p2[k] - d2 * d2 * p0[k] + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1[k]) / (3 * d1 * (d1 + d2));
  if (d3 > 1e-6 && d2 > 1e-6) for (k = 0; k < 2; k++) b2[k] = (d3 * d3 * p1[k] - d2 * d2 * p3[k] + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2[k]) / (3 * d3 * (d3 + d2));
  return [b1[0], b1[1], b2[0], b2[1]];
}
// One revolution of a body's track around now, ending on the frame's seam (centre ± 180°), so both ends sit at the frame's
// edges and never mid-sky. pts: [{t, az, alt}] in time order with now at nowIdx; period: the body's day (ms). The azimuth is
// unwrapped outward from now, relative to the centre; walking back and forward, the first sample past ±180° is cut there
// (interpolated onto the edge). A body whose azimuth does not go all the way round (|dec| > |lat|, same side) gets one period
// centred on now instead. Returns [{t, rel, alt, edge?}], rel in [-180, 180]; one polyline, now included.
function trackSpan(pts, nowIdx, center, period) {
  var n = pts.length, rel = new Array(n), t0 = pts[nowIdx].t;
  rel[nowIdx] = wrap180(pts[nowIdx].az - center);
  for (var i = nowIdx + 1; i < n; i++) rel[i] = rel[i - 1] + wrap180(pts[i].az - pts[i - 1].az);
  for (i = nowIdx - 1; i >= 0; i--) rel[i] = rel[i + 1] + wrap180(pts[i].az - pts[i + 1].az);
  var j;
  function walk(dir, limit) {
    var res = [];
    for (var j = nowIdx + dir; j >= 0 && j < n; j += dir) {
      var pj = j - dir, r = rel[j];
      if (Math.abs(r) >= 180) {
        var e = r > 0 ? 180 : -180, f = (e - rel[pj]) / (r - rel[pj]);
        res.push({ t: pts[pj].t + f * (pts[j].t - pts[pj].t), rel: e, alt: pts[pj].alt + f * (pts[j].alt - pts[pj].alt), edge: true });
        return res;
      }
      if (Math.abs(pts[j].t - t0) > limit) return res;
      res.push({ t: pts[j].t, rel: r, alt: pts[j].alt });
    }
    return res;
  }
  var back = walk(-1, period * 1.05), fwd = walk(1, period * 1.05);
  var round = back.length && back[back.length - 1].edge && fwd.length && fwd[fwd.length - 1].edge;
  if (round) return back.reverse().concat([{ t: t0, rel: rel[nowIdx], alt: pts[nowIdx].alt }], fwd);
  // Not all the way round: the loop closes on itself. Cut it at its lowest point (lower culmination, deep in the compressed
  // ground), from the last one before now to the next, so the day's declination drift shows only there.
  var lo = -1, hi = -1;
  for (j = 0; j < n; j++) { var dt = pts[j].t - t0;
    if (dt <= 0 && dt > -period && (lo < 0 || pts[j].alt < pts[lo].alt)) lo = j;
    if (dt >= 0 && dt < period && (hi < 0 || pts[j].alt < pts[hi].alt)) hi = j; }
  var out = [];
  for (j = Math.max(0, lo); j <= (hi < 0 ? n - 1 : hi); j++) out.push({ t: pts[j].t, rel: rel[j], alt: pts[j].alt });
  return out;
}
// A pass within ~10° of the zenith swings the azimuth through ~180° in minutes: in an azimuth × altitude chart the track
// climbs a vertical side, runs flat along the top and drops down the other: a box. Above 80° the azimuth means little, so
// that stretch is drawn as a half-ellipse from where the track crosses 80° on the way up to where it does on the way down,
// its top at the pass's highest altitude: it reads as what it is, a pass overhead. The vertices are rewritten in place;
// returns the point for "now" if now falls inside the arc (the body's marker goes there), else null.
function zenithArc(sp, xs, ys, g, now) {
  var hit = null;
  for (var i = 0; i < sp.length; i++) {
    if (sp[i].alt <= 80) continue;
    var a = i, z = i; while (z + 1 < sp.length && sp[z + 1].alt > 80) z++;
    i = z;
    if (a === 0 || z === sp.length - 1 || Math.abs(sp[z].rel - sp[a].rel) < 30) continue;   // not a swing (or cut by the frame)
    var p = a - 1, q = z + 1, top = Math.max.apply(null, sp.slice(a, z + 1).map(function (s) { return s.alt; }));
    var x0 = xs[p], x1 = xs[q], yb = (ys[p] + ys[q]) / 2, yt = chY(top, g), t0 = sp[p].t, t1 = sp[q].t;
    var at = function (t) { var u = (t - t0) / (t1 - t0), th = Math.PI * u; return [(x0 + x1) / 2 - (x1 - x0) / 2 * Math.cos(th), yb - (yb - yt) * Math.sin(th)]; };
    for (var j = a; j <= z; j++) { var pt = at(sp[j].t); xs[j] = pt[0]; ys[j] = pt[1]; }
    if (now >= t0 && now <= t1) hit = at(now);
  }
  return hit;
}
// The chart as geometry: st {W, H, insetL, insetR, center, now, ctl (rect|null), pose ({az, alt}|null), meas (text → px),
// lh (label line height), bodies: [{key, name, az, alt, r, pts, nowIdx, period}]}. Tracks (screen polylines split at now),
// discs, and one label per body (its name), laid out clear of every track, disc and button (layoutLabels).
function skyModel(st) {
  var g = chartGeom(st.W, st.H, st.insetL, st.insetR), c = st.center, m = { g: g, lines: {}, discs: [], hard: [], segs: [], items: [] };
  if (st.ctl) m.hard.push(st.ctl);
  if (st.pose) { var px = chX(st.pose.az, g, c), py = chY(st.pose.alt, g); m.pose = { x: px, y: py }; m.hard.push({ id: "pose", x: px - 16, y: py - 16, w: 32, h: 32 }); }
  m.hard.push({ id: "horizon", x: -1e4, y: g.hy - 1, w: 2e4, h: 2 });
  st.bodies.forEach(function (b) {
    if (b.pts && b.pts.length > 1) {
      var sp = trackSpan(b.pts, b.nowIdx, c, b.period), xs = [], ys = [], split = 0;
      sp.forEach(function (q, i) { xs.push(g.W / 2 + q.rel * g.kx); ys.push(chY(q.alt, g)); if (q.t <= st.now) split = i; });
      var arc = zenithArc(sp, xs, ys, g, st.now);
      if (arc) b = Object.assign({}, b, { arcXY: arc });
      m.lines[b.key] = { xs: xs, ys: ys, split: split };
      for (var i = 1; i < xs.length; i++) m.segs.push([xs[i - 1], ys[i - 1], xs[i], ys[i]]);
    }
    var bx = b.arcXY ? b.arcXY[0] : chX(b.az, g, c), by = b.arcXY ? b.arcXY[1] : chY(b.alt, g), rr = b.r + 4;
    m.discs.push({ key: b.key, x: bx, y: by, r: b.r, below: b.alt < 0 });
    m.hard.push({ id: b.key + "-disc", x: bx - rr, y: by - rr, w: 2 * rr, h: 2 * rr });
    m.items.push({ id: b.name, t: b.name, w: st.meas(b.name), h: st.lh, x: bx, y: by, r: rr - 2, prio: 0, body: true });
  });
  m.bounds = { x0: g.x0, y0: 2, x1: g.x1, y1: g.bot - 1 };
  return m;
}
function compass16(az) { return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(wrap360(az) / 22.5) % 16]; }
// The day's timeline as geometry (pure; test/home.test.ts runs it). Twilight is shading on the line (from the Sun's altitude
// samples: day, civil, nautical, astronomical, night); nodes for sunrise, solar noon, sunset, moonrise and moonset, plus the
// NEXT event (highlighted) if it is something else; each name with its time under it, one row of labels above the line and
// one below, alternating; a label with no room in either row is left out (its node stays). A leader runs only across the gap
// between the line and its own label, inside that label's span, so it never crosses other text.
// evs [{body, kind, t}], sun [{t, alt}] (the day's samples), s0/span the local day, w px, next {body, kind, t}|null,
// name(e) → caps name, time(t) → "HH:MM", meas(text, "name"|"time") → px.
var TL_NODE = { sun: { rise: 1, transit: 1, set: 1 }, moon: { rise: 1, set: 1 } };
function timelineLayout(evs, sun, s0, span, w, now, next, name, time, meas) {
  var pad = 10, mid = 46, gap = 9, lh = 13, X = function (t) { return pad + Math.max(0, Math.min(1, (t - s0) / span)) * (w - 2 * pad); };
  var out = { mid: mid, h: mid + gap + 2 * lh + 4, segs: [], nodes: [], labels: [], leaders: [] };
  function phase(a) { return a >= -0.833 ? "day" : a >= -6 ? "civil" : a >= -12 ? "nautical" : a >= -18 ? "astro" : "night"; }
  for (var i = 1; i < sun.length; i++) {
    var k = phase((sun[i - 1].alt + sun[i].alt) / 2), x0 = X(sun[i - 1].t), x1 = X(sun[i].t), last = out.segs[out.segs.length - 1];
    if (x1 <= x0) continue;
    if (last && last.kind === k && Math.abs(last.x1 - x0) < 0.01) last.x1 = x1; else out.segs.push({ x0: x0, x1: x1, kind: k });
  }
  var isNext = function (e) { return next && next.body === e.body && next.kind === e.kind && Math.abs(next.t - e.t) < 60e3; };
  var pick = evs.filter(function (e) { return (TL_NODE[e.body] && TL_NODE[e.body][e.kind]) || isNext(e); }).sort(function (a, b) { return a.t - b.t; });
  var rows = [[], []], side = 0;
  pick.forEach(function (e) {
    var x = X(e.t), nm = name(e), tm = time(e.t), bw = Math.max(meas(nm, "name"), meas(tm, "time")), placed = null;
    out.nodes.push({ x: x, body: e.body, kind: e.kind, past: e.t <= now, next: !!isNext(e) });
    for (var tries = 0; tries < 2 && !placed; tries++) {
      var r = (side + tries) % 2, bx = Math.max(0, Math.min(w - bw, x - bw / 2)), y = r === 0 ? mid - gap - 2 * lh : mid + gap;
      var box = { x: bx, y: y, w: bw, h: 2 * lh };
      if (rows[r].some(function (o) { return box.x < o.x + o.w + 8 && o.x < box.x + box.w + 8; })) continue;
      rows[r].push(box); placed = box; side = 1 - r;
      out.labels.push({ x: bx, y: y, w: bw, h: 2 * lh, name: nm, time: tm, cx: x, past: e.t <= now, next: !!isNext(e), body: e.body });
      if (x >= bx + 2 && x <= bx + bw - 2) out.leaders.push(r === 0 ? [x, mid - 5, x, y + 2 * lh + 1] : [x, mid + 5, x, y - 1]);
    }
  });
  return out;
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
// The compact form, one line per body: "SUN ← 157° · ↓ 22°" (arrows: which way to turn and tilt; "on target" within 3°).
function aimShort(name, b, pose) {
  var d = wrap180(b.az - pose.az), e = b.alt - pose.alt, parts = [];
  if (Math.abs(d) >= 3) parts.push((d < 0 ? "\u2190 " : "\u2192 ") + Math.round(Math.abs(d)) + "\u00b0");
  if (Math.abs(e) >= 3) parts.push((e < 0 ? "\u2193" : "\u2191") + Math.round(Math.abs(e)) + "\u00b0");
  return name + " " + (parts.length ? parts.join(" ") : "on target");
}
function aimText(name, b, pose) {
  var d = wrap180(b.az - pose.az), e = b.alt - pose.alt, parts = [];
  if (Math.abs(d) >= 3) parts.push("turn " + Math.round(Math.abs(d)) + "\\u00b0 " + (d < 0 ? "left" : "right"));
  if (Math.abs(e) >= 3) parts.push("tilt " + Math.round(Math.abs(e)) + "\\u00b0 " + (e < 0 ? "down" : "up"));
  return name + (b.alt < 0 ? ", " + Math.abs(b.alt).toFixed(1) + "\\u00b0 below the horizon" : "") + ": " + (parts.length ? parts.join(", ") : "dead ahead");
}
`

/** The whole page without embedded data (tests; the client then fetches everything). */
export const page = (v: Visitor, trace?: DocumentTrace) => pageHead(v, trace) + PAGE_END

/** Everything the browser can parse, style, paint and boot before the data: flushed at once (src/embed.ts streamHtml). */
export const pageHead = (v: Visitor, trace?: DocumentTrace) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
${FONT_STYLE}
${traceparentMeta(trace)}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ephem · the sky over ${v.city.replace(/[<>&"]/g, "")}</title>
<meta name="description" content="Where the Sun and the Moon are right now, from JPL DE440, computed on Cloudflare's edge.">
<meta name="theme-color" content="#07090c"><meta name="color-scheme" content="dark">
${ICON_LINK}
<style>
/* Mission control (ivar 2026-10-31: "More SpaceX control center style"): white on near-black; DIN for labels and values
   (labels small caps letter-spaced, values large with tabular figures); one accent (cyan) only for LIVE and NOW; amber Sun,
   silver Moon; nothing else. Calm: the chart shows where things are, the countdown what is next, the readouts the numbers. */
:root{--bg:#060708;--ink:#f2f4f7;--muted:#8d939c;--faint:#555b64;--line:rgba(242,244,247,.09);--accent:#6fd8f2;--sun:#f5b860;--moon:#c9d1de;
--caution:#e8a64a;--alert:#ef6a5e;--maxw:1080px;
--din:"Ephem DIN","DIN Alternate","DIN 2014","Bahnschrift",-apple-system,system-ui,sans-serif;
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",Roboto,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:400 15px/1.5 var(--sans);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--faint);text-underline-offset:3px}
.tn{font-family:var(--din);font-variant-numeric:tabular-nums}
.cap{font:500 11px/1.3 var(--din);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.gut{padding-left:max(16px,env(safe-area-inset-left),calc((100% - var(--maxw)) / 2));padding-right:max(16px,env(safe-area-inset-right),calc((100% - var(--maxw)) / 2))}
/* header: one row */
.hd{display:flex;align-items:center;gap:12px;padding-top:max(12px,env(safe-area-inset-top));padding-bottom:12px}
.brand{font:700 13px/1 var(--din);letter-spacing:.3em;color:var(--ink)}
h1{margin:0;font:500 12px/1.2 var(--din);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.clock{font:400 16px/1 var(--din);font-variant-numeric:tabular-nums;letter-spacing:.04em;color:var(--ink);white-space:nowrap}
.dot{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none}
.dot.ok{background:var(--accent);box-shadow:0 0 6px var(--accent)}.dot.caution{background:var(--caution)}.dot.alert{background:var(--alert)}
/* the sky */
.sky{position:relative;height:clamp(250px,40svh,540px);touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none;background:#090b10;
padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)}
.sky:active{cursor:grabbing}
.sky canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.ctl{position:absolute;top:0;right:env(safe-area-inset-right);z-index:2;display:flex}
.ctl button{width:44px;height:44px;display:grid;place-items:center;color:rgba(242,244,247,.55);background:transparent;border:0;padding:0;cursor:pointer;font:500 11px/1 var(--din);letter-spacing:.14em;text-transform:uppercase}
.ctl button[hidden]{display:none}
.ctl button:hover,.ctl button[aria-pressed=true]{color:var(--accent)}
.ctl #recenter{width:auto;padding:0 12px}
/* countdown hero */
.cdh{text-align:center;padding-top:18px;padding-bottom:6px}
.cdh .t{font:400 44px/1 var(--din);font-variant-numeric:tabular-nums;letter-spacing:.02em;white-space:nowrap}
.cdh .ev{margin-top:8px;font:700 12px/1.3 var(--din);letter-spacing:.2em;color:var(--ink)}
.cdh .ph{margin-top:4px}
.guide{margin:8px 0 0;text-align:center;font:500 12px/1.4 var(--din);letter-spacing:.1em;text-transform:uppercase;color:var(--accent)}
/* timeline */
.tl{padding-top:14px;padding-bottom:6px}
.tl svg{display:block;width:100%;height:auto;overflow:visible}
.tl text{font-family:var(--din);fill:var(--muted)}
/* telemetry */
.tel{display:grid;grid-template-columns:minmax(0,1fr);gap:18px 32px;padding-top:18px;padding-bottom:14px;border-top:1px solid var(--line);margin-top:12px}
.bd{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px 16px}
.ro .v{font:400 34px/1.05 var(--din);font-variant-numeric:tabular-nums;letter-spacing:.01em;white-space:nowrap}
.ro .u{font:500 13px/1 var(--din);letter-spacing:.08em;color:var(--muted);margin-left:3px}
.ro .cap i{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:7px;vertical-align:1px}
.ro .cap i.s{background:var(--sun)}.ro .cap i.m{background:var(--moon)}
.bd .sec{grid-column:1/-1;margin-top:2px;color:var(--faint)}
.bd .sec b{font-weight:500;color:var(--muted)}
/* disclosures: a chevron, closed by default */
details.disc{border-top:1px solid var(--line)}
details.disc>summary{cursor:pointer;list-style:none;min-height:44px;display:flex;align-items:center;gap:10px;font:500 11px/1.3 var(--din);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
details.disc>summary::-webkit-details-marker{display:none}
details.disc>summary::before{content:"";width:6px;height:6px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(-45deg);transition:transform .15s;margin:0 2px}
details.disc[open]>summary::before{transform:rotate(45deg)}
details.disc>div,details.disc>pre,details.disc>dl{margin:0 0 14px}
.kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 16px}
.kv dt{font:500 11px/1.5 var(--din);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.kv dd{margin:0;font:400 15px/1.3 var(--din);text-transform:uppercase;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
main{padding-bottom:40px}
.blk{padding:18px 0 4px;border-top:1px solid var(--line)}
.blk>h2{margin:0 0 12px}
.evs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0 40px;font-size:13px}
.evs>div{display:flex;justify-content:space-between;gap:12px;padding:5px 0}
.evs .tn{font-size:15px}
.evs .past,.evs .past .tn{color:var(--faint)}
.evs .s::before,.evs .m::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:10px;vertical-align:1px}
.evs .s::before{background:var(--sun)}.evs .m::before{background:var(--moon)}
.row{display:flex;flex-wrap:wrap;gap:20px;margin:6px 0 14px;align-items:center}
.btn{min-height:44px;display:inline-flex;align-items:center;font:500 11px/1 var(--din);letter-spacing:.14em;text-transform:uppercase;color:var(--ink);background:transparent;border:0;padding:0;cursor:pointer}
.btn:hover{color:var(--accent)}
.note{font-size:13px;color:var(--muted)}
.wx{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 24px;align-items:end;margin-bottom:12px}
.wx .temp .v{font:400 44px/1 var(--din);font-variant-numeric:tabular-nums}
.wx .cond{font:500 12px/1.3 var(--din);letter-spacing:.14em;text-transform:uppercase;color:var(--ink);padding-bottom:6px}
.wxg{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px;margin-bottom:10px}
.wxg .v{font:400 18px/1.2 var(--din);font-variant-numeric:tabular-nums;white-space:nowrap}
.wxg .v .u{font-size:11px;letter-spacing:.08em;color:var(--muted);margin-left:2px}
.station{margin:0 0 4px;font:500 11px/1.6 var(--din);letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
.age{color:var(--muted)}.age.warn{color:var(--caution)}
pre{margin:0;font:12px/1.65 var(--mono);color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
pre .c{color:var(--faint)}
.hood .in{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
.hood h3{margin:0 0 8px}
.hood p{color:var(--muted);font-size:13px;margin:0 0 10px}
footer.tel2{border-top:1px solid var(--line);padding-top:14px;padding-bottom:max(14px,env(safe-area-inset-bottom));display:flex;flex-wrap:wrap;gap:6px 24px;font:500 11px/1.5 var(--din);letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
footer.tel2 i{font-style:normal;color:var(--faint);margin-right:8px}
:focus-visible{outline:1px solid var(--accent);outline-offset:3px}
.err{color:var(--alert)}
@media (max-width:760px){.hood .in{grid-template-columns:minmax(0,1fr)}.wxg{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
@media (min-width:760px){.tel{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
</style>
</head><body>
<header class="hd gut" id="top">
  <span class="brand">EPHEM</span><h1 id="place"></h1><span class="clock" id="clock" aria-label="Local time">--:--:--</span><i class="dot" id="live" role="status"></i><span class="vh" id="liveT">Acquiring</span>
</header>
<section class="sky" id="sky" aria-label="Where the Sun and the Moon are: the whole sky, above and below the horizon">
  <canvas id="cv" tabindex="0" aria-label="Sky chart"></canvas>
  <div class="ctl" id="ctl"><button type="button" id="recenter" hidden>Recenter</button><button type="button" id="point" aria-pressed="false" aria-label="Point your phone at the sky" title="Point your phone" hidden><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="M9 1v3.5M9 13.5V17M1 9h3.5M13.5 9H17"/></svg></button></div>
</section>
<div class="cdh gut" id="bottom" aria-live="off">
  <div class="t" id="tminus">T−--:--:--</div>
  <div class="ev cap" id="next">&nbsp;</div>
  <div class="ph cap" id="phase">&nbsp;</div>
  <p class="guide" id="guide" aria-live="polite" hidden></p>
</div>
<section class="tl gut" aria-label="Today's events"><svg id="tl" role="img" aria-label="Today's events on a timeline"></svg></section>
<div class="tel gut" id="bodies" aria-label="Sun and Moon readouts"></div>
<main class="gut">
  <details class="disc" id="details"><summary>Details</summary><div id="detailsBody"></div></details>
  <details class="disc" id="evmore"><summary id="dayTitle">All events today</summary><div class="evs" id="evs"></div></details>
  <section class="blk" aria-live="polite">
    <h2 class="cap">Weather</h2>
    <div id="wx"><span class="note">Finding the nearest station…</span></div>
  </section>
  <div class="row">
    <button class="btn" type="button" id="locate">Use my exact location</button>
    <button class="btn" type="button" id="share">Copy link</button>
    <span class="note" id="locnote"></span>
  </div>
  <details class="disc hood" id="hood">
    <summary>Under the hood</summary>
    <div class="in">
      <div>
        <h3 class="cap">It's an API</h3>
        <p>Apparent topocentric positions from JPL DE440, rise, set and twilight, Moon phase and landmark alignments, in TypeScript on Cloudflare Workers and cross-checked against Skyfield. These are calls this page made:</p>
        <pre id="curl"></pre>
        <div class="row"><a class="btn" href="/docs">API reference</a><a class="btn" href="/openapi.json">openapi.json</a><a class="btn" href="/licenses/din.txt">Font licence (D-DIN, OFL)</a></div>
      </div>
      <div>
        <h3 class="cap">Diagnostics</h3>
        <p>Each answer reads 8 KiB Chebyshev blocks of DE440 through an isolate LRU, the Workers Cache, then a byte-range read of the 102 MB file in R2.</p>
        <pre id="diag"><span class="c">waiting for the first answer…</span></pre>
      </div>
    </div>
  </details>
  <footer class="tel2" id="foot"></footer>
</main>
<script>const LOC = ${json(v)};</script>
<script>
(function () {
"use strict";
${CORE_JS}
${CLIENT_TRACE_JS}
${RUM_JS}
${READ_EMBED_JS}
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
function hms(ms) { return fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms)); }
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
// All 360° of azimuth by the whole altitude range (chartModel, CORE_JS): the sky at true scale, the horizon, the civil, nautical
// and astronomical bands, the deep ground at a quarter scale. Each body's 24 h track (now ± 12 h, the one /v1/track answer)
// runs through sky and ground, past solid and future dashed, split at the live marker. Dark: the night instrument, Sun in
// lavender and Moon in teal; light: the same chart on reflective LCD glass, ink only. It draws only when something changes:
// data, resize, theme, drag, pointing, fonts, or a marker moving half a pixel (checked once a second; no rAF loop).
var cv = $("cv"), ctx = cv.getContext("2d"), W = 0, H = 0, dpr = 1, insetL = 0, insetR = 0;
var drawQueued = false, drawnAt = 0, drawnPx = null;
function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(function () { drawQueued = false; draw(); }); } }
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  var r = cv.getBoundingClientRect(), cs = getComputedStyle($("sky"));
  insetL = parseFloat(cs.paddingLeft) || 0; insetR = parseFloat(cs.paddingRight) || 0;
  if (r.width === W && r.height === H) return;
  W = r.width; H = r.height;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); requestDraw();
}
function defaultCenter(p) { return S.pose ? S.pose.az : chartCenter(loc.lat, [p.sun.azimuth, p.moon.azimuth]); }
var mw = {};
function meas(t) { if (mw[t] == null) { ctx.font = LABEL_FONT; if ("letterSpacing" in ctx) ctx.letterSpacing = "1.6px"; mw[t] = Math.ceil(ctx.measureText(t).width) + 2; } return mw[t]; }
// The live position: the last answer moved on by its own rates (deg/min) to now; the readouts keep the answer's numbers.
function livePos(now) {
  var p = S.to; if (!p) return null;
  var dt = AT != null || !p.time ? 0 : (now - Date.parse(p.time.utc)) / 60e3;
  function mv(b) { return { az: wrap360(b.azimuth + (b.azimuthRate || 0) * dt), alt: chartAlt(Math.max(-90, Math.min(90, b.altitude + (b.altitudeRate || 0) * dt))) }; }
  return { sun: mv(p.sun), moon: mv(p.moon) };
}
function drawMoon(x, y, r, m) {
  var k = m.phase.illuminatedFraction;
  var chi = (m.phase.brightLimbAngle - parallactic(altOf(m), m.azimuth, m.declination, loc.lat)) * D2R; // bright limb from the zenith, toward east
  var rot = Math.atan2(-Math.cos(chi), -Math.sin(chi));
  ctx.save(); ctx.translate(x, y);
  var gl = ctx.createRadialGradient(0, 0, r, 0, 0, r * 3.2); gl.addColorStop(0, "rgba(220,228,245," + (0.08 + 0.16 * k) + ")"); gl.addColorStop(1, "rgba(220,228,245,0)"); ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, 0, r * 3.2, 0, 2 * Math.PI); ctx.fill();
  ctx.rotate(rot);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI); ctx.fillStyle = "rgba(60,70,100,.75)"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(0, 0, Math.max(0.01, r * Math.abs(1 - 2 * k)), r, 0, Math.PI / 2, -Math.PI / 2, k < 0.5);
  ctx.fillStyle = "#eef2fb"; ctx.fill();
  ctx.restore();
}
function drawSun(x, y, r, alt) {
  var g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 4);
  g.addColorStop(0, "rgba(255,214,140,.38)"); g.addColorStop(1, "rgba(255,214,140,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, 2 * Math.PI); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = alt > 6 ? "#fff3d6" : "#ffc46b"; ctx.fill();
}
// The tracks and their events, recomputed only when the track, today's events or the minute change (not per drag frame).
var TI = { key: "" };
function trackInfo(nowMs) {
  var key = S.track.length + ":" + (S.track[0] && S.track[0].t) + ":" + (S.day && S.day.date) + ":" + (S.day && S.day.events.length) + ":" + Math.floor(nowMs / 60e3);
  if (TI.key === key) return TI;
  // One full cycle per body around now (a solar day; a lunar day, 24 h 50 min) and no more: the track closes on itself instead
  // of ending mid-sky, and no stretch of it is drawn twice at the seam.
  var HALF = { sun: 12 * 3600e3, moon: 12 * 3600e3 + 25 * 60e3 }, out = { key: key, win: {} };
  var dayEv = [].concat(S.day ? S.day.events : [], S.tomorrow ? S.tomorrow.events : []);
  ["sun", "moon"].forEach(function (body) {
    var win = out.win[body] = S.track.filter(function (x) { return Math.abs(x.t - nowMs) <= HALF[body]; });
    var s = win.map(function (x) { return { t: x.t, alt: x[body].altitude, az: x[body].azimuth }; });
    out[body] = trackEvents(s, -0.833).map(function (e) {   // the exact /v1/day time when it has this event
      var k = e.kind === "antitransit" ? null : e.kind, m = k && dayEv.find(function (d) { return d.body === body && d.kind === k && Math.abs(Date.parse(d.time) - e.t) < 40 * 60e3; });
      return m ? Object.assign({}, e, { t: Date.parse(m.time) }) : e;
    });
  });
  TI = out; return out;
}
function nextEvent(now) { var up = upcoming(now); return up.length ? { body: up[0].body, kind: up[0].kind, t: Date.parse(up[0].time) } : null; }
var PERIOD = { sun: 864e5, moon: 89428e3 };   // a solar day; a mean lunar day, 24 h 50 min 28 s
var COLOR = { sun: "#f5b860", moon: "#c9d1de" }, DIN = "'Ephem DIN', 'DIN Alternate', Bahnschrift, -apple-system, system-ui, sans-serif", LABEL_FONT = "700 10.5px " + DIN;
function draw() {
  if (!W) return;
  var p = S.to, nowMs = tNow(), live = livePos(nowMs), r = 5, c = S.center == null ? (loc.lat >= 0 ? 180 : 0) : S.center;
  var ce = $("ctl"), ctlR = !$("point").hidden || !$("recenter").hidden ? { id: "ctl", x: W - ce.offsetWidth, y: 0, w: ce.offsetWidth, h: ce.offsetHeight } : null;
  var bodies = live ? [["sun", "Sun"], ["moon", "Moon"]].map(function (o) {
    var L = live[o[0]], pts = S.track.map(function (x) { return { t: x.t, az: x[o[0]].azimuth, alt: chartAlt(x[o[0]].altitude) }; });
    var at = pts.findIndex(function (x) { return x.t > nowMs; }); if (at < 0) at = pts.length;
    pts.splice(at, 0, { t: nowMs, az: L.az, alt: L.alt });
    return { key: o[0], name: o[1], az: L.az, alt: L.alt, r: o[0] === "moon" ? 6 : r, pts: S.track.length ? pts : [], nowIdx: at, period: PERIOD[o[0]] };
  }) : [];
  var sunAlt = live ? live.sun.alt : -30;
  var m = skyModel({ W: W, H: H, insetL: insetL, insetR: insetR, center: c, now: nowMs, ctl: ctlR, pose: S.pose, lh: 17, bodies: bodies,
    meas: function (t) { return meas(t.toUpperCase()) + 10; } });
  var g = m.g, hy = g.hy;
  drawnAt = nowMs; drawnPx = bodies.map(function (b) { return [chX(b.az, g, c), chY(b.alt, g)]; });
  // the sky: its real colour, a subtle vertical gradient; below the horizon a darker, flat ground
  var sc = skyAt(sunAlt), grad = ctx.createLinearGradient(0, 0, 0, hy); grad.addColorStop(0, sc[0]); grad.addColorStop(1, sc[1]);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, hy);
  ctx.fillStyle = "#0b0d12"; ctx.fillRect(0, hy, W, H - hy);
  // one altitude reference (±30°, 10 %), the horizon, small ticks every 30° on it
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(242,244,247,.10)";
  [30, -30].forEach(function (a) { var y = Math.round(chY(a, g)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); });
  ctx.strokeStyle = "rgba(242,244,247,.32)"; ctx.beginPath(); ctx.moveTo(0, Math.round(hy) + 0.5); ctx.lineTo(W, Math.round(hy) + 0.5); ctx.stroke();
  for (var az = 0; az < 360; az += 30) chXs(az, g, c).forEach(function (x) { if (x < 0 || x > W) return; x = Math.round(x) + 0.5; ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, hy + (az % 90 ? 3 : 6)); ctx.stroke(); });
  // N E S W, small caps, along the bottom
  ctx.font = "700 10px " + DIN; if ("letterSpacing" in ctx) ctx.letterSpacing = "1.6px"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "rgba(242,244,247,.45)";
  ["N", "E", "S", "W"].forEach(function (t, i) { chXs(i * 90, g, c).forEach(function (x) { if (x > g.x0 + 8 && x < g.x1 - 8) ctx.fillText(t, x, g.bot + CH_AXIS / 2); }); });
  // tracks: one polyline per body, past ~70 %, future ~35 %, sharing the vertex at now
  Object.keys(m.lines).forEach(function (key) {
    var tl = m.lines[key];
    [[0, tl.split, 0.7], [tl.split, tl.xs.length - 1, 0.35]].forEach(function (seg) {
      if (seg[1] <= seg[0]) return;
      ctx.beginPath(); ctx.moveTo(tl.xs[seg[0]], tl.ys[seg[0]]);
      for (var j = seg[0]; j < seg[1]; j++) { var cb = crBezier(tl.xs, tl.ys, j); ctx.bezierCurveTo(cb[0], cb[1], cb[2], cb[3], tl.xs[j + 1], tl.ys[j + 1]); }
      ctx.strokeStyle = COLOR[key]; ctx.globalAlpha = seg[2]; ctx.lineWidth = 1.25; ctx.lineJoin = "round"; ctx.stroke(); ctx.globalAlpha = 1;
    });
  });
  // markers: small discs, the Moon with its phase; dimmer below the horizon
  m.discs.forEach(function (d) {
    var b = d.key === "sun" ? p.sun : p.moon;
    ctx.save(); if (d.below) ctx.globalAlpha = 0.5;
    if (d.key === "sun") drawSun(d.x, d.y, d.r, altOf(b)); else drawMoon(d.x, d.y, d.r, b);
    ctx.restore();
  });
  // pointing: the reticle, and a subtle arrow at the edge toward each body
  if (m.pose) {
    ctx.save(); ctx.strokeStyle = "#7dd3e8"; ctx.lineWidth = 1.25; ctx.beginPath(); ctx.arc(m.pose.x, m.pose.y, 11, 0, 2 * Math.PI); ctx.stroke();
    [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (d) { ctx.beginPath(); ctx.moveTo(m.pose.x + d[0] * 6, m.pose.y + d[1] * 6); ctx.lineTo(m.pose.x + d[0] * 15, m.pose.y + d[1] * 15); ctx.stroke(); });
    bodies.forEach(function (b) {
      var d = wrap180(b.az - S.pose.az); if (Math.abs(d) < 3) return;
      var ax = d < 0 ? g.x0 + 6 : g.x1 - 6, ay = Math.max(g.top + 8, Math.min(g.bot - 8, chY(b.alt, g))), s = d < 0 ? 1 : -1;
      ctx.fillStyle = COLOR[b.key]; ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + s * 7, ay - 5); ctx.lineTo(ax + s * 7, ay + 5); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
    });
    ctx.restore();
  }
  // one label per body, its name, clear of every track, disc and button
  var placed = layoutLabels(m.items, m.hard, m.segs, m.bounds, 3);
  placed.forEach(function (pl) {
    if (pl.dropped) return;
    var t = pl.id.toUpperCase();
    // a small dark pill at 60 % behind the name: legible on any sky, no outlined text
    ctx.fillStyle = "rgba(6,7,8,.6)"; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(pl.x, pl.y, pl.w, pl.h, 3); else ctx.rect(pl.x, pl.y, pl.w, pl.h); ctx.fill();
    ctx.font = LABEL_FONT; if ("letterSpacing" in ctx) ctx.letterSpacing = "1.6px"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillStyle = pl.id === "Sun" ? "#f5b860" : "#d7deeb"; ctx.fillText(t, pl.x + 5, pl.y + pl.h / 2 + 0.5);
  });
  window.__sky = { labels: placed, hard: m.hard, lines: m.lines, W: W, H: H, draws: (window.__sky ? window.__sky.draws : 0) + 1,
    overlaps: overlaps(placed.filter(function (x) { return !x.dropped; }).map(function (x) { return Object.assign({ text: true }, x); }).concat(m.hard.filter(function (h) { return /disc|pose|ctl/.test(h.id); }))) };
  if (p && !draw.marked && window.performance && performance.mark) { draw.marked = true; performance.mark("ephem:data"); __rum.mark("first-sky-draw"); }   // first frame with an answer (journey.ts, RUM)
}
// once a second (tick): redraw only if a live marker has moved half a pixel, or a minute has passed (the time split on the paths)
function liveCheck(now) {
  if (!S.to || !W) return;
  if (now - drawnAt >= 60e3 || !drawnPx || drawnPx.length < 2) { requestDraw(); return; }   // the last frame had no bodies yet
  var L = livePos(now), g = chartGeom(W, H, insetL, insetR), c = S.center;
  var moved = [L.sun, L.moon].some(function (b, i) { return Math.abs(chX(b.az, g, c) - drawnPx[i][0]) >= 0.5 || Math.abs(chY(b.alt, g) - drawnPx[i][1]) >= 0.5; });
  if (moved) requestDraw();
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
  var bs = [["Sun", S.to.sun], ["Moon", S.to.moon]].map(function (o) { return [o[0], { az: o[1].azimuth, alt: altOf(o[1]) }]; });
  var t = bs.map(function (o) { return aimShort(o[0], o[1], S.pose); }).join("   ");
  if (t !== poseText) { poseText = t; $("guide").textContent = t; $("guide").setAttribute("aria-label", bs.map(function (o) { return aimText(o[0], o[1], S.pose); }).join(". ")); }
}
var orientEv = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
function pointStop() { removeEventListener(orientEv, onOrient); S.pose = null; $("guide").hidden = true; $("point").setAttribute("aria-pressed", "false"); if (S.to && !S.userPanned) S.center = defaultCenter(S.to); requestDraw(); }
function pointStart() {
  addEventListener(orientEv, onOrient); $("point").setAttribute("aria-pressed", "true"); $("guide").hidden = false; $("guide").textContent = "Hold the phone upright and point it at the sky\\u2026";
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

// ---------- readouts: per body, a data list (label left, value right in mono, hairlines) ----------
function dayTimes(key) {
  var ev = S.day ? S.day.events.filter(function (e) { return e.body === key; }) : [], f = function (k) { var e = ev.find(function (x) { return x.kind === k; }); return e ? hm(Date.parse(e.time)) : "\u2014"; };
  var ti = S.track.length ? trackInfo(tNow()) : {}, tr = ev.find(function (x) { return x.kind === "transit"; }), info = ti[key] && tr ? ti[key].find(function (e) { return e.kind === "transit" && Math.abs(e.t - Date.parse(tr.time)) < 40 * 60e3; }) : null;
  return { rise: f("rise"), set: f("set"), transit: f("transit"), transitAlt: info ? d2(info.alt) : "" };
}
// Telemetry, per body: ALTITUDE and AZIMUTH big (DIN, tabular), a tiny unit, and one muted line: magnetic azimuth, rise, set
// (and the Moon's illumination). The rest is in Details.
function cardsHtml(p) {
  function ro(key, label, v, unit) { return '<div class="ro"><div class="cap"><i class="' + key.charAt(0) + '"></i>' + label + '</div><div class="v">' + v + '<span class="u">' + unit + "</span></div></div>"; }
  function body(key, name, b, extra) {
    var dt = dayTimes(key), m = azM(b.azimuth), a = altOf(b), app = !(b.apparentAltitude == null);
    return '<section class="bd" aria-label="' + name + '">' + ro(key, name + " \u00b7 Altitude", (a < 0 ? "\u2212" : "") + Math.abs(a).toFixed(2), "\u00b0 " + (app ? "APP" : "TRUE")) +
      ro(key, "Azimuth", wrap360(b.azimuth).toFixed(2), "\u00b0 T") +
      '<div class="sec cap">' + [m ? "Mag <b>" + m.replace(" M", "") + "</b>" : "", "Rise <b>" + dt.rise + "</b>", "Set <b>" + dt.set + "</b>"].concat(extra || []).filter(Boolean).join(" \u00b7 ") + "</div></section>";
  }
  var ph = p.moon.phase;
  return body("sun", "Sun", p.sun) + body("moon", "Moon", p.moon, ["Lit <b>" + (ph.illuminatedFraction * 100).toFixed(0) + "%</b>"]);
}
// Short caps labels (nothing wraps at 375). Apparent altitude is the API's: refracted, and null when the centre would lie below
// the observer's horizon (it can be null while the upper limb, which defines rise and set, is already up).
function detailsHtml(p) {
  function kv(k, v) { return "<dt>" + k + "</dt><dd>" + v + "</dd>"; }
  function app(b) { return b.apparentAltitude == null ? "below horizon" : d2(b.apparentAltitude); }
  var s = p.sun, mo = p.moon, ds = dayTimes("sun"), dm = dayTimes("moon");
  return '<dl class="kv">' +
    kv("Sun alt true \u00b7 app", d2(s.altitude) + " \u00b7 " + app(s)) +
    kv("Sun az T \u00b7 M", azT(s.azimuth).replace(" T", "") + (azM(s.azimuth) ? " \u00b7 " + azM(s.azimuth).replace(" M", "") : "")) +
    kv("Solar noon", ds.transit + (ds.transitAlt ? " \u00b7 " + ds.transitAlt : "")) +
    kv("Sun dist", (s.distanceKm / AU).toFixed(5) + " au") +
    kv("Moon alt true \u00b7 app", d2(mo.altitude) + " \u00b7 " + app(mo)) +
    kv("Moon az T \u00b7 M", azT(mo.azimuth).replace(" T", "") + (azM(mo.azimuth) ? " \u00b7 " + azM(mo.azimuth).replace(" M", "") : "")) +
    kv("Moon culmination", dm.transit + (dm.transitAlt ? " \u00b7 " + dm.transitAlt : "")) +
    kv("Moon dist", Math.round(mo.distanceKm).toLocaleString("en-US") + " km") +
    kv("Moon phase", esc(mo.phase.name) + " \u00b7 " + (mo.phase.illuminatedFraction * 100).toFixed(1) + "%") + "</dl>";
}
function setBodies() { if (!S.to) return; patchHtml("bodies", cardsHtml(S.to)); patchHtml("detailsBody", detailsHtml(S.to)); }
// Update in place: when the new markup has the same shape, only the text of changed leaves is rewritten, so the readouts are
// painted once as new elements (one LCP candidate, not a new one every time a number or the magnetic azimuth arrives).
function patchHtml(id, h) {
  if (domMemo[id] === h) return;
  var el = $(id), tmp = document.createElement("div"); tmp.innerHTML = h;
  var a = el.querySelectorAll("*"), b = tmp.querySelectorAll("*"), same = domMemo[id] != null && a.length === b.length;
  for (var i = 0; same && i < a.length; i++) if (a[i].tagName !== b[i].tagName || a[i].className !== b[i].className || a[i].children.length !== b[i].children.length) same = false;
  if (!same) el.innerHTML = h;
  else for (i = 0; i < a.length; i++) if (!a[i].children.length && a[i].textContent !== b[i].textContent) a[i].textContent = b[i].textContent;
  domMemo[id] = h;
}
// "Night", "Civil twilight", ... from the Sun's altitude
function skyPhase(a) { return a >= 0 ? "Daylight" : a >= -6 ? "Civil twilight" : a >= -12 ? "Nautical twilight" : a >= -18 ? "Astronomical twilight" : "Night"; }
function setPos(p) {
  if (!S.to) __rum.mark("data-ready");
  // The chart redraws for a new answer only when it shows: the first one, a body crossing the horizon, a new frame, or a minute
  // since the last draw (a 5 s step moves a body well under a pixel). The cards and the sentence are DOM, updated when they change.
  var prev = S.to, c0 = S.center; S.to = p;
  if (S.center == null || (!S.userPanned && !S.pose)) S.center = defaultCenter(p);
  if (!prev || S.center !== c0 || (altOf(prev.sun) < 0) !== (altOf(p.sun) < 0) || (altOf(prev.moon) < 0) !== (altOf(p.moon) < 0) || tNow() - drawnAt >= 60e3) requestDraw();
  setBodies(); setText("phase", skyPhase(altOf(p.sun))); aimUpdate();
  cv.setAttribute("aria-description", lede(p.sun, p.moon));
  function ariaAlt(b) { return b.apparentAltitude == null ? "below the horizon (true altitude " + b.altitude.toFixed(2) + " degrees)" : b.apparentAltitude.toFixed(2) + " degrees apparent altitude"; }
  cv.setAttribute("aria-label", "Sun " + ariaAlt(p.sun) + ", azimuth " + p.sun.azimuth.toFixed(2) + " degrees true; Moon " + ariaAlt(p.moon) + ", azimuth " + p.moon.azimuth.toFixed(2) + " degrees true");
  diag();
}
var domMemo = {};
function setHtml(id, h) { if (domMemo[id] !== h) { domMemo[id] = h; $(id).innerHTML = h; } }
function setText(id, t) { if (domMemo[id] !== t) { domMemo[id] = t; $(id).textContent = t; } }

var NAMES = { sun: { rise: "Sunrise", set: "Sunset", transit: "Solar noon", civilDawn: "Civil dawn", civilDusk: "Civil dusk", nauticalDawn: "Nautical dawn", nauticalDusk: "Nautical dusk",
  astronomicalDawn: "Astronomical dawn", astronomicalDusk: "Astronomical dusk", goldenHourStart: "Golden hour", goldenHourEnd: "Golden hour ends", blueHourStart: "Blue hour", blueHourEnd: "Blue hour ends" },
  moon: { rise: "Moonrise", set: "Moonset", transit: "Moon culmination" } };
// "Moon rises", "Sun sets", "Civil dusk", ...: the NEXT line's subject
function evPhrase(e) { var B = e.body === "sun" ? "Sun" : "Moon"; return e.kind === "rise" ? B + " rises" : e.kind === "set" ? B + " sets" : e.kind === "transit" ? B + " at its highest" : evName(e); }
// The countdown: always HH:MM:SS
function hhmmss(ms) { var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; s = s % 60; return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s; }
// "16:58", "1:16:58": a countdown that ticks every second
function clockDelta(ms) { var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; s = s % 60; return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (s < 10 ? "0" : "") + s; }
function evName(e) { return (NAMES[e.body] && NAMES[e.body][e.kind]) || e.kind; }
function upcoming(now) {
  var all = [].concat(S.day ? S.day.events : [], S.tomorrow ? S.tomorrow.events : []);
  var main = all.filter(function (e) { return e.kind === "rise" || e.kind === "set" || e.kind === "transit" || /Dawn|Dusk|HourStart/.test(e.kind); });
  return main.filter(function (e) { return Date.parse(e.time) > now; });
}
var lastNext = "";
function tick() {
  var now = tNow();
  setText("clock", hms(now));
  var age = S.posAt ? (Date.now() - S.posAt) / 1000 : null, st = S.posErr ? "alert" : age == null ? "" : age < 15 ? "ok" : "caution";
  if (domMemo.live !== st) { domMemo.live = st; $("live").className = "dot " + st; }
  setText("liveT", st === "alert" ? "No signal" : AT != null && st ? "Fixed time" : st === "ok" ? "Live" : st === "caution" ? "Delayed" : "Acquiring");
  liveCheck(now);   // the chart: a marker that moved half a pixel, or a minute
  var up = upcoming(now), html = lastNext, tm = "T\u2212--:--:--";
  if (up.length) {
    var e = up[0], t = Date.parse(e.time);
    html = esc(evName(e).toUpperCase()) + ' \u00b7 <span class="tn">' + hm(t) + "</span>" + (localDate(t) !== localDate(now) ? " TOMORROW" : "");
    tm = "T\u2212" + hhmmss(t - now);
  } else if (S.day && !S.day.loading && S.tomorrowFor === S.day.date) {
    if (S.tomorrow) html = "No rise, set or twilight in the next two days";
  } else if (S.day && !S.day.loading) loadTomorrow();   // today has nothing left: only now is tomorrow's /v1/day needed
  setText("tminus", tm);
  if (html !== lastNext) { lastNext = html; $("next").innerHTML = html; }
  if (S.day && localDate(now) !== S.day.date) loadDay();
  if (S.trackDay != null && Math.floor(now / 864e5) !== S.trackDay) loadTrack();   // a new UTC day: the next track window
  drawStripNow();
  wxAges();
}

// ---------- day strip ----------
// The mission timeline: today's events on one line (local midnight to midnight), labels alternating above and below (two rows
// each side, a label that fits nowhere is left out: its node stays), past nodes filled, future hollow, a NOW marker.
var TL = null;
function el(tag, a, txt) { var e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (var k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; }
function drawStrip() {
  var svg = $("tl"); svg.innerHTML = ""; TL = null; if (!S.day || S.day.loading) return;
  var w = Math.max(300, Math.round(svg.getBoundingClientRect().width || 1000)), s0 = Date.parse(S.day.start), span = Date.parse(S.day.end) - s0, now = tNow();
  var evs = S.day.events.map(function (e) { return { body: e.body, kind: e.kind, t: Date.parse(e.time), e: e }; });
  var sun = S.track.filter(function (x) { return x.t >= s0 - 20 * 60e3 && x.t <= s0 + span + 20 * 60e3; }).map(function (x) { return { t: x.t, alt: x.sun.altitude }; });
  var L = timelineLayout(evs, sun, s0, span, w, now, nextEvent(now), function (e) { return evName(e).toUpperCase(); }, hm, function (t, k) { return Math.ceil(t.length * (k === "name" ? 6.4 : 6.6)) + 4; });
  svg.setAttribute("viewBox", "0 0 " + w + " " + L.h);
  var SH = { day: "rgba(242,244,247,.75)", civil: "rgba(242,244,247,.42)", nautical: "rgba(242,244,247,.26)", astro: "rgba(242,244,247,.15)", night: "rgba(242,244,247,.07)" };
  L.segs.forEach(function (sg) { svg.appendChild(el("rect", { x: sg.x0, y: L.mid - 1.5, width: Math.max(0.5, sg.x1 - sg.x0), height: 3, fill: SH[sg.kind] })); });
  L.leaders.forEach(function (ld) { svg.appendChild(el("line", { x1: ld[0], y1: ld[1], x2: ld[2], y2: ld[3], stroke: "rgba(242,244,247,.2)" })); });
  L.nodes.forEach(function (n) {
    var col = n.body === "sun" ? "#f5b860" : "#c9d1de";
    if (n.next) svg.appendChild(el("circle", { cx: n.x, cy: L.mid, r: 7, fill: "none", stroke: "#6fd8f2", "stroke-width": 1.25 }));
    svg.appendChild(el("circle", { cx: n.x, cy: L.mid, r: 3.5, fill: n.past ? col : "#060708", stroke: col, "stroke-width": 1.5 }));
  });
  L.labels.forEach(function (lb) {
    var cx = lb.x + lb.w / 2, c1 = lb.next ? "#6fd8f2" : lb.past ? "#555b64" : "#8d939c", c2 = lb.next ? "#6fd8f2" : lb.past ? "#555b64" : "#f2f4f7";
    svg.appendChild(el("text", { x: cx, y: lb.y + 10, "text-anchor": "middle", "font-size": 9.5, "letter-spacing": "1.2", fill: c1 }, lb.name));
    svg.appendChild(el("text", { x: cx, y: lb.y + 24, "text-anchor": "middle", "font-size": 12, "letter-spacing": "0.4", fill: c2 }, lb.time));
  });
  var nowG = el("g", {}); nowG.appendChild(el("line", { x1: 0, x2: 0, y1: L.mid - 7, y2: L.mid + 7, stroke: "#6fd8f2", "stroke-width": 1.5 })); nowG.appendChild(el("title", {}, "Now"));
  svg.appendChild(nowG); TL = { g: nowG, X: function (t) { return 10 + Math.max(0, Math.min(1, (t - s0) / span)) * (w - 20); }, s0: s0, span: span, x: null };
  drawStripNow();
}
function drawStripNow() {   // the NOW marker: moved only when it moves a visible half pixel (every few minutes)
  if (!TL) return; var t = tNow(), x = Math.round(TL.X(t) * 2) / 2, on = t >= TL.s0 && t <= TL.s0 + TL.span;
  if (TL.x === x) return; TL.x = x;
  TL.g.setAttribute("transform", "translate(" + x + ",0)"); TL.g.style.display = on ? "" : "none";
}
function drawEvents() {
  var now = tNow();
  function row(e) { var t = Date.parse(e.time); return '<div class="' + (t < now ? "past" : "") + '"><span class="' + (e.body === "sun" ? "s" : "m") + '">' + evName(e) + '</span><span class="tn">' + hm(t) + "</span></div>"; }
  $("evs").innerHTML = S.day.events.map(row).join("") || "<div>No events today.</div>";
  $("dayTitle").textContent = "All events \u00b7 " + fmt({ weekday: "long", day: "numeric", month: "long" }).format(new Date(Date.parse(S.day.start) + 12 * 3600e3));
}

// ---------- loading ----------
function err(e) { S.err = e.message || String(e); var s = document.createElement("span"); s.className = "err"; s.textContent = "The API answered with an error: " + S.err; $("foot").replaceChildren(s); domMemo.foot = null; }
// The live answer: no time parameter, so the front door computes it (never forwarded, never cached; a timed URL would add an
// Api hop and a single-use immutable cache entry every 5 s).
function loadPos() {
  return api("/v1/position", AT == null ? q() : Object.assign(q(), { time: AT_ISO })).then(function (p) { S.posAt = Date.now(); S.posErr = null; setPos(p); tick(); })
    .catch(function (e) { S.posErr = e; err(e); });
}
function loadDay() {
  var today = localDate(tNow());
  S.day = { date: today, events: [], start: new Date(tNow()).toISOString(), end: new Date(tNow()).toISOString(), loading: true }; S.tomorrow = null; S.tomorrowFor = null;
  return api("/v1/day", dayQuery(today)).then(applyDay).catch(err);
}
function dayQuery(today) { return Object.assign(q(), { date: today, tz: loc.tz }); }
function applyDay(r) { S.day = r; S.tomorrow = null; S.tomorrowFor = null; drawEvents(); drawStrip(); tick(); if (S.to) setBodies(); requestDraw(); }
// Tomorrow's events matter only once today's have all passed (the Next line); fetched then, once per day.
function loadTomorrow() {
  var d = S.day; S.tomorrowFor = d.date;
  return api("/v1/day", Object.assign(q(), { date: nextDate(d.date), tz: loc.tz }), true).then(function (b) { if (S.day === d) { S.tomorrow = b; tick(); } }).catch(function () {});
}
// Declination comes with the weather answer (observer.magneticDeclination, the same WMM2025 value); /v1/magnetic only if weather fails.
function setDecl(x) { S.decl = x; if (S.to) setBodies(); diag(); }
function loadMag() {
  return api("/v1/magnetic", q(), true).then(function (b) { S.decl = b.magnetic.declination; if (S.to) setBodies(); if (S.wx) drawWx(); diag(); })
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
  var cn = "age" + (oa > 3600 ? " warn" : ""), tx = "METAR " + ago(oa).toUpperCase(); if (e.className !== cn) e.className = cn; if (e.textContent !== tx) e.textContent = tx;
  if ($("hood").open) diag();
}
function drawWx() {
  var w = S.wx, box = $("wx");
  if (!w.stations.length) { box.innerHTML = '<span class="note">No station reported.</span>'; return; }
  var s = w.stations[0], decl = S.decl != null ? S.decl : w.observer && w.observer.magneticDeclination;
  var raws = w.stations.map(function (x) {
    return '<span class="c"># ' + esc(x.stationId) + ', ' + x.distanceKm.toFixed(2) + ' km, observed ' + esc(utcHm(x.observationTime)) + ' (' + hm(Date.parse(x.observationTime)) + ' local)</span>\\n' + esc(x.raw);
  }).join("\\n\\n");
  function cell(k, v) { return '<div><div class="cap">' + k + '</div><div class="v">' + v + "</div></div>"; }
  function n(x, d, u) { return x == null ? "\u2014" : x.toFixed(d) + '<span class="u">' + u + "</span>"; }
  var wd = s.wind, wind = wd.speedKt == null ? "\u2014" : wd.calm ? "Calm" : (wd.variable || wd.directionDegTrue == null ? "VRB" : Math.round(wrap360(wd.directionDegTrue)) + '<span class="u">\u00b0</span>') + " " + wd.speedKt + '<span class="u">KT' + (wd.gustKt ? " G" + wd.gustKt : "") + "</span>";
  var vis = s.visibility.statuteMiles == null ? "\u2014" : s.visibility.statuteMiles + (s.visibility.orMore ? "+" : "") + '<span class="u">MI</span>';
  box.innerHTML = '<div class="wx"><div class="temp ro"><div class="cap">Temperature</div><div class="v">' + n(s.temperatureC, 1, "\u00b0C") + '</div></div><div class="cond">' + esc(condition(s)) + "</div></div>" +
    '<div class="wxg">' + cell("Wind", wind) + cell("Dew point", n(s.dewpointC, 1, "\u00b0C")) + cell("Pressure", s.altimeterHpa != null ? n(s.altimeterHpa, 0, "HPA") : n(s.altimeterInHg, 2, "INHG")) + cell("Visibility", vis) + "</div>" +
    '<p class="station">' + esc(s.stationId) + " \u00b7 " + s.distanceKm.toFixed(1) + " KM " + compass(s.bearing.true) + ' \u00b7 <span class="age" id="wxage"></span></p>' +
    '<p class="vh">' + esc(windText(wd, decl)) + ". Clouds: " + clouds(s).replace(/<[^>]+>/g, "") + "</p>" +
    '<details class="disc" id="rawd"' + (S.rawOpen ? " open" : "") + '><summary>Raw METAR</summary><pre>' + raws + "</pre></details>";
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
  return api("/v1/track", Object.assign(q(), { start: iso(t0), end: iso(t0 + 72 * 3600e3) }), true).then(function (r) { if (S.trackDay === D) applyTrack(r); }).catch(err);
}
function applyTrack(r) {
  S.trackDay = Math.round(Date.parse(r.start) / 864e5) + 1;
  var out = [], step = r.stepSeconds * 1000, s0 = Date.parse(r.start);
    function b(x, i) { return { azimuth: x.azimuth[i], altitude: x.altitude[i], apparentAltitude: x.apparentAltitude[i] }; }
    for (var i = 0; i < r.count; i++) out.push({ t: s0 + i * step, sun: b(r.sun, i), moon: b(r.moon, i) });
    S.track = out; drawStrip(); requestDraw(); if (S.to) setBodies();
    if (window.performance && performance.mark) performance.mark("ephem:track");
}
function pad(k) { return (k.toUpperCase() + "                    ").slice(0, 18); }
function diag() {
  var out = [];
  if (S.last) {
    var d = S.last.prov && S.last.prov.diagnostics, c = d && d.cache;
    out.push('<span class="c"># last position answer</span>', "GET " + esc(S.last.url), pad("round trip") + (S.last.ms == null ? "none: embedded in the page" : S.last.ms.toFixed(1) + " ms"));
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
    (S.last ? tel("Round trip", S.last.ms == null ? "embedded" : S.last.ms.toFixed(1) + " ms") : "") + (c1 ? tel("Block cache", esc(["L1 " + c1.l1].concat(Object.keys(c1).filter(function (k) { return k.indexOf("blocks_") === 0; }).map(function (k) { return k.slice(7) + " " + c1[k]; })).join(" \\u00b7 "))) : "") + tel("Edge", esc(LOC.colo || "\\u2014")) +
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
// First load: the server streams today's answers into the page (src/embed.ts; /v1/position, /v1/track, /v1/day, verbatim),
// so the first paint with data needs no API round trip. Whatever is missing (or ?at, which the server doesn't know) is fetched.
var booted = false;
function boot() {
  if (booted) return; booted = true;
  var pos = AT == null ? __embed("ephem-position") : null, tr = AT == null ? __embed("ephem-track") : null, dy = AT == null ? __embed("ephem-day") : null;
  header(); diag();
  if (pos) { S.posAt = Date.now(); S.posErr = null; S.last = { url: "/v1/position?" + new URLSearchParams(q()).toString(), ms: null, prov: pos.provenance }; setPos(pos); } else loadPos();
  if (tr) applyTrack(tr); else loadTrack();
  if (dy && dy.date === localDate(tNow())) applyDay(dy); else loadDay();
  loadWx();
  if (window.performance && performance.mark) performance.mark(pos && tr && dy ? "ephem:embedded" : "ephem:fetched");
}
function reloadAll() { S.track = []; S.to = null; S.center = null; S.decl = null; header(); diag(); return Promise.all([loadTrack(), loadPos(), loadDay(), loadWx()]); }

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
if (document.fonts && document.fonts.ready) document.fonts.ready.then(requestDraw);
resize(); header();
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();   // the embedded data is the last thing the server streams
if (AT == null) setInterval(function () { if (!document.hidden) loadPos(); }, 5000);
setInterval(tick, 1000); tick();
setInterval(function () { if (!document.hidden) loadWx(); }, 60e3);
})();
</script>
`
const PAGE_END = "</body></html>"
/** The page's face (src/din.ts), inline at the very top of the head (13.9 KB of woff2, caps only): it travels while the server
 *  computes the embedded answers, instead of ahead of them in the tail. */
const FONT_STYLE = `<style>${DIN_CSS}</style>`
