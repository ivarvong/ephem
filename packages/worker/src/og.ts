// The link preview (Open Graph): a 1200×630 PNG of the live sky for a shared link, and the head tags that point at it.
// Pure: no I/O. src/og-render.ts fetches the data (the Api, over the loopback) and renders the scene with glyph
// (https://glyph.ivar.workers.dev, Ivar's renderer: a JSON scene spec → PNG); src/home.ts puts `ogHead` in the page head.
//
// The chart is the homepage's (src/home.ts CORE_JS): the same projection (all 360° of azimuth centred between the bodies, the
// C2 tanh altitude scale below the horizon), the same one-revolution track spans, the same Catmull-Rom curves, the sky colour
// from the Sun's altitude. CORE_JS is client JS in a string (a Worker cannot eval it), so the few functions the image needs
// are ported here, and test/og.test.ts runs both over the same inputs: the preview cannot drift from the page.
// Privacy: everything that keys or names an image is rounded to 0.01° (≈1 km); no IP, no exact location in any URL we mint.
import { isValidZone } from "@ephem/core"
import { DIN_ADV } from "./din.ts"
import { NOTO_FONTS, notoHas } from "./og-fonts.ts"

// ---------- the homepage's projection, ported from CORE_JS (test/og.test.ts checks them against it) ----------
export const wrap360 = (x: number) => ((x % 360) + 360) % 360
export const wrap180 = (x: number) => ((x % 360) + 540) % 360 - 180
const DEPTH_S = 36
export const altU = (a: number) => { a = Math.max(-90, Math.min(90, a)); return a >= 0 ? a : DEPTH_S * Math.tanh(a / DEPTH_S) }
const U_TOP = 90, U_BOT = altU(-90)
export const chartCenter = (lat: number, azs: readonly number[]) =>
  azs.length < 2 ? wrap360(Math.round(azs[0] == null ? (lat >= 0 ? 180 : 0) : azs[0])) : wrap360(Math.round(azs[0]! + wrap180(azs[1]! - azs[0]!) / 2))
export interface Geom { readonly W: number; readonly H: number; readonly kx: number; readonly ky: number; readonly top: number; readonly hy: number; readonly bot: number }
/** The page's chartGeom with the OG's own top margin and axis band (the page: 14 and 20 px). */
export const chartGeom = (W: number, H: number, top: number, axis: number): Geom => {
  const ky = (H - top - axis) / (U_TOP - U_BOT)
  return { W, H, kx: W / 360, ky, top, hy: Math.round(top + U_TOP * ky) + 0.5, bot: H - axis }
}
export const chX = (az: number, g: Geom, c: number) => g.W / 2 + wrap180(az - c) * g.kx
export const chY = (alt: number, g: Geom) => g.top + (U_TOP - altU(alt)) * g.ky
export const crBezier = (xs: readonly number[], ys: readonly number[], i: number): [number, number, number, number] => {
  const n = xs.length, i0 = Math.max(0, i - 1), i3 = Math.min(n - 1, i + 2)
  const p0 = [xs[i0]!, ys[i0]!], p1 = [xs[i]!, ys[i]!], p2 = [xs[i + 1]!, ys[i + 1]!], p3 = [xs[i3]!, ys[i3]!]
  const dist = (a: number[], b: number[]) => Math.pow(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!), 0.5)
  const d1 = dist(p0, p1), d2 = dist(p1, p2), d3 = dist(p2, p3), b1 = p1.slice(), b2 = p2.slice()
  if (d1 > 1e-6 && d2 > 1e-6) for (let k = 0; k < 2; k++) b1[k] = (d1 * d1 * p2[k]! - d2 * d2 * p0[k]! + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1[k]!) / (3 * d1 * (d1 + d2))
  if (d3 > 1e-6 && d2 > 1e-6) for (let k = 0; k < 2; k++) b2[k] = (d3 * d3 * p1[k]! - d2 * d2 * p3[k]! + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2[k]!) / (3 * d3 * (d3 + d2))
  return [b1[0]!, b1[1]!, b2[0]!, b2[1]!]
}
export interface TrackPt { readonly t: number; readonly az: number; readonly alt: number }
export interface SpanPt { readonly t: number; readonly rel: number; readonly alt: number; readonly edge?: boolean }
export const trackSpan = (pts: readonly TrackPt[], nowIdx: number, center: number, period: number): SpanPt[] => {
  const n = pts.length, rel: number[] = Array.from({ length: n }, () => 0), t0 = pts[nowIdx]!.t
  rel[nowIdx] = wrap180(pts[nowIdx]!.az - center)
  for (let i = nowIdx + 1; i < n; i++) rel[i] = rel[i - 1]! + wrap180(pts[i]!.az - pts[i - 1]!.az)
  for (let i = nowIdx - 1; i >= 0; i--) rel[i] = rel[i + 1]! + wrap180(pts[i]!.az - pts[i + 1]!.az)
  const walk = (dir: number, limit: number) => {
    const res: SpanPt[] = []
    for (let j = nowIdx + dir; j >= 0 && j < n; j += dir) {
      const pj = j - dir, r = rel[j]!
      if (Math.abs(r) >= 180) {
        const e = r > 0 ? 180 : -180, f = (e - rel[pj]!) / (r - rel[pj]!)
        res.push({ t: pts[pj]!.t + f * (pts[j]!.t - pts[pj]!.t), rel: e, alt: pts[pj]!.alt + f * (pts[j]!.alt - pts[pj]!.alt), edge: true })
        return res
      }
      if (Math.abs(pts[j]!.t - t0) > limit) return res
      res.push({ t: pts[j]!.t, rel: r, alt: pts[j]!.alt })
    }
    return res
  }
  const back = walk(-1, period * 1.05), fwd = walk(1, period * 1.05)
  if (back.length && back[back.length - 1]!.edge && fwd.length && fwd[fwd.length - 1]!.edge)
    return back.toReversed().concat([{ t: t0, rel: rel[nowIdx]!, alt: pts[nowIdx]!.alt }], fwd)
  let lo = -1, hi = -1
  for (let j = 0; j < n; j++) {
    const dt = pts[j]!.t - t0
    if (dt <= 0 && dt > -period && (lo < 0 || pts[j]!.alt < pts[lo]!.alt)) lo = j
    if (dt >= 0 && dt < period && (hi < 0 || pts[j]!.alt < pts[hi]!.alt)) hi = j
  }
  const out: SpanPt[] = []
  for (let j = Math.max(0, lo); j <= (hi < 0 ? n - 1 : hi); j++) out.push({ t: pts[j]!.t, rel: rel[j]!, alt: pts[j]!.alt })
  return out
}
export const zenithArc = (sp: readonly SpanPt[], xs: number[], ys: number[], g: Geom, now: number): [number, number] | null => {
  let hit: [number, number] | null = null
  for (let i = 0; i < sp.length; i++) {
    if (sp[i]!.alt <= 80) continue
    const a = i; let z = i; while (z + 1 < sp.length && sp[z + 1]!.alt > 80) z++
    i = z
    if (a === 0 || z === sp.length - 1 || Math.abs(sp[z]!.rel - sp[a]!.rel) < 30) continue
    const p = a - 1, q = z + 1, top = Math.max(...sp.slice(a, z + 1).map(s => s.alt))
    const x0 = xs[p]!, x1 = xs[q]!, yb = (ys[p]! + ys[q]!) / 2, yt = chY(top, g), t0 = sp[p]!.t, t1 = sp[q]!.t
    const at = (t: number): [number, number] => { const th = Math.PI * (t - t0) / (t1 - t0); return [(x0 + x1) / 2 - (x1 - x0) / 2 * Math.cos(th), yb - (yb - yt) * Math.sin(th)] }
    for (let j = a; j <= z; j++) { const pt = at(sp[j]!.t); xs[j] = pt[0]; ys[j] = pt[1] }
    if (now >= t0 && now <= t1) hit = at(now)
  }
  return hit
}
// The sky's colour by the Sun's altitude: [zenith, horizon] (the page's KEYS / skyAt).
const KEYS: ReadonlyArray<readonly [number, string, string]> = [[-90, "#04060d", "#080b18"], [-18, "#04060d", "#0b0f22"], [-13, "#0a1029", "#1f2450"], [-8, "#121a3c", "#4d3f78"],
  [-4, "#1d2a55", "#a85a7c"], [0, "#2b4479", "#ee8148"], [4, "#31599c", "#e9ac68"], [15, "#2a64b0", "#8ab5df"], [90, "#1d5bb5", "#73a8e0"]]
const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const mix = (a: string, b: string, t: number) => { const x = hex(a), y = hex(b); return [0, 1, 2].map(i => Math.round(x[i]! + (y[i]! - x[i]!) * t)) as [number, number, number] }
export const skyAt = (alt: number): [[number, number, number], [number, number, number]] => {
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i]!, b = KEYS[i + 1]!
    if (alt <= b[0]) { const t = Math.max(0, (alt - a[0]) / (b[0] - a[0])); return [mix(a[1], b[1], t), mix(a[2], b[2], t)] }
  }
  const l = KEYS[KEYS.length - 1]!; return [mix(l[1], l[1], 0), mix(l[2], l[2], 0)]
}
const D2R = Math.PI / 180
/** Parallactic angle (deg), as the page computes it for the Moon's bright limb. */
export const parallactic = (alt: number, az: number, dec: number, lat: number) => {
  const h = alt * D2R, A = az * D2R, p = lat * D2R, d = dec * D2R
  const H = Math.atan2(-Math.cos(h) * Math.sin(A), Math.cos(p) * Math.sin(h) - Math.sin(p) * Math.cos(h) * Math.cos(A))
  return Math.atan2(Math.sin(H), Math.tan(p) * Math.cos(d) - Math.sin(d) * Math.cos(H)) / D2R
}
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
export const compass = (az: number) => COMPASS[Math.round(wrap360(az) / 22.5) % 16]!
export const skyPhase = (a: number) => a >= 0 ? "Daylight" : a >= -6 ? "Civil twilight" : a >= -12 ? "Nautical twilight" : a >= -18 ? "Astronomical twilight" : "Night"
const NAMES: Record<string, Record<string, string>> = {
  sun: { rise: "Sunrise", set: "Sunset", transit: "Solar noon", civilDawn: "Civil dawn", civilDusk: "Civil dusk", nauticalDawn: "Nautical dawn", nauticalDusk: "Nautical dusk",
    astronomicalDawn: "Astronomical dawn", astronomicalDusk: "Astronomical dusk", goldenHourStart: "Golden hour", goldenHourEnd: "Golden hour ends", blueHourStart: "Blue hour", blueHourEnd: "Blue hour ends" },
  moon: { rise: "Moonrise", set: "Moonset", transit: "Moon culmination" },
}
export const evName = (e: { body: string; kind: string }) => NAMES[e.body]?.[e.kind] ?? e.kind

// ---------- inputs ----------
export interface BodyNow {
  readonly azimuth: number; readonly altitude: number; readonly apparentAltitude: number | null
  readonly declination?: number; readonly phase?: { readonly illuminatedFraction: number; readonly brightLimbAngle: number }
}
export interface DayEvent { readonly time: string; readonly body: string; readonly kind: string }
/** /v1/track's answer, as much of it as the chart reads. */
export interface TrackAnswer { readonly start: string; readonly stepSeconds: number; readonly count: number
  readonly sun: { readonly azimuth: readonly number[]; readonly altitude: readonly number[] }; readonly moon: { readonly azimuth: readonly number[]; readonly altitude: readonly number[] } }
export interface OgData {
  readonly place: string; readonly tz: string; readonly lat: number; readonly lon: number
  readonly at: number                          // ms: the instant drawn (the start of the time bucket)
  readonly sun: BodyNow; readonly moon: BodyNow
  readonly track: TrackAnswer | null
  readonly events: readonly DayEvent[]         // today's and tomorrow's /v1/day events (local days in tz)
}
const altOf = (b: BodyNow) => b.apparentAltitude ?? b.altitude

/** The next event the countdown counts to: the page's `upcoming` (rise, set, transit, dawns, dusks, golden/blue hour). */
export const nextEvent = (events: readonly DayEvent[], now: number): DayEvent | null =>
  events.filter(e => (e.kind === "rise" || e.kind === "set" || e.kind === "transit" || /Dawn|Dusk|HourStart/.test(e.kind)) && Date.parse(e.time) > now)
    .toSorted((a, b) => Date.parse(a.time) - Date.parse(b.time))[0] ?? null

// ---------- the image's request: rounded location, a 10-minute bucket ----------
export const BUCKET_MS = 600_000
export const OG_SIZE = [1200, 630] as const   // scene units (CSS px)
export const OG_DPR = 2                        // rendered at 2× (2400×1260, ~150-180 KB): sharp on retina previews
export const OG_PX = [OG_SIZE[0] * OG_DPR, OG_SIZE[1] * OG_DPR] as const
export interface OgQuery { readonly lat: number; readonly lon: number; readonly place: string; readonly tz: string; readonly t: number }
const r2 = (x: number) => Math.round(x * 100) / 100
/** Shorter than the page's 80: the image has one line for it. */
const placeOf = (s: string | null | undefined) => [...(s ?? "")].filter(c => c >= " " && !"<>\"&".includes(c)).join("").trim().slice(0, 48)
/** The bucket of `now`; a `t` outside [now − 2 d, now + 1 bucket] is replaced by now's (a crawler's ancient URL still renders
 *  the sky now; nobody can make us render arbitrary instants). */
export const bucketOf = (now: number) => Math.floor(now / BUCKET_MS)
export const clampBucket = (t: number, now: number) => Number.isInteger(t) && t >= bucketOf(now - 2 * 864e5) && t <= bucketOf(now) + 1 ? t : bucketOf(now)
/** GET /og.png's query (lat, lon, place, tz, t) → the normalised request, or null without a valid location. */
export const parseOgQuery = (url: URL, now: number, fallback?: { lat: number; lon: number; place: string; tz: string }): OgQuery | null => {
  const sp = url.searchParams, lat = Number(sp.get("lat")), lon = Number(sp.get("lon")), tz = sp.get("tz") ?? ""
  const t = clampBucket(Number(sp.get("t")), now)
  if (sp.has("lat") && sp.has("lon") && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
    return { lat: r2(lat), lon: r2(lon), place: placeOf(sp.get("place")) || coords(lat, lon), tz: isValidZone(tz) ? tz : fallback?.tz ?? "UTC", t }
  if (!fallback) return null
  return { lat: r2(fallback.lat), lon: r2(fallback.lon), place: placeOf(fallback.place) || coords(fallback.lat, fallback.lon), tz: isValidZone(tz) ? tz : fallback.tz, t }
}
const coords = (lat: number, lon: number) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`
/** The canonical query string (fixed order, rounded): the image URL we mint, and the loopback cache key's tail. */
export const ogQueryString = (q: OgQuery) =>
  new URLSearchParams({ lat: q.lat.toFixed(2), lon: q.lon.toFixed(2), place: q.place, tz: q.tz, t: String(q.t) }).toString()

/** The /v1 queries the image needs at instant `at`: position then, the page's track window, today and tomorrow (local). */
export const ogApiQueries = (q: OgQuery) => {
  const at = q.t * BUCKET_MS, ll = { lat: q.lat.toFixed(2), lon: q.lon.toFixed(2) }, D = Math.floor(at / 864e5), t0 = (D - 1) * 864e5
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z"
  const today = localDate(at, q.tz), tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 864e5).toISOString().slice(0, 10)
  const qs = (o: Record<string, string>) => new URLSearchParams(Object.entries(o).toSorted(([a], [b]) => (a < b ? -1 : 1))).toString()
  return {
    position: `/v1/position?${qs({ ...ll, time: iso(at) })}`,
    track: `/v1/track?${qs({ ...ll, start: iso(t0), end: iso(t0 + 72 * 3600e3) })}`,
    today: `/v1/day?${qs({ ...ll, date: today, tz: q.tz })}`,
    tomorrow: `/v1/day?${qs({ ...ll, date: tomorrow, tz: q.tz })}`,
  }
}
const localDate = (ms: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms))
const hm = (ms: number, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms))
/** "EDT", "CET", "GMT+11": en-US names America's zones, en-GB Europe's; whichever is not a bare GMT offset. */
const zoneName = (ms: number, tz: string) => {
  const z = (l: string) => new Intl.DateTimeFormat(l, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find(p => p.type === "timeZoneName")?.value ?? tz
  const us = z("en-US"); if (!/^GMT[+-]/.test(us)) return us
  const gb = z("en-GB"); return /^GMT[+-]/.test(gb) ? us : gb
}
const dateLine = (ms: number, tz: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return `${p.weekday} ${p.day} ${p.month} ${p.year} · ${hm(ms, tz)} ${zoneName(ms, tz)}`
}
export const hhmmss = (ms: number) => { let s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; s %= 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` }

// ---------- words for the head tags ----------
const deg = (x: number, d = 1) => `${x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}°`
/** og:description: "Moon 21.5° ENE · Moon culmination 05:41 · Sun −62° · Night". */
export const ogDescription = (d: Pick<OgData, "sun" | "moon" | "events" | "tz" | "at">) => {
  const nx = nextEvent(d.events, d.at), sa = altOf(d.sun), ma = altOf(d.moon)
  return [`Moon ${deg(ma)} ${compass(d.moon.azimuth)}`, nx ? `${evName(nx)} ${hm(Date.parse(nx.time), d.tz)}` : "", `Sun ${deg(sa, 0)}`, skyPhase(sa)].filter(Boolean).join(" · ")
}
export const ogAlt = (d: Pick<OgData, "sun" | "moon" | "events" | "tz" | "at" | "place">) => {
  const nx = nextEvent(d.events, d.at)
  return `Sky chart over ${d.place} at ${hm(d.at, d.tz)}: Sun ${deg(altOf(d.sun))} at ${compass(d.sun.azimuth)}, Moon ${deg(altOf(d.moon))} at ${compass(d.moon.azimuth)}` +
    (nx ? `; ${evName(nx)} in ${hhmmss(Date.parse(nx.time) - d.at).slice(0, 5).replace(":", " h ")} min` : "")
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
/** Link-preview fetchers (they read the head only): the head waits for live numbers for them, never for a person. */
export const PREVIEW_BOT = /facebookexternalhit|Facebot|Twitterbot|Slackbot|Slack-ImgProxy|Discordbot|LinkedInBot|WhatsApp|TelegramBot|Applebot|SkypeUriPreview|redditbot|Embedly|Iframely|vkShare|Pinterestbot|Mastodon|Bluesky|Cardyb|Google-PageRenderer|Signal/i
export interface OgHeadInput { readonly origin: string; readonly v: { readonly lat: number; readonly lon: number; readonly city: string; readonly place: string; readonly tz: string; readonly source: string }; readonly now: number; readonly live?: Pick<OgData, "sun" | "moon" | "events"> | null }
/** Every preview tag. The image URL names the rounded place and the 10-minute bucket, so a preview is fresh when shared and
 *  crawlers that cache images by URL never keep a stale sky. */
export const ogHead = ({ origin, v, now, live }: OgHeadInput) => {
  const q: OgQuery = { lat: r2(v.lat), lon: r2(v.lon), place: placeOf(v.city) || coords(v.lat, v.lon), tz: v.tz, t: bucketOf(now) }
  const img = `${origin}/og.png?${ogQueryString(q)}`
  const page = v.source === "query" ? `${origin}/?${new URLSearchParams({ lat: v.lat.toFixed(4), lon: v.lon.toFixed(4), tz: v.tz, place: v.city })}` : `${origin}/`
  const title = `ephem · the sky over ${v.city}`
  const d = live ? { ...live, tz: v.tz, at: now, place: v.city } : null
  const desc = d ? `${ogDescription(d)}. Live from JPL DE440.` : `Where the Sun and the Moon are over ${v.city} right now, and what rises or sets next. Live from JPL DE440.`
  const alt = d ? ogAlt(d) : `Live sky chart over ${v.city}: the Sun's and Moon's paths, a countdown to the next rise or set, their altitude and azimuth`
  const m = (p: string, c: string) => `<meta property="${p}" content="${esc(c)}">`, n = (p: string, c: string) => `<meta name="${p}" content="${esc(c)}">`
  return [m("og:type", "website"), m("og:site_name", "ephem"), m("og:title", title), m("og:description", desc), m("og:url", page),
    m("og:image", img), m("og:image:type", "image/png"), m("og:image:width", String(OG_PX[0])), m("og:image:height", String(OG_PX[1])), m("og:image:alt", alt),
    n("twitter:card", "summary_large_image"), n("twitter:title", title), n("twitter:description", desc), n("twitter:image", img), n("twitter:image:alt", alt),
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`].join("")
}

// ---------- the glyph scene ----------
/** Ephem DIN's characters and advances (1000 units/em), generated with the font (scripts/fonts/din.py → src/din.ts), for layout. */
const ADV_R = DIN_ADV.r, ADV_B = DIN_ADV.b
export const DIN_CHARS: ReadonlySet<string> = new Set(Object.keys(ADV_R))
/** A text as the card shows it: NFC, caps (what the page's text-transform does), whitespace runs as one space. It never folds,
 *  swaps or drops a character: Tromsø is TROMSØ (2026-10-31: the card said TROMSO). */
export const din = (s: string) => s.normalize("NFC").toUpperCase().replace(/\s+/g, " ").trim()
/** The face that can set all of `t`: Ephem DIN, else Noto Sans (the whole item, so a word never mixes faces), else none. */
export const faceFor = (t: string): "din" | "noto" | null => { const cs = [...t]; return cs.every(c => DIN_CHARS.has(c)) ? "din" : cs.every(notoHas) ? "noto" : null }
export const textWidth = (s: string, size: number, bold = false, tracking = 0) => [...s].reduce((w, c) => w + ((bold ? ADV_B : ADV_R)[c] ?? 500) / 1000 * size + tracking, 0)

export interface GlyphFont { readonly url: string; readonly sha256: string }
type Paint = string | readonly number[] | { readonly linear: readonly number[]; readonly stops: ReadonlyArray<readonly [number, string | readonly number[]]> } | { readonly radial: readonly number[]; readonly stops: ReadonlyArray<readonly [number, string | readonly number[]]> }
export type Item = Record<string, unknown> & { paint?: Paint }
export interface GlyphSpec { readonly glyph: 1; readonly size: readonly [number, number]; readonly background: string; readonly fonts: Record<string, GlyphFont>; readonly items: Item[] }

// The page's palette (src/home.ts :root).
const BG = "#060708", INK = "#f2f4f7", MUTED = "#8d939c", FAINT = "#555b64", SUN = "#f5b860", MOON = "#c9d1de", GROUND = "#0b0d12"
const rgba = (c: string | readonly number[], a: number) => { const x = typeof c === "string" ? hex(c) : c; return [x[0]!, x[1]!, x[2]!, Math.round(255 * a)] }
const f1 = (x: number) => Math.round(x * 10) / 10
const PERIOD: Record<string, number> = { sun: 864e5, moon: 89428e3 }

/** Layout: header 0–72, the chart 72–372 (full bleed), the hero 372–630 (countdown left, telemetry right). */
const HEAD = 72, CHART_H = 300, PAD = 56
export interface OgModel { readonly spec: GlyphSpec; readonly labels: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>; readonly discs: ReadonlyArray<{ key: string; x: number; y: number; r: number }>; readonly segs: ReadonlyArray<readonly [number, number, number, number]> }

/** The scene: data → glyph spec (plus the label layout, for tests: no label may sit on a track or a disc). */
export const ogScene = (d: OgData, fonts: { readonly regular: GlyphFont; readonly bold: GlyphFont }): OgModel => {
  const [W, H] = OG_SIZE, items: Item[] = [], at = d.at
  let noto = false
  const text = (s: string, x: number, y: number, size: number, paint: Paint, o: { bold?: boolean; tracking?: number; align?: "start" | "center" | "end"; fit?: number } = {}) => {
    const t = din(s), face = faceFor(t); if (!t || !face) return
    if (face === "noto") noto = true
    items.push({ text: t, font: (face === "noto" ? "n" : "") + (o.bold ? "b" : "r"), size, at: [f1(x), f1(y)], paint, ...(o.tracking ? { tracking: o.tracking } : {}), ...(o.align && o.align !== "start" ? { align: o.align } : {}), ...(o.fit ? { fit: Math.round(o.fit) } : {}) })
  }
  // ---- the chart (its own coordinates, shifted down by HEAD) ----
  const g = chartGeom(W, CHART_H, 18, 34), sunAlt = d.sun.altitude, sky = skyAt(sunAlt)
  const c = chartCenter(d.lat, [d.sun.azimuth, d.moon.azimuth]), Y = (y: number) => f1(y + HEAD)
  items.push({ rect: [0, HEAD, W, Y(g.hy) - HEAD], paint: { linear: [0, HEAD, 0, Y(g.hy)], stops: [[0, sky[0] as unknown as number[]], [1, sky[1] as unknown as number[]]] } })
  items.push({ rect: [0, Y(g.hy), W, HEAD + CHART_H - Y(g.hy)], paint: GROUND })
  for (const a of [30, -30]) items.push({ line: [0, Y(Math.round(chY(a, g)) + 0.5), W, Y(Math.round(chY(a, g)) + 0.5)], stroke: { width: 1 }, paint: rgba(INK, 0.1) })
  items.push({ line: [0, Y(g.hy), W, Y(g.hy)], stroke: { width: 1.5 }, paint: rgba(INK, 0.32) })
  for (let az = 0; az < 360; az += 30) { const x = Math.round(chX(az, g, c)) + 0.5; if (x > 0 && x < W) items.push({ line: [x, Y(g.hy), x, Y(g.hy + (az % 90 ? 5 : 10))], stroke: { width: 1.5 }, paint: rgba(INK, 0.32) }) }
  ;["N", "E", "S", "W"].forEach((t, i) => { const x = chX(i * 90, g, c); if (x > 24 && x < W - 24) text(t, x, Y(g.bot + 24), 17, rgba(INK, 0.5), { bold: true, tracking: 2, align: "center" }) })
  // the tracks: one revolution each (trackSpan), smooth (crBezier), past brighter than future, split at the drawn instant
  const segs: Array<[number, number, number, number]> = [], discs: Array<{ key: string; x: number; y: number; r: number; below: boolean }> = []
  for (const key of ["sun", "moon"] as const) {
    const b = d[key], pts: TrackPt[] = []
    if (d.track) { const tr = d.track, t0 = Date.parse(tr.start); for (let i = 0; i < tr.count; i++) pts.push({ t: t0 + i * tr.stepSeconds * 1000, az: tr[key].azimuth[i]!, alt: tr[key].altitude[i]! }) }
    let nowIdx = pts.findIndex(p => p.t > at); if (nowIdx < 0) nowIdx = pts.length
    pts.splice(nowIdx, 0, { t: at, az: b.azimuth, alt: b.altitude })
    let bx = chX(b.azimuth, g, c), by = chY(b.altitude, g)
    if (pts.length > 1) {
      const sp = trackSpan(pts, nowIdx, c, PERIOD[key]!), xs: number[] = [], ys: number[] = []
      let split = 0
      sp.forEach((q, i) => { xs.push(g.W / 2 + q.rel * g.kx); ys.push(chY(q.alt, g)); if (q.t <= at) split = i })
      const arc = zenithArc(sp, xs, ys, g, at); if (arc) { bx = arc[0]; by = arc[1] }
      for (let i = 1; i < xs.length; i++) segs.push([xs[i - 1]!, ys[i - 1]! + HEAD, xs[i]!, ys[i]! + HEAD])
      for (const [s0, s1, a] of [[0, split, 0.75], [split, xs.length - 1, 0.38]] as const) {
        if (s1 <= s0) continue
        let p = `M${f1(xs[s0]!)} ${Y(ys[s0]!)}`
        for (let j = s0; j < s1; j++) { const cb = crBezier(xs, ys, j); p += `C${f1(cb[0])} ${Y(cb[1])} ${f1(cb[2])} ${Y(cb[3])} ${f1(xs[j + 1]!)} ${Y(ys[j + 1]!)}` }
        items.push({ path: p, stroke: { width: 2.5, join: "round", cap: "round" }, paint: rgba(key === "sun" ? SUN : MOON, a) })
      }
    }
    discs.push({ key, x: bx, y: by + HEAD, r: key === "sun" ? 10 : 11, below: b.altitude < 0 })
  }
  // the discs: the Sun with its glow; the Moon with its phase, bright limb turned as the page turns it; dimmer below the horizon
  for (const ds of discs) {
    const k = ds.below ? 0.55 : 1, x = f1(ds.x), y = f1(ds.y), r = ds.r
    if (ds.key === "sun") {
      items.push({ circle: [x, y, r * 4.5], paint: { radial: [x, y, r * 4.5], stops: [[0, rgba("#ffd68c", 0.45 * k)], [0.2, rgba("#ffd68c", 0.32 * k)], [1, rgba("#ffd68c", 0)]] } })
      items.push({ circle: [x, y, r], paint: rgba(altOf(d.sun) > 6 ? "#fff3d6" : "#ffc46b", k) })
    } else {
      const m = d.moon, f = m.phase?.illuminatedFraction ?? 0.5
      items.push({ circle: [x, y, r * 3.6], paint: { radial: [x, y, r * 3.6], stops: [[0, rgba("#dce4f5", (0.1 + 0.2 * f) * k)], [0.28, rgba("#dce4f5", (0.08 + 0.16 * f) * k)], [1, rgba("#dce4f5", 0)]] } })
      const chi = ((m.phase?.brightLimbAngle ?? 90) - parallactic(altOf(m), m.azimuth, m.declination ?? 0, d.lat)) * D2R, rot = Math.atan2(-Math.cos(chi), -Math.sin(chi))
      const T = [Math.cos(rot), Math.sin(rot), -Math.sin(rot), Math.cos(rot), x, y].map(v => Math.round(v * 1e4) / 1e4)
      items.push({ circle: [0, 0, r], paint: rgba([60, 70, 100], 0.85 * k), transform: T })
      const rx = Math.max(0.01, r * Math.abs(1 - 2 * f))
      items.push({ path: `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}A${f1(rx)} ${r} 0 0 ${f < 0.5 ? 0 : 1} 0 ${-r}Z`, paint: rgba("#eef2fb", k), transform: T })
    }
  }
  // one label per body (its name, in a pill), at the candidate spot that crosses the fewest track segments and no disc
  const LH = 26, labels: Array<{ id: string; x: number; y: number; w: number; h: number }> = []
  const hits = (r: { x: number; y: number; w: number; h: number }) => segs.reduce((n, s) => n + (segHitsRect(s, r) ? 1 : 0), 0)
  const boxes = discs.map(ds => ({ x: ds.x - ds.r - 6, y: ds.y - ds.r - 6, w: 2 * ds.r + 12, h: 2 * ds.r + 12 }))
  for (const ds of discs) {
    const name = ds.key === "sun" ? "SUN" : "MOON", w = Math.ceil(textWidth(name, 16, true, 2.4)) + 16, R = ds.r + 10
    const cands: Array<[number, number]> = []
    for (const m of [1, 1.6, 2.4, 3.4]) {
      const dd = R * m
      cands.push([ds.x + dd, ds.y - LH / 2], [ds.x - dd - w, ds.y - LH / 2], [ds.x - w / 2, ds.y - dd - LH], [ds.x - w / 2, ds.y + dd],
        [ds.x + dd * 0.75, ds.y - dd * 0.75 - LH], [ds.x - dd * 0.75 - w, ds.y - dd * 0.75 - LH], [ds.x + dd * 0.75, ds.y + dd * 0.75], [ds.x - dd * 0.75 - w, ds.y + dd * 0.75])
    }
    let best: { x: number; y: number; w: number; h: number } | null = null, bestS = Infinity
    cands.forEach(([x, y], i) => {
      const r = { x, y, w, h: LH }
      if (x < 8 || x + w > W - 8 || y < HEAD + 6 || y + LH > HEAD + CHART_H - 30) return
      if (boxes.some(b => overlap(b, r)) || labels.some(l => overlap(l, r))) return
      const s = hits(r) * 1000 + i
      if (s < bestS) { bestS = s; best = r }
    })
    if (!best) continue
    const bb: { x: number; y: number; w: number; h: number } = best
    labels.push({ id: name, ...bb })
    items.push({ rect: [f1(bb.x), f1(bb.y), bb.w, LH], r: 4, paint: rgba(BG, 0.62) })
    text(name, bb.x + 8, bb.y + LH / 2 + 6, 16, ds.key === "sun" ? SUN : "#d7deeb", { bold: true, tracking: 2.4 })
  }
  // ---- header: EPHEM, the place, the instant ----
  items.unshift({ rect: [0, 0, W, HEAD], paint: BG })
  text("EPHEM", PAD, 47, 26, INK, { bold: true, tracking: 8 })
  const px = PAD + textWidth("EPHEM", 26, true, 8) + 22, dl = din(dateLine(at, d.tz)), dw = textWidth(dl, 19, false, 1.6)
  text(faceFor(din(d.place)) ? d.place : coords(d.lat, d.lon), px, 47, 26, MUTED, { tracking: 3.5, fit: W - PAD - dw - 36 - px })
  text(dl, W - PAD, 46, 19, MUTED, { tracking: 1.6, align: "end" })
  // ---- hero: T− countdown and the event (left), telemetry (right) ----
  const nx = nextEvent(d.events, at), sa = altOf(d.sun)
  if (nx) {
    const t = Date.parse(nx.time), tomorrow = localDate(t, d.tz) !== localDate(at, d.tz)
    text(`T−${hhmmss(t - at)}`, PAD - 4, 494, 118, INK, { tracking: 1 })
    text(`${evName(nx)} · ${hm(t, d.tz)}${tomorrow ? " TOMORROW" : ""}`, PAD, 540, 24, INK, { bold: true, tracking: 4.8, fit: 560 })
  } else {
    text("NO RISE OR SET", PAD - 2, 486, 72, INK, { tracking: 1 })
    text("IN THE NEXT TWO DAYS", PAD, 540, 24, INK, { bold: true, tracking: 4.8 })
  }
  text(skyPhase(sa), PAD, 578, 20, MUTED, { tracking: 4 })
  const col = [690, 940], row = [430, 540]
  const readout = (x: number, y: number, dot: string | null, label: string, v: string, unit: string) => {
    if (dot) items.push({ circle: [x + 5, y - 6, 5], paint: dot })
    text(label, x + (dot ? 18 : 0), y, 16, MUTED, { tracking: 2.6, fit: 230 })
    text(v, x - 2, y + 54, 54, INK, { tracking: 0.5 })
    text(unit, x + textWidth(v, 54, false, 0.5) + 4, y + 54, 18, MUTED, { tracking: 1.4 })
  }
  for (const [i, key] of (["sun", "moon"] as const).entries()) {
    const b = d[key], a = altOf(b), app = b.apparentAltitude != null
    readout(col[0]!, row[i]!, key === "sun" ? SUN : MOON, `${key === "sun" ? "Sun" : "Moon"} · Altitude`, `${a < 0 ? "−" : ""}${Math.abs(a).toFixed(2)}`, `° ${app ? "APP" : "TRUE"}`)
    readout(col[1]!, row[i]!, null, "Azimuth", wrap360(b.azimuth).toFixed(2), `° T ${compass(b.azimuth)}`)
  }
  items.push({ line: [PAD, 372.5, W - PAD, 372.5], stroke: { width: 1 }, paint: rgba(INK, 0.06) })
  items.push({ line: [646.5, 404, 646.5, 590], stroke: { width: 1 }, paint: rgba(INK, 0.09) })
  void FAINT
  return { spec: { glyph: 1, size: [W, H], background: BG, fonts: { r: fonts.regular, b: fonts.bold, ...(noto ? { nr: NOTO_FONTS.regular, nb: NOTO_FONTS.bold } : {}) }, items }, labels, discs, segs }
}
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
/** Does segment s cross (or lie inside) rect r? Liang–Barsky clipping. */
export const segHitsRect = (s: readonly [number, number, number, number], r: { x: number; y: number; w: number; h: number }) => {
  let t0 = 0, t1 = 1; const dx = s[2] - s[0], dy = s[3] - s[1]
  for (const [p, q] of [[-dx, s[0] - r.x], [dx, r.x + r.w - s[0]], [-dy, s[1] - r.y], [dy, r.y + r.h - s[1]]] as const) {
    if (p === 0) { if (q < 0) return false; continue }
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
  }
  return true
}

// ---------- static images: the home-screen / iMessage icon and the fallback card (scripts/og/assets.ts renders them) ----------
const rotAbout = (angle: number, cx: number, cy: number) => { const c = Math.cos(angle * D2R), s = Math.sin(angle * D2R); return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy].map(v => Math.round(v * 1e4) / 1e4) }
/** apple-touch-icon, 180×180: a twilight sky over a dark ground, the Sun's track rising to its disc, the Moon's crescent. */
export const iconSpec = (): GlyphSpec => {
  const S = 180, hy = 116, sky = skyAt(-5)
  return { glyph: 1, size: [S, S], background: BG, fonts: {}, items: [
    { rect: [0, 0, S, hy], paint: { linear: [0, 0, 0, hy], stops: [[0, sky[0] as unknown as number[]], [1, sky[1] as unknown as number[]]] } },
    { rect: [0, hy, S, S - hy], paint: GROUND },
    { line: [0, hy, S, hy], stroke: { width: 2 }, paint: rgba(INK, 0.4) },
    { path: "M-6 152C52 150 92 70 124 66", stroke: { width: 4, cap: "round" }, paint: rgba(SUN, 0.8) },
    { path: "M124 66C156 62 172 112 192 142", stroke: { width: 4, cap: "round" }, paint: rgba(SUN, 0.35) },
    { circle: [124, 66, 44], paint: { radial: [124, 66, 44], stops: [[0, rgba("#ffd68c", 0.55)], [0.25, rgba("#ffd68c", 0.35)], [1, rgba("#ffd68c", 0)]] } },
    { circle: [124, 66, 13], paint: "#ffc46b" },
    { circle: [52, 44, 11], paint: rgba([60, 70, 100], 0.85) },
    { path: "M52 33A11 11 0 0 1 52 55A5 11 0 0 0 52 33Z", paint: "#eef2fb", transform: rotAbout(20, 52, 44) },
  ] }
}
/** The card when the live render cannot be had in time: the page's frame without numbers (none of them would be true). */
export const fallbackSpec = (fonts: { readonly regular: GlyphFont; readonly bold: GlyphFont }): GlyphSpec => {
  const [W, H] = OG_SIZE, sky = skyAt(-6), hy = HEAD + 190, items: Item[] = []
  const t = (s: string, x: number, y: number, size: number, paint: Paint, bold = false, tracking = 0) => items.push({ text: din(s), font: bold ? "b" : "r", size, at: [x, y], paint, ...(tracking ? { tracking } : {}) })
  items.push({ rect: [0, HEAD, W, hy - HEAD], paint: { linear: [0, HEAD, 0, hy], stops: [[0, sky[0] as unknown as number[]], [1, sky[1] as unknown as number[]]] } })
  items.push({ rect: [0, hy, W, HEAD + CHART_H - hy], paint: GROUND }, { line: [0, hy + 0.5, W, hy + 0.5], stroke: { width: 1.5 }, paint: rgba(INK, 0.32) })
  for (let x = 50; x < W; x += 100) items.push({ line: [x + 0.5, hy, x + 0.5, hy + ((x - 50) % 300 ? 5 : 10)], stroke: { width: 1.5 }, paint: rgba(INK, 0.32) })
  t("EPHEM", PAD, 47, 26, INK, true, 8); t("THE SKY, LIVE", PAD + textWidth("EPHEM", 26, true, 8) + 22, 47, 26, MUTED, false, 3.5)
  t("SUN AND MOON", PAD - 3, 482, 96, INK, false, 1)
  t("WHERE THEY ARE NOW · WHAT RISES OR SETS NEXT", PAD, 532, 24, INK, true, 4.8)
  t("JPL DE440 · COMPUTED ON CLOUDFLARE'S EDGE", PAD, 572, 20, MUTED, false, 4)
  return { glyph: 1, size: [W, H], background: BG, fonts: { r: fonts.regular, b: fonts.bold }, items: [{ rect: [0, 0, W, HEAD], paint: BG }, ...items] }
}
