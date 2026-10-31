// GET /: the live sky over wherever the visitor is. Location comes from Cloudflare (request.cf) unless ?lat&lon override it;
// every number on the page comes from this Worker's own /v1 API, fetched by the page from the same origin.
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { isValidZone } from "@ephem/core"
import { RUM_JS } from "./rum.ts"
import { ICON_LINK } from "./favicon.ts"
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
export const Home = HttpRouter.use(router => router.add("GET", "/", req => Effect.gen(function* () {
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
})))

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
// Mission-clock countdown: "T−01:05:23".
function tminus(ms) { var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; s = s % 60;
  return "T\\u2212" + (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s; }
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
// ---- the chart model and its label layout: pure (no canvas), so test/home.test.ts runs them over every sky state ----
var CH_TOP = 14, CH_AXIS = 20;
function chartGeom(W, H, insetL, insetR) {
  var ky = (H - CH_TOP - CH_AXIS) / (U_TOP - U_BOT);
  return { W: W, H: H, kx: W / 360, ky: ky, top: CH_TOP, hy: Math.round(CH_TOP + U_TOP * ky) + 0.5, bot: H - CH_AXIS, x0: 4 + (insetL || 0), x1: W - 4 - (insetR || 0) };
}
function chX(az, g, c) { return g.W / 2 + wrap180(az - c) * g.kx; }
function chY(alt, g) { return g.top + (U_TOP - altU(alt)) * g.ky; }
function chXs(az, g, c) { var x = chX(az, g, c), r = [x], s = 360 * g.kx; if (x - s >= -40) r.push(x - s); if (x + s <= g.W + 40) r.push(x + s); return r; }
// One track as screen points: unwrapped so it crosses the seam as one line, at every 360° offset that lands on the chart.
// pts [{t, az, alt}] in time order. split: index of the first point after now (past = before it, future = from split - 1).
function trackLines(pts, g, c, now) {
  var az = unwrapAz(pts.map(function (p) { return p.az; })), xs = [], ys = [], lo = Infinity, hi = -Infinity, split = pts.length;
  for (var i = 0; i < pts.length; i++) {
    var x = g.W / 2 + (az[i] - c) * g.kx; xs.push(x); ys.push(chY(pts[i].alt, g)); lo = Math.min(lo, x); hi = Math.max(hi, x);
    if (split === pts.length && pts[i].t > now) split = i;
  }
  var span = 360 * g.kx, offs = [];
  for (var o = Math.floor(-hi / span) - 1; o <= Math.ceil((g.W - lo) / span) + 1; o++) if (hi + o * span >= 0 && lo + o * span <= g.W) offs.push(o * span);
  var segs = [];
  offs.forEach(function (dx) { for (var j = 1; j < xs.length; j++) segs.push([xs[j - 1] + dx, ys[j - 1], xs[j] + dx, ys[j]]); });
  return { xs: xs, ys: ys, offs: offs, split: split, segs: segs };
}
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
// The whole chart as geometry and labels, from plain data. st: {W, H, insetL, insetR, center, now, sunAlt, ctl (rect|null),
// pose ({az, alt}|null), next ({body, kind, t}|null: the NEXT line's event), hm (ms → "HH:MM"), meas (text, fontKey → px),
// LH ({fontKey: line height}), bodies: [{key, name, az, alt, labelAlt, r, pts: [{t, az, alt}], events: [{kind, t, az, alt}]}]}.
function chartModel(st) {
  var g = chartGeom(st.W, st.H, st.insetL, st.insetR), c = st.center, LH = st.LH, m = { g: g, lines: {}, hard: [], items: [], marks: [], discs: [], bands: [], sunBand: -1, segs: [] };
  var minus = function (a, d) { return (a < 0 ? "\\u2212" : "") + Math.abs(a).toFixed(d) + "\\u00b0"; };
  m.hard.push({ id: "horizon", x: -1e4, y: g.hy - 2, w: 2e4, h: 4 });
  var y18b = chY(-18, g); m.hard.push({ id: "break-l", x: g.x0, y: y18b - 6, w: 10, h: 12 }, { id: "break-r", x: g.x1 - 10, y: y18b - 6, w: 10, h: 12 });
  for (var az = 0; az < 360; az += 15) chXs(az, g, c).forEach(function (x) { m.hard.push({ id: "tick" + az, x: x - 1, y: g.hy, w: 2, h: az % 45 ? 3 : 6 }); });
  if (st.ctl) m.hard.push(st.ctl);
  if (st.pose) { var px = chX(st.pose.az, g, c), py = chY(st.pose.alt, g); m.pose = { x: px, y: py }; m.hard.push({ id: "pose", x: px - 21, y: py - 21, w: 42, h: 42 }); }
  // twilight bands, each named inside itself; the Sun's band first in line for its label
  [[0, -6, "CIVIL"], [-6, -12, "NAUTICAL"], [-12, -18, "ASTRONOMICAL"]].forEach(function (b, i) {
    if (st.sunAlt <= b[0] && st.sunAlt > b[1]) m.sunBand = i;
  });
  [[0, -6, "CIVIL"], [-6, -12, "NAUTICAL"], [-12, -18, "ASTRONOMICAL"]].forEach(function (b, i) {
    var y0 = chY(b[0], g), y1 = chY(b[1], g), on = i === m.sunBand; m.bands.push({ y0: y0, y1: y1, on: on });
    // bottom-aligned in its band, between the horizon's compass ticks (pad 0: the band is barely taller than the text)
    var h = LH.band, w = st.meas(b[2], "band"), yy = Math.floor(y1 - h);
    if (on && y1 - y0 >= h + 1) m.items.push({ id: "band" + i, t: b[2], font: "band", role: "bandOn", w: w, h: h, prio: 3, pad: 0, spots: spotsAlong(yy + h + 3, w, h, g).filter(function (s, k, a) { return k < a.length / 2; }) });
  });
  // the scale: altitude rings above, depth rings below (the ground under -18° is at a quarter scale: a break mark, chartGeom)
  [30, 60, -30, -60].forEach(function (alt) { var t = (alt < 0 ? "\u2212" : "") + Math.abs(alt) + "\u00b0", w = st.meas(t, "scale"), y = Math.round(chY(alt, g)) + 0.5;
    m.items.push({ id: "alt" + alt, t: t, font: "scale", role: "scale", w: w, h: LH.scale, prio: 4, spots: spotsAlong(y, w, LH.scale, g).filter(function (s) { return s[0] < g.x0 + 60 || s[0] > g.x1 - 60 - w; }) }); });
  // tracks, their events, the bodies
  st.bodies.forEach(function (b) {
    if (b.pts && b.pts.length > 1) { var tl = trackLines(b.pts, g, c, st.now); m.lines[b.key] = tl; m.segs = m.segs.concat(tl.segs); }
    (b.events || []).forEach(function (e) {
      var future = e.t > st.now, cross = e.kind === "rise" || e.kind === "set", ey = cross ? g.hy : chY(e.alt, g);
      chXs(e.az, g, c).forEach(function (ex, n) {
        m.marks.push({ key: b.key, kind: e.kind, x: ex, y: ey, future: future });
        m.hard.push(cross ? { id: b.key + e.kind + "m", x: ex - 2, y: g.hy - 6, w: 4, h: 12 } : { id: b.key + e.kind + "m", x: ex - 3.5, y: ey - 3.5, w: 7, h: 7 });
        if (n || !future || e.kind === "antitransit") return;   // labels: the coming rise, set and transit only (markers for all)
        var isNext = st.next && st.next.body === b.key && st.next.kind === e.kind && Math.abs(st.next.t - e.t) < 40 * 60e3;
        var t = (e.kind === "rise" ? "\\u2191" : e.kind === "set" ? "\\u2193" : "") + st.hm(e.t) + " " + (cross ? Math.round(wrap360(e.az)) % 360 + "\\u00b0" : minus(e.alt, 0));
        var prio = isNext ? 1 : cross ? 2 : 3;
        m.items.push({ id: b.key + "-" + e.kind + "-" + Math.round(e.t / 60e3), t: t, font: "ev", role: future ? b.key : "dim", w: st.meas(t, "ev"), h: LH.ev, x: ex, y: ey, r: 4, prio: prio });
      });
    });
    var bx = chX(b.az, g, c), by = chY(b.alt, g), rr = b.r + 9, nx = (b.events || []).filter(function (e) { return e.t > st.now && (e.kind === "rise" || e.kind === "set"); })[0];
    // a body at the seam shows at both edges (its twin, 360° over), and either may carry its name
    var span = 360 * g.kx, twin = bx < rr + 20 ? bx + span : bx > g.W - rr - 20 ? bx - span : null;
    [bx].concat(twin == null ? [] : [twin]).forEach(function (x, n) {
      m.discs.push({ key: b.key, x: x, y: by, r: b.r, below: b.alt < 0 });
      m.hard.push({ id: b.key + "-disc" + (n ? "-twin" : ""), x: x - rr, y: by - rr, w: 2 * rr, h: 2 * rr });
    });
    var t1 = b.name.toUpperCase() + " " + minus(b.labelAlt, 1);
    var it = { id: b.name, t: t1, font: "name", role: b.labelAlt < 0 ? b.key + "Below" : b.key, w: st.meas(t1, "name"), h: LH.name, x: bx, y: by, r: rr - 4, prio: 0, body: true };
    if (twin != null) it.spots = bodySpots(it).concat(bodySpots(Object.assign({}, it, { x: twin })));
    m.items.push(it);
  });
  m.bounds = { x0: g.x0, y0: 2, x1: g.x1, y1: g.bot - 1 };
  return m;
}
function compass16(az) { return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(wrap360(az) / 22.5) % 16]; }
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

/** The whole page without embedded data (tests; the client then fetches everything). */
export const page = (v: Visitor, trace?: DocumentTrace) => pageHead(v, trace) + PAGE_END

/** Everything the browser can parse, style, paint and boot before the data: flushed at once (src/embed.ts streamHtml). */
export const pageHead = (v: Visitor, trace?: DocumentTrace) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
${traceparentMeta(trace)}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ephem · the sky over ${v.city.replace(/[<>&"]/g, "")}</title>
<meta name="description" content="Where the Sun and the Moon are right now, from JPL DE440, computed on Cloudflare's edge.">
<meta name="theme-color" content="#07090c"><meta name="color-scheme" content="dark">
${ICON_LINK}
<style>
/* One dark design, always (ivar 2026-10-31: "clean, modern NASA-style"): near-black page, system sans for words, system mono
   with tabular numerals for every number, small tracked uppercase labels, hairlines at low alpha, no boxes. Colour means
   something: the sky gradient is the real sky's state; the Sun is amber, the Moon silver; cyan is the one accent (controls,
   LIVE); amber and red only for staleness. */
:root{--bg:#07090c;--ink:#e8ebf0;--muted:#8b93a1;--faint:#5b6371;--line:rgba(232,235,240,.09);--line2:rgba(232,235,240,.18);
--accent:#5cd6f0;--sun:#ffc56b;--moon:#d7deeb;--ok:#5cd6f0;--caution:#ffb547;--alert:#ff6b5e;--maxw:1120px;
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,"Segoe UI",Roboto,Arial,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.num,.tn{font-family:var(--mono);font-variant-numeric:tabular-nums;letter-spacing:0}
.lbl{font:600 11px/1.2 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.gut{padding-left:max(16px,env(safe-area-inset-left),calc((100% - var(--maxw)) / 2));padding-right:max(16px,env(safe-area-inset-right),calc((100% - var(--maxw)) / 2))}
/* slim header */
.hero{padding-top:max(10px,env(safe-area-inset-top));padding-bottom:10px}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.brand{display:flex;align-items:center;gap:10px;min-width:0;font:700 12px/1 var(--sans);letter-spacing:.16em;color:var(--ink)}
.live{display:inline-flex;align-items:center;gap:6px;font:600 10.5px/1 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.live i{width:6px;height:6px;border-radius:50%;background:var(--faint)}
.live.ok i{background:var(--ok);box-shadow:0 0 6px var(--ok)}.live.caution i{background:var(--caution)}.live.caution{color:var(--caution)}.live.alert i{background:var(--alert)}.live.alert{color:var(--alert)}
h1{font:600 15px/1.2 var(--sans);letter-spacing:0;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink);min-width:0}
h1.coords{font:500 14px/1.2 var(--mono)}
.clock{font:500 15px/1.2 var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--ink)}
.place{display:flex;align-items:baseline;gap:10px;margin-top:6px;justify-content:space-between}
/* the sky: full bleed */
.sky{position:relative;height:clamp(300px,52svh,620px);touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none;background:#05070a;
padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)}
.sky:active{cursor:grabbing}
.sky canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.ctl{position:absolute;top:0;right:env(safe-area-inset-right);z-index:2;display:flex}
.ctl button{min-height:44px;font:600 11px/1 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);background:transparent;border:0;padding:0 12px;cursor:pointer}
.ctl button span{display:inline-block;padding:6px 10px;border:1px solid rgba(92,214,240,.45);border-radius:999px;background:rgba(7,9,12,.55)}
.ctl button[aria-pressed=true] span{background:var(--accent);color:#04161c}
/* the sentence and NEXT */
.status{padding-top:14px;padding-bottom:6px}
.guide{margin:0 0 10px;font:500 13px/1.5 var(--mono);color:var(--accent);white-space:pre-line}
.lede{font:500 clamp(18px,2.2vw,22px)/1.3 var(--sans);letter-spacing:-.01em;margin:0;text-wrap:pretty}
.next{margin:8px 0 0;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.next .lbl{color:var(--accent)}
#next{display:inline-flex;align-items:baseline;gap:10px;flex-wrap:wrap;font:500 15px/1.4 var(--sans)}
.next .t{font:500 15px/1.4 var(--mono);font-variant-numeric:tabular-nums}
.next .cd{font:500 15px/1.4 var(--mono);font-variant-numeric:tabular-nums;color:var(--muted)}
/* data lists, one per body */
.panels{display:grid;grid-template-columns:minmax(0,1fr);gap:20px 40px;padding-top:14px;padding-bottom:24px}
.dl h3{margin:0 0 4px;display:flex;align-items:baseline;justify-content:space-between;font:600 12px/1.6 var(--sans);letter-spacing:.08em;text-transform:uppercase}
.dl h3 .s{color:var(--sun)}.dl h3 .m{color:var(--moon)}
.dl h3 .st{color:var(--muted);font-weight:500}
.dl dl{margin:0}
.dl dl>div{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:7px 0;border-top:1px solid var(--line)}
.dl dt{font:600 11px/1.3 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.dl dd{margin:0;font:400 14.5px/1.3 var(--mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.dl dd .u{color:var(--muted)}
main{counter-reset:sec;padding-bottom:40px}
.blk{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;padding:24px 0 28px;border-top:1px solid var(--line)}
.blk>h2,.hood>summary{margin:0;font:600 11px/1.3 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.big{font:600 20px/1.2 var(--sans);margin:0}
.sub{color:var(--muted);margin:6px 0 16px;font-size:13px}
.strip svg{display:block;width:100%;height:auto}
.strip text{font-family:var(--mono);fill:var(--muted)}
.strip .nowl{stroke:var(--ink)}
.strip line.es{stroke:var(--sun)}.strip circle.es{fill:var(--sun)}.strip line.em{stroke:var(--moon)}.strip circle.em{fill:var(--moon)}
.evs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0 40px;margin-top:16px;font-size:14px}
.evs>div{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}
.evs .past{color:var(--faint)}
.evs details.more{grid-column:1/-1;margin-top:4px}.evs details.more .evs{margin-top:0}
.evs .s::before,.evs .m::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:10px;vertical-align:1px}
.evs .s::before{background:var(--sun)}.evs .m::before{background:var(--moon)}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px;align-items:center}
.btn{min-height:44px;display:inline-flex;align-items:center;font:600 11px/1 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);background:transparent;border:1px solid rgba(92,214,240,.4);border-radius:999px;padding:0 16px;cursor:pointer}
.btn:hover{text-decoration:none;border-color:var(--accent)}
.note{font-size:13px;color:var(--muted)}
.wxc{display:grid;gap:14px}
.wxtop{display:flex;align-items:center;gap:8px 20px;flex-wrap:wrap}
.temp{font:300 40px/1 var(--mono);font-variant-numeric:tabular-nums}
.wxtop .cond{font:600 16px/1.3 var(--sans)}
.wxtop .wind{color:var(--muted);font:13px/1.4 var(--mono)}
.wxc dl.cells{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;gap:0 24px}
.wxc dl.cells>div{padding:8px 0;min-width:0;border-top:1px solid var(--line)}
.wxc dl.cells dt{font:600 11px/1.3 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.wxc dl.cells dd{margin:4px 0 0;font:14px/1.4 var(--mono)}
.station{margin:0;color:var(--muted);font:12.5px/1.6 var(--mono)}
.age{white-space:nowrap}
.age::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--ok);margin-right:7px;vertical-align:1px}
.age.warn{color:var(--caution)}.age.warn::before{background:var(--caution)}
details>summary{cursor:pointer;list-style:none;min-height:44px;display:flex;align-items:center;gap:10px;color:var(--accent);font:600 11px/1.3 var(--sans);letter-spacing:.08em;text-transform:uppercase}
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
.hood h3{font:600 11px/1.3 var(--sans);letter-spacing:.08em;text-transform:uppercase;margin:0 0 8px}
.hood p{color:var(--muted);font-size:14px;margin:0 0 14px}
.hood pre{margin:0;padding:12px 0;overflow-x:auto;font:12px/1.7 var(--mono);color:var(--ink);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
footer.tel{border-top:1px solid var(--line);padding-top:14px;padding-bottom:max(14px,env(safe-area-inset-bottom));display:flex;flex-wrap:wrap;gap:6px 24px;font:11.5px/1.5 var(--mono);color:var(--muted)}
footer.tel i{font:600 10px/1 var(--sans);font-style:normal;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin-right:8px}
:focus-visible{outline:1px solid var(--accent);outline-offset:3px}
.err{color:var(--alert)}
@media (max-width:760px){.hood .in{grid-template-columns:minmax(0,1fr)}.wxc dl.cells{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
@media (min-width:760px){.panels{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
@media (min-width:900px){.blk{grid-template-columns:200px minmax(0,1fr);gap:32px}.blk>h2{padding-top:3px}}
</style>
</head><body>
<header class="hero gut">
  <div class="top" id="top">
    <div class="brand">EPHEM<span class="live" id="live" role="status"><i></i><span id="liveT">Acquiring</span></span></div>
    <div class="clock" id="clock" aria-label="Local time">--:--:--</div>
  </div>
  <div class="place"><h1 id="place"></h1><span class="lbl">Local time</span></div>
</header>
<section class="sky" id="sky" aria-label="The Sun and the Moon on a chart of the whole sky, above and below the horizon">
  <canvas id="cv" tabindex="0" aria-label="Sky chart"></canvas>
  <div class="ctl" id="ctl"><button type="button" id="point" aria-pressed="false" hidden><span>Point phone</span></button><button type="button" id="recenter" hidden><span>Recenter</span></button></div>
</section>
<div class="status gut" id="bottom">
  <p class="guide" id="guide" aria-live="polite" hidden></p>
  <p class="lede" id="lede">Finding the Sun and the Moon…</p>
  <p class="next"><span class="lbl">Next</span><span id="next">&nbsp;</span></p>
</div>
<div class="panels gut" id="bodies" aria-label="Sun and Moon readouts"></div>
<main class="gut">
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
  <footer class="tel" id="foot"></footer>
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
var SANS = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', system-ui, sans-serif", MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace";
var FONTS = { name: "600 11.5px " + SANS, ev: "500 10.5px " + MONO, band: "600 9.5px " + SANS, scale: "500 10px " + MONO, axis: "600 10px " + SANS };
var TRACK = { name: "0.9px", ev: "0px", band: "0.8px", scale: "0px", axis: "0.8px" };
var LHS = { name: 14, ev: 13, band: 11, scale: 12 };
var mw = {};
function meas(t, f) { var k = f + "|" + t; if (mw[k] == null) { ctx.font = FONTS[f]; if ("letterSpacing" in ctx) ctx.letterSpacing = TRACK[f]; mw[k] = Math.ceil(ctx.measureText(t).width) + 2; } return mw[k]; }
// One palette (the page is dark, always). The sky above the horizon is the real sky's colour (skyAt); below it, darker.
var P = { ground: "#0a0d13", deep: "#06080c", axis: "#05070a", band: [0.18, 0.11, 0.06], bandRGB: "96,120,200", bandOn: 0.12,
  grid: "rgba(255,255,255,.08)", gridV: "rgba(255,255,255,.045)", brk: "rgba(255,255,255,.28)", horizon: "rgba(255,255,255,.7)", tick: "rgba(255,255,255,.55)", tickMinor: "rgba(255,255,255,.28)",
  cmp: "rgba(232,235,240,.8)", cmpMinor: "rgba(232,235,240,.45)", halo: "rgba(5,7,10,.82)",
  role: { sun: "#ffd28a", moon: "#e3e9f4", sunBelow: "rgba(255,210,138,.8)", moonBelow: "rgba(227,233,244,.8)", dim: "rgba(220,226,236,.6)", band: "rgba(190,205,240,.6)", bandOn: "rgba(225,232,255,.95)", scale: "rgba(232,235,240,.5)" },
  line: { sun: "#ffc56b", moon: "#d7deeb" }, ret: { sun: "#ffc56b", moon: "#d7deeb" }, pose: "#5cd6f0" };
// The live position: the last answer moved on by its own rates (deg/min) to now; the readouts keep the answer's numbers.
function livePos(now) {
  var p = S.to; if (!p) return null;
  var dt = AT != null || !p.time ? 0 : (now - Date.parse(p.time.utc)) / 60e3;
  function mv(b) { return { az: wrap360(b.azimuth + (b.azimuthRate || 0) * dt), alt: Math.max(-90, Math.min(90, altOf(b) + (b.altitudeRate || 0) * dt)) }; }
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
function reticle(x, y, r, color, below) {
  var R = r + 5;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = 0.75; if (below) ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
  [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (d) { ctx.beginPath(); ctx.moveTo(x + d[0] * R, y + d[1] * R); ctx.lineTo(x + d[0] * (R + 4), y + d[1] * (R + 4)); ctx.stroke(); });
  ctx.restore();
}
// Text with a dark halo (a knockout stroke under the fill), so it reads on any sky.
function text(t, x, y, font, color, P, align) {
  ctx.font = FONTS[font]; if ("letterSpacing" in ctx) ctx.letterSpacing = TRACK[font];
  ctx.textAlign = align || "left"; ctx.textBaseline = "middle";
  ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = P.halo; ctx.strokeText(t, x, y);
  ctx.fillStyle = color; ctx.fillText(t, x, y);
}
// The tracks and their events, recomputed only when the track, today's events or the minute change (not per drag frame).
var TI = { key: "" };
function trackInfo(nowMs) {
  var key = S.track.length + ":" + (S.track[0] && S.track[0].t) + ":" + (S.day && S.day.date) + ":" + (S.day && S.day.events.length) + ":" + Math.floor(nowMs / 60e3);
  if (TI.key === key) return TI;
  // One full cycle per body around now (a solar day; a lunar day, 24 h 50 min), plus a sample each side: the track closes on
  // itself instead of ending mid-sky.
  var HALF = { sun: 12 * 3600e3 + 20 * 60e3, moon: 12 * 3600e3 + 45 * 60e3 }, out = { key: key, win: {} };
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
function draw() {
  if (!W) return;
  var p = S.to, nowMs = tNow(), live = livePos(nowMs), info = S.track.length ? trackInfo(nowMs) : null, r = Math.max(6, Math.min(10, W / 70));
  var ce = $("ctl"), ctlR = !$("point").hidden || !$("recenter").hidden ? { id: "ctl", x: W - ce.offsetWidth, y: 0, w: ce.offsetWidth, h: ce.offsetHeight } : null;
  var bodies = live ? [["sun", "Sun", p.sun], ["moon", "Moon", p.moon]].map(function (o) {
    var L = live[o[0]], pts = info ? info.win[o[0]].map(function (x) { return { t: x.t, az: x[o[0]].azimuth, alt: altOf(x[o[0]]) }; }) : [];
    if (pts.length) { var at = pts.findIndex(function (x) { return x.t > nowMs; }); pts.splice(at < 0 ? pts.length : at, 0, { t: nowMs, az: L.az, alt: L.alt }); }
    return { key: o[0], name: o[1], az: L.az, alt: L.alt, labelAlt: altOf(o[2]), r: r, pts: pts, events: info ? info[o[0]] : [] };
  }) : [];
  var sunAlt = live ? live.sun.alt : -30;
  var m = chartModel({ W: W, H: H, insetL: insetL, insetR: insetR, center: S.center == null ? (loc.lat >= 0 ? 180 : 0) : S.center, now: nowMs, sunAlt: sunAlt, ctl: ctlR, pose: S.pose,
    next: nextEvent(nowMs), hm: hm, meas: meas, LH: LHS, bodies: bodies });
  var g = m.g, hy = g.hy, c = S.center == null ? (loc.lat >= 0 ? 180 : 0) : S.center;
  drawnAt = nowMs; drawnPx = bodies.map(function (b) { return [chX(b.az, g, c), chY(b.alt, g)]; });
  // sky
  {
    var sc = skyAt(sunAlt), grad = ctx.createLinearGradient(0, 0, 0, hy); grad.addColorStop(0, sc[0]); grad.addColorStop(1, sc[1]);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, hy);
    if (live && sunAlt > -18) { var a = Math.max(0, 1 - Math.abs(sunAlt - 2) / 20) * 0.55;
      chXs(live.sun.az, g, c).forEach(function (gx) { var rg = ctx.createRadialGradient(gx, hy, 0, gx, hy, Math.max(W, H) * 0.45); rg.addColorStop(0, "rgba(255,170,90," + a + ")"); rg.addColorStop(1, "rgba(255,170,90,0)"); ctx.fillStyle = rg; ctx.fillRect(0, 0, W, hy); }); }
  }
  // ground, bands, the deep ground, the axis
  ctx.fillStyle = P.ground; ctx.fillRect(0, hy, W, H - hy);
  m.bands.forEach(function (b, i) { ctx.fillStyle = "rgba(" + P.bandRGB + "," + (P.band[i] + (b.on ? P.bandOn : 0)) + ")"; ctx.fillRect(0, b.y0, W, b.y1 - b.y0); });
  var y18 = chY(-18, g); ctx.fillStyle = P.deep; ctx.fillRect(0, y18, W, g.bot - y18);
  ctx.fillStyle = P.axis; ctx.fillRect(0, g.bot, W, H - g.bot);
  // grid
  ctx.lineWidth = 1; ctx.strokeStyle = P.grid;
  [30, 60, -30, -60].forEach(function (alt) { var y = Math.round(chY(alt, g)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); });
  ctx.strokeStyle = P.gridV;
  for (var vz = 0; vz < 360; vz += 45) chXs(vz, g, c).forEach(function (vx) { vx = Math.round(vx) + 0.5; if (vx < 0 || vx > W) return; ctx.beginPath(); ctx.moveTo(vx, 0); ctx.lineTo(vx, g.bot); ctx.stroke(); });
  // the scale break at -18° (true scale above, a quarter below): a faint line and a break mark at each edge
  ctx.strokeStyle = P.gridV; ctx.beginPath(); ctx.moveTo(0, Math.round(y18) + 0.5); ctx.lineTo(W, Math.round(y18) + 0.5); ctx.stroke();
  ctx.strokeStyle = P.brk; ctx.lineWidth = 1;
  [g.x0 + 1, g.x1 - 9].forEach(function (bx) { [-2, 2].forEach(function (o) { ctx.beginPath(); ctx.moveTo(bx, y18 + o + 3); ctx.lineTo(bx + 4, y18 + o - 3); ctx.lineTo(bx + 8, y18 + o + 3); ctx.stroke(); }); });
  ctx.strokeStyle = P.horizon; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(W, hy); ctx.stroke(); ctx.lineWidth = 1;
  for (var az = 0; az < 360; az += 15) chXs(az, g, c).forEach(function (x) {
    if (x < -2 || x > W + 2) return;
    var major = az % 45 === 0; ctx.strokeStyle = major ? P.tick : P.tickMinor; ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, hy + (major ? 6 : 3)); ctx.stroke();
    if (major && x > g.x0 + 6 && x < g.x1 - 6) text(compass(az), x, g.bot + CH_AXIS / 2 + 1, "axis", az % 90 ? P.cmpMinor : P.cmp, P, "center");
  });
  // tracks: past solid, future dashed; the ground half at half strength
  Object.keys(m.lines).forEach(function (key) {
    var tl = m.lines[key];
    [[0, hy, 1], [hy, g.bot - hy, 0.5]].forEach(function (clip) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, clip[0], W, clip[1]); ctx.clip();
      for (var pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        tl.offs.forEach(function (dx) {
          var a0 = pass ? Math.max(0, tl.split - 1) : 0, a1 = pass ? tl.xs.length : tl.split;
          for (var j = a0; j < a1; j++) { if (j === a0) ctx.moveTo(tl.xs[j] + dx, tl.ys[j]); else ctx.lineTo(tl.xs[j] + dx, tl.ys[j]); }
        });
        ctx.strokeStyle = P.line[key]; ctx.globalAlpha = (pass ? 0.75 : 1) * clip[2]; ctx.lineWidth = 1.5; ctx.setLineDash(pass ? [4, 4] : []); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.restore();
    });
  });
  // event markers
  m.marks.forEach(function (k) {
    ctx.save(); ctx.globalAlpha = k.future ? 1 : 0.55; ctx.strokeStyle = P.line[k.key]; ctx.lineWidth = 1.5;
    if (k.kind === "rise" || k.kind === "set") { ctx.beginPath(); ctx.moveTo(k.x, hy - 6); ctx.lineTo(k.x, hy + 6); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(k.x, k.y, 2.75, 0, 2 * Math.PI); ctx.fillStyle = "#05070a"; ctx.fill(); ctx.stroke(); }
    ctx.restore();
  });
  // the bodies: always where they are; dimmed under the horizon
  m.discs.forEach(function (d) {
    var b = d.key === "sun" ? p.sun : p.moon;
    ctx.save(); if (d.below) ctx.globalAlpha = 0.6;
    if (d.key === "sun") drawSun(d.x, d.y, d.r, altOf(b)); else drawMoon(d.x, d.y, d.r, b);
    ctx.restore(); reticle(d.x, d.y, d.r, P.ret[d.key], d.below);
  });
  if (m.pose) { ctx.save(); ctx.strokeStyle = P.pose; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(m.pose.x, m.pose.y, 14, 0, 2 * Math.PI); ctx.stroke();
    [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(function (d) { ctx.beginPath(); ctx.moveTo(m.pose.x + d[0] * 8, m.pose.y + d[1] * 8); ctx.lineTo(m.pose.x + d[0] * 20, m.pose.y + d[1] * 20); ctx.stroke(); }); ctx.restore(); }
  // labels: one layout for all of them (layoutLabels, CORE_JS)
  var placed = layoutLabels(m.items, m.hard, m.segs, m.bounds, 2), byId = {};
  m.items.forEach(function (it) { byId[it.id] = it; });
  placed.forEach(function (pl) {
    if (pl.dropped) return; var it = byId[pl.id], col = P.role[it.role] || P.role.dim;
    text(it.t, pl.x + 1, pl.y + LHS[it.font] / 2, it.font, col, P);
  });
  window.__sky = { labels: placed, hard: m.hard, segs: m.segs.length, draws: (window.__sky ? window.__sky.draws : 0) + 1, W: W, H: H,
    overlaps: overlaps(placed.filter(function (x) { return !x.dropped; }).map(function (x) { return Object.assign({ text: true }, x); }).concat(m.hard.filter(function (h) { return /disc|m$|pose|ctl/.test(h.id); }))) };
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

// ---------- readouts: per body, a data list (label left, value right in mono, hairlines) ----------
function dayTimes(key) {
  var ev = S.day ? S.day.events.filter(function (e) { return e.body === key; }) : [], f = function (k) { var e = ev.find(function (x) { return x.kind === k; }); return e ? hm(Date.parse(e.time)) : "\u2014"; };
  var ti = S.track.length ? trackInfo(tNow()) : {}, tr = ev.find(function (x) { return x.kind === "transit"; }), info = ti[key] && tr ? ti[key].find(function (e) { return e.kind === "transit" && Math.abs(e.t - Date.parse(tr.time)) < 40 * 60e3; }) : null;
  return { rise: f("rise"), set: f("set"), transit: f("transit"), transitAlt: info ? d2(info.alt) : "" };
}
function cardsHtml(p) {
  function state(b) { var a = altOf(b), e = wrap360(b.azimuth) < 180; return (a >= 0 ? (e ? "Rising" : "Setting") : (e ? "Below the horizon" : "Set")) + ", " + dirWord(b.azimuth); }
  function row(k, v) { return "<div><dt>" + k + "</dt><dd>" + v + "</dd></div>"; }
  function list(key, name, b, extra) {
    var dt = dayTimes(key), m = azM(b.azimuth);
    return '<section class="dl" aria-label="' + name + '"><h3><span class="' + key.charAt(0) + '">' + name + '</span><span class="st">' + state(b) + '</span></h3><dl>' +
      row("Azimuth", azT(b.azimuth) + (m ? ' <span class="u">\u00b7</span> ' + m : "")) +
      row("Altitude", d2(b.altitude)) +
      row("Apparent", b.apparentAltitude == null ? "below horizon" : d2(b.apparentAltitude)) +
      row("Rise \u00b7 Set", dt.rise + ' <span class="u">\u00b7</span> ' + dt.set) +
      row("Transit", dt.transit + (dt.transitAlt ? ' <span class="u">\u00b7</span> ' + dt.transitAlt : "")) + extra + "</dl></section>";
  }
  var s = p.sun, mo = p.moon, ph = mo.phase;
  return list("sun", "Sun", s, row("Distance", (s.distanceKm / AU).toFixed(5) + ' <span class="u">au</span>')) +
    list("moon", "Moon", mo, row("Distance", Math.round(mo.distanceKm).toLocaleString("en-US") + ' <span class="u">km</span>') + row("Phase", esc(ph.name) + ' <span class="u">\u00b7</span> ' + (ph.illuminatedFraction * 100).toFixed(1) + "%"));
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
  setText("clock", hms(now));
  var age = S.posAt ? (Date.now() - S.posAt) / 1000 : null, st = S.posErr ? "alert" : age == null ? "" : age < 15 ? "ok" : "caution";
  if (domMemo.live !== st) { domMemo.live = st; $("live").className = "live " + st; }
  setText("liveT", st === "alert" ? "No signal" : AT != null && st ? "Fixed time" : st === "ok" ? "Live" : st === "caution" ? "Delayed" : "Acquiring");
  liveCheck(now);   // the chart: a marker that moved half a pixel, or a minute
  var up = upcoming(now), html = lastNext;
  if (up.length) {
    var e = up[0], t = Date.parse(e.time), ti = S.track.length ? trackInfo(now) : {}, ex = ti[e.body] && ti[e.body].find(function (x) { return x.kind === e.kind && Math.abs(x.t - t) < 40 * 60e3; });
    html = '<b>' + evName(e) + '</b><span class="t">' + (localDate(t) !== localDate(now) ? "tomorrow " : "") + hm(t) + (ex && (e.kind === "rise" || e.kind === "set") ? " " + compass(ex.az) : "") + '</span><span class="cd" aria-label="' + countdown(t - now) + '">' + tminus(t - now) + '</span>';
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
    var x = (Date.parse(e.time) - s) / span * w, col = e.body === "sun" ? "#a39bdc" : "#6cd1d1", cls = e.body === "sun" ? "es" : "em";
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
  return api("/v1/position", AT == null ? q() : Object.assign(q(), { time: AT_ISO })).then(function (p) { S.posAt = Date.now(); S.posErr = null; setPos(p); tick(); })
    .catch(function (e) { S.posErr = e; err(e); });
}
function loadDay() {
  var today = localDate(tNow());
  S.day = { date: today, events: [], start: new Date(tNow()).toISOString(), end: new Date(tNow()).toISOString(), loading: true }; S.tomorrow = null; S.tomorrowFor = null;
  return api("/v1/day", dayQuery(today)).then(applyDay).catch(err);
}
function dayQuery(today) { return Object.assign(q(), { date: today, tz: loc.tz }); }
function applyDay(r) { S.day = r; S.tomorrow = null; S.tomorrowFor = null; drawEvents(); drawStrip(); tick(); if (S.to) setHtml("bodies", cardsHtml(S.to)); requestDraw(); }
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
  return api("/v1/track", Object.assign(q(), { start: iso(t0), end: iso(t0 + 72 * 3600e3) }), true).then(function (r) { if (S.trackDay === D) applyTrack(r); }).catch(err);
}
function applyTrack(r) {
  S.trackDay = Math.round(Date.parse(r.start) / 864e5) + 1;
  var out = [], step = r.stepSeconds * 1000, s0 = Date.parse(r.start);
    function b(x, i) { return { azimuth: x.azimuth[i], altitude: x.altitude[i], apparentAltitude: x.apparentAltitude[i] }; }
    for (var i = 0; i < r.count; i++) out.push({ t: s0 + i * step, sun: b(r.sun, i), moon: b(r.moon, i) });
    S.track = out; drawStrip(); requestDraw(); if (S.to) setHtml("bodies", cardsHtml(S.to));
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
