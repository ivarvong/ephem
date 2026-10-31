// /day: rise, set, transit, twilight, golden and blue hour for one local calendar day.
import type { BlockSource, BodyName } from "./ephemeris.ts"
import { type Epoch, type Geodetic, type Topocentric, angularRadius, apparent, epochAt, frameAt, topocentric, topocentricRates } from "./observe.ts"
import { type Limb, P_DEFAULT, REFRACTION_FLOOR, T_DEFAULT, limbSign, refraction } from "./horizon.ts"
import { instant, isoMs } from "./time.ts"
import { type Vec3, DEG, wrap360 } from "./linalg.ts"
import { aimVector } from "./aim.ts"

export type EventKind =
  | "rise" | "set" | "transit"
  | "civilDawn" | "civilDusk" | "nauticalDawn" | "nauticalDusk" | "astronomicalDawn" | "astronomicalDusk"
  | "goldenHourStart" | "goldenHourEnd" | "blueHourStart" | "blueHourEnd"
export interface DayEvent { readonly time: string; readonly body: BodyName; readonly kind: EventKind }

const SAMPLE_MS = 300_000, TRANSIT_SAMPLE_MS = 1_200_000, TOL_MS = 0.1

// ── time zones via Intl only ──
const fmtCache = new Map<string, Intl.DateTimeFormat>()
const fmt = (tz: string) => {
  let f = fmtCache.get(tz)
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); fmtCache.set(tz, f) }
  return f
}
export const isValidZone = (tz: string): boolean => { try { fmt(tz); return true } catch { return false } }
/** Offset (ms) of local wall-clock time from UTC at instant `ms`. */
const offsetAt = (ms: number, tz: string): number => {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(ms / 1000) * 1000
}
/** UTC instant of local midnight starting `date` (YYYY-MM-DD) in `tz`; the first existing instant if midnight is skipped. */
export const localMidnight = (date: string, tz: string): number => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  const wall = Date.UTC(y, m - 1, d)
  let guess = wall - offsetAt(wall, tz)
  for (let i = 0; i < 3; i++) guess = wall - offsetAt(guess, tz)
  // If the wall time does not exist (DST gap), step forward to the first instant whose local date is `date`.
  while (new Date(guess + offsetAt(guess, tz)).toISOString().slice(0, 10) < date) guess += 60_000
  return guess
}
export const nextDate = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}
/** The local day `date` in `tz` as a UTC window [startMs, endMs), or why there is none: `date` must be a real calendar date
 *  (2026-02-30 is not; Date.UTC would silently roll it to 2026-03-02) and must exist in `tz` (Pacific/Apia skipped
 *  2011-12-30: its midnight and the next one are the same instant). */
export const localDay = (date: string, tz: string): { ok: { startMs: number; endMs: number } } | { error: string } => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  if (new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== date) return { error: `date=${date} is not a calendar date (YYYY-MM-DD with a real month and day)` }
  const startMs = localMidnight(date, tz), endMs = localMidnight(nextDate(date), tz)
  if (!(endMs > startMs)) return { error: `date=${date} does not exist in ${tz}: the zone skipped that calendar day` }
  return { ok: { startMs, endMs } }
}

// ── root finding: fixed sampling grid, then safeguarded regula falsi ──
type F = (ms: number) => number
/** Root of f in [a, b] (fa, fb on opposite sides of 0) to bracket width tol: Illinois regula falsi, bisecting whenever three steps fail to halve the bracket. */
export const solve = (f: F, a: number, b: number, fa: number, fb: number, tol: number): number => {
  let side = 0, w = b - a, k = 0
  while (b - a > tol) {
    let c = a + (b - a) * (fa / (fa - fb))
    if (++k === 3) { if (b - a > w / 2) c = (a + b) / 2; w = b - a; k = 0 }
    if (!(c > a && c < b)) c = (a + b) / 2
    const fc = f(c)
    if (fc === 0) return c
    if ((fc > 0) === (fa > 0)) { a = c; fa = fc; if (side === 1) fb /= 2; side = 1 }
    else { b = c; fb = fc; if (side === -1) fa /= 2; side = -1 }
  }
  return (a + b) / 2
}
/**
 * Zero crossings of a smooth f on [t0, t1]: sign changes between samples, plus grazing pairs — a local extremum of f
 * between samples that reaches across zero without changing sign at the samples (e.g. the Sun skimming the horizon).
 */
export const crossings = (f: F, t0: number, t1: number, step: number): Array<{ ms: number; rising: boolean }> => {
  const xs: number[] = []
  for (let x = t0; x < t1; x += step) xs.push(x)
  xs.push(t1)
  const v = xs.map(f), out: Array<{ ms: number; rising: boolean }> = []
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i]!, b = xs[i + 1]!, fa = v[i]!, fb = v[i + 1]!
    if ((fa > 0) !== (fb > 0)) { out.push({ ms: solve(f, a, b, fa, fb, TOL_MS), rising: fa < fb }); continue }
    // Grazing check: |f| dips between a and b (middle sample smaller than both neighbours).
    if (i + 2 >= xs.length) continue
    const fm = fb, fn = v[i + 2]!, c = xs[i + 2]!
    if (Math.abs(fm) < Math.abs(fa) && Math.abs(fm) < Math.abs(fn) && (fm > 0) === (fa > 0) && (fn > 0) === (fa > 0)) {
      const sgn = fa > 0 ? 1 : -1
      const ext = goldenMin(x => sgn * f(x), a, c)           // nearest approach to zero
      const fe = f(ext)
      if ((fe > 0) !== (fa > 0)) {                            // it crossed: two roots around the extremum
        out.push({ ms: solve(f, a, ext, fa, fe, TOL_MS), rising: fa < 0 })
        out.push({ ms: solve(f, ext, c, fe, fn, TOL_MS), rising: fa > 0 })
      }
    }
  }
  return out.toSorted((p, q) => p.ms - q.ms)
}
const goldenMin = (g: F, a: number, b: number): number => {
  const r = (Math.sqrt(5) - 1) / 2
  let c = b - r * (b - a), d = a + r * (b - a), gc = g(c), gd = g(d)
  while (b - a > TOL_MS) {
    if (gc < gd) { b = d; d = c; gd = gc; c = b - r * (b - a); gc = g(c) }
    else { a = c; c = d; gc = gd; d = a + r * (b - a); gd = g(d) }
  }
  return (a + b) / 2
}

export interface DayInput {
  readonly date: string; readonly tz: string; readonly geo: Geodetic; readonly dut1?: number | undefined
  readonly temperature?: number | undefined; readonly pressure?: number | undefined
  /** Apparent altitude of the horizon (degrees), or a profile of it by azimuth; default 0 (the sea horizon at sea level). */
  readonly horizon?: number | HorizonProfile | undefined
  readonly limb?: Limb | undefined
}

/** One memoised look per (body, instant): the topocentric place and distance; the Sun and the Moon share each instant's epoch. */
export const looker = (src: BlockSource, geo: Geodetic, dut1: number) => {
  const memo = { sun: new Map<number, { tp: Topocentric; dist: number }>(), moon: new Map<number, { tp: Topocentric; dist: number }>() }
  const epochs = new Map<number, Epoch>(), lt = { sun: 0, moon: 0 }
  return (body: BodyName, ms: number) => {
    let l = memo[body].get(ms)
    if (!l) {
      const t = instant(ms, dut1)
      let ep = epochs.get(ms); if (!ep) { ep = epochAt(src, t); epochs.set(ms, ep) }
      const f = frameAt(src, t, geo, ep), a = apparent(src, f, body, lt[body])
      lt[body] = a.lt; l = { tp: topocentric(f, a.v), dist: a.distanceKm }; memo[body].set(ms, l)
    }
    return l
  }
}
type Look = ReturnType<typeof looker>

/** Rise/set function of time: positive when the chosen limb is above the horizon (apparent upper limb vs horizon H, refraction
 *  from `refraction`). With H = 0, upper limb and defaults this is exactly the old altitude + 34′ + radius. */
export const riseSetFn = (look: Look, body: BodyName, horizon: number | HorizonProfile, limb: Limb, T: number, P: number) => {
  const s = limbSign(limb)
  if (typeof horizon === "number") {
    const off = refraction(horizon, T, P) - horizon
    return (ms: number) => { const l = look(body, ms); return l.tp.altitude + off + s * angularRadius(body, l.dist) }
  }
  return (ms: number) => {
    const l = look(body, ms), H = profileAt(horizon, l.tp.azimuth)
    return l.tp.altitude + (refraction(H, T, P) - H) + s * angularRadius(body, l.dist)
  }
}

export const DAY_THRESHOLDS = { civil: -6, nautical: -12, astronomical: -18, goldenHour: [-4, 6], blueHour: [-6, -4] } as const

export const day = (src: BlockSource, input: DayInput) => {
  const dut1 = input.dut1 ?? 0
  const t0 = localMidnight(input.date, input.tz), t1 = localMidnight(nextDate(input.date), input.tz)
  const T = input.temperature ?? T_DEFAULT, P = input.pressure ?? P_DEFAULT, limb = input.limb ?? "upper", horizon = input.horizon ?? 0
  // One look per (body, instant): rise/set, transit and every twilight threshold sample the same grid.
  const look = looker(src, input.geo, dut1)
  const ev: Array<{ ms: number; body: BodyName; kind: EventKind }> = []
  for (const body of ["sun", "moon"] as const) {
    for (const c of crossings(riseSetFn(look, body, horizon, limb, T, P), t0, t1, SAMPLE_MS))
      ev.push({ ms: c.ms, body, kind: c.rising ? "rise" : "set" })
    for (const c of crossings(ms => Math.sin(look(body, ms).tp.hourAngle * 15 * DEG), t0, t1, TRANSIT_SAMPLE_MS))
      if (c.rising) ev.push({ ms: c.ms, body, kind: "transit" })
  }
  const sunAlt = (ms: number) => look("sun", ms).tp.altitude
  const RULES: ReadonlyArray<readonly [number, readonly EventKind[], readonly EventKind[]]> = [
    [-6, ["civilDawn", "blueHourStart"], ["civilDusk", "blueHourEnd"]],
    [-12, ["nauticalDawn"], ["nauticalDusk"]],
    [-18, ["astronomicalDawn"], ["astronomicalDusk"]],
    [-4, ["blueHourEnd", "goldenHourStart"], ["goldenHourEnd", "blueHourStart"]],
    [6, ["goldenHourEnd"], ["goldenHourStart"]],
  ]
  for (const [thr, dawn, dusk] of RULES)
    for (const c of crossings(ms => sunAlt(ms) - thr, t0, t1, SAMPLE_MS))
      for (const kind of c.rising ? dawn : dusk) ev.push({ ms: c.ms, body: "sun", kind })
  ev.sort((a, b) => a.ms - b.ms || a.body.localeCompare(b.body) || a.kind.localeCompare(b.kind))
  return {
    date: input.date, tz: input.tz, start: isoMs(t0), end: isoMs(t1),
    observer: { lat: input.geo.lat, lon: input.geo.lon, height: input.geo.height },
    events: ev.map(e => ({ time: isoMs(e.ms), body: e.body, kind: e.kind })) as DayEvent[],
  }
}

// ── /crossing: every instant in a window when a body's limb crosses an altitude ──
export type CrossingTarget =
  | { readonly kind: "true"; readonly altitude: number }
  | { readonly kind: "apparent"; readonly altitude: number; readonly temperature: number; readonly pressure: number }
  | { readonly kind: "profile"; readonly profile: HorizonProfile; readonly temperature: number; readonly pressure: number }
export interface CrossingInput {
  readonly startMs: number; readonly endMs: number; readonly geo: Geodetic; readonly dut1?: number | undefined
  readonly body: BodyName; readonly limb: Limb; readonly direction: "rise" | "set" | "either"; readonly target: CrossingTarget
  /** litCentroid: the Moon's lit-area centroid (aim.ts) crosses instead of `limb` (which must then be center). */
  readonly aim?: "litCentroid" | undefined
}
export const MAX_CROSSING_WINDOW_MS = 31 * 86_400_000
export const crossing = (src: BlockSource, input: CrossingInput) => {
  const look = looker(src, input.geo, input.dut1 ?? 0), s = limbSign(input.limb), tg = input.target, body = input.body
  // True altitude and azimuth of the point that crosses: the chosen limb along the vertical, or the lit-area centroid.
  const enu = (l: { tp: Topocentric; dist: number }): Vec3 => {
    const a = l.tp.altitude * DEG, z = l.tp.azimuth * DEG
    return [l.dist * Math.cos(a) * Math.sin(z), l.dist * Math.cos(a) * Math.cos(z), l.dist * Math.sin(a)]
  }
  const point = input.aim === "litCentroid"
    ? (ms: number) => {
      const l = look(body, ms), x = aimVector("litCentroid", enu(l), [0, 0, 1], angularRadius(body, l.dist), enu(look("sun", ms)))
      return { alt: Math.asin(x.dir[2]) / DEG, az: wrap360(Math.atan2(x.dir[0], x.dir[1]) / DEG), offset: x.offset, angle: x.angleFromVertical }
    }
    : (ms: number) => { const l = look(body, ms); return { alt: l.tp.altitude + s * angularRadius(body, l.dist), az: l.tp.azimuth, offset: 0, angle: null } }
  const f = tg.kind === "true" ? (ms: number) => point(ms).alt - tg.altitude
    : tg.kind === "apparent" ? (() => { const thr = tg.altitude - refraction(tg.altitude, tg.temperature, tg.pressure)
      return (ms: number) => point(ms).alt - thr })()
    : (ms: number) => { const p = point(ms), A = profileAt(tg.profile, p.az); return p.alt - (A - refraction(A, tg.temperature, tg.pressure)) }
  const out = crossings(f, input.startMs, input.endMs, SAMPLE_MS)
    .filter(c => input.direction === "either" || (input.direction === "rise") === c.rising)
    .map(c => {
      const ms = Math.round(c.ms), l = look(body, ms)
      const fr = frameAt(src, instant(ms, input.dut1 ?? 0), input.geo), rate = topocentricRates(src, fr, body, apparent(src, fr, body)).altitudeRate
      const aimOut = input.aim ? (() => { const p = point(c.ms); return { aimOffset: p.offset, aimAngle: p.angle } })() : {}
      return { time: isoMs(c.ms), direction: c.rising ? "rise" as const : "set" as const, azimuth: l.tp.azimuth, altitude: l.tp.altitude, altitudeRate: rate, ...aimOut }
    })
  return { crossings: out }
}

// ── horizon profiles: apparent elevation of the skyline by azimuth ──
export interface HorizonProfile { readonly az: ReadonlyArray<number>; readonly el: ReadonlyArray<number> }   // az sorted, [0, 360)
/** Linear in azimuth between the given points, wrapping through north. */
export const profileAt = (p: HorizonProfile, azimuth: number): number => {
  const n = p.az.length
  if (n === 1) return p.el[0]!
  const a = ((azimuth % 360) + 360) % 360
  let i = 0
  while (i < n && p.az[i]! <= a) i++
  const j0 = (i - 1 + n) % n, j1 = i % n
  const a0 = p.az[j0]!, a1 = p.az[j1]!
  const span = ((a1 - a0) % 360 + 360) % 360 || 360, d = ((a - a0) % 360 + 360) % 360
  return p.el[j0]! + (p.el[j1]! - p.el[j0]!) * (d / span)
}
/** Parse "az:el,az:el,…" (degrees). Azimuths in [0, 360), strictly increasing after sorting (no duplicates); 1–360 points. */
export const parseProfile = (s: string): HorizonProfile | string => {
  const pts = s.split(",").map(x => x.trim()).filter(x => x !== "")
  if (pts.length < 1 || pts.length > MAX_PROFILE_POINTS) return `horizonProfile needs 1–${MAX_PROFILE_POINTS} az:el points`
  const xy: Array<[number, number]> = []
  for (const p of pts) {
    const m = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(p)
    if (!m) return `horizonProfile point ${JSON.stringify(p)} is not az:el (degrees, e.g. 270:1.5)`
    const az = Number(m[1]), el = Number(m[2])
    if (!(az >= 0 && az < 360)) return `horizonProfile azimuth ${az} is outside [0, 360)`
    if (!(el >= PROFILE_MIN_EL && el <= 89)) return `horizonProfile elevation ${el} is outside [${PROFILE_MIN_EL.toFixed(4)}, 89] (the refraction model's floor is ${PROFILE_MIN_EL.toFixed(4)}°)`
    xy.push([az, el])
  }
  xy.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < xy.length; i++) if (xy[i]![0] === xy[i - 1]![0]) return `horizonProfile azimuth ${xy[i]![0]} appears twice`
  return { az: xy.map(p => p[0]), el: xy.map(p => p[1]) }
}
export const MAX_PROFILE_POINTS = 360
export const PROFILE_MIN_EL = REFRACTION_FLOOR
