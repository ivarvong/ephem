// /v1/alignment: where to stand so a body appears behind a landmark, and (from a fixed spot) when it passes behind it.
//
// Unknown standing point P at eye height h_o; landmark top T at height h_t. P satisfies, at time t:
//   (1) azimuth of the body seen from P  = forward geodesic azimuth P → T
//   (2) apparent altitude of the body    = apparent elevation of T from P
// Apparent elevation = geometric elevation (exact WGS-84 ECEF) + terrestrial refraction k·θ/2, θ = s / R_mean.
import type { BlockSource, BodyName } from "./ephemeris.ts"
import { directLine, inverse } from "./geodesic.ts"
import { type Geodetic, angularRadius, apparent, enuOf, epochAt, frameAt, itrsOf, topocentric } from "./observe.ts"
import { type Vec3, DEG, dot, mxv, norm, sub, wrap360 } from "./linalg.ts"
import { crossings, solve } from "./day.ts"
import { instant, isoMs } from "./time.ts"

import { K_TERRESTRIAL, R_MEAN_M, refractTrue as refract } from "./horizon.ts"
export { K_TERRESTRIAL, R_MEAN_M }

/** Apparent elevation (deg) of the point at ITRS `Tx` from P, `s` metres away along the ground. */
const elevationAt = (P: Geodetic, Tx: Vec3, s: number): number => {
  const v = sub(Tx, itrsOf(P)), { up } = enuOf(P)
  return Math.asin(dot(v, up) / norm(v)) / DEG + (K_TERRESTRIAL * (s / R_MEAN_M) / 2) / DEG
}
/** Apparent elevation angle (deg) of target top T from observer eye P, and ground distance (m). */
export const targetElevation = (P: Geodetic, T: Geodetic): { elevation: number; distanceM: number; azimuth: number } => {
  const inv = inverse(P.lat, P.lon, T.lat, T.lon)
  return { elevation: elevationAt(P, itrsOf(T), inv.distanceM), distanceM: inv.distanceM, azimuth: inv.azimuth }
}

export interface AlignmentInput {
  readonly body: BodyName
  readonly target: Geodetic              // the point to frame (e.g. the torch), ellipsoidal height
  readonly observerHeight: number        // eye height, ellipsoidal metres
  readonly startMs: number; readonly endMs: number; readonly stepSeconds: number
  readonly maxDistanceKm: number
  readonly temperature?: number | undefined; readonly pressure?: number | undefined; readonly dut1?: number | undefined
  readonly observer?: { lat: number; lon: number } | undefined   // optional fixed spot for the converse question
}
export interface AlignmentPoint {
  readonly time: string; readonly lat: number; readonly lon: number
  readonly distanceKm: number; readonly azimuth: number; readonly apparentAltitude: number; readonly angularRadius: number
  readonly iterations: number
}

const EARTH_RAD_S = 7.292115e-5, C_M_S = 299_792_458, MAX_ITER = 12, POS_TOL_M = 1e-3, AZ_TOL_DEG = 1e-9, LAT_TOL_M = 1e-8, DIST_BISECT_M = 1e-7   // 1e-7 m keeps the elevation residual below 1e-7° even 100 m from the target

// Root of a g that falls with distance, on [lo, hi]; null when g(lo) < 0 or g(hi) > 0 (no root in range).
type G = (dm: number) => number
const fullRoot = (g: G, lo: number, hi: number): number | null => {
  const glo = g(lo), ghi = g(hi)
  return glo < 0 || ghi > 0 ? null : solve(g, lo, hi, glo, ghi, DIST_BISECT_M)
}
/** Same root, bracketed by stepping out geometrically from a guess (the previous solution) instead of from [lo, hi]. */
const warmRoot = (g: G, guess: number, lo: number, hi: number): number | null => {
  let a = Math.min(hi, Math.max(lo, guess)), ga = g(a), b = a, gb = ga, s = 1
  if (ga > 0) {
    do { a = b; ga = gb; b = Math.min(hi, a + s); gb = g(b); s *= 8 } while (gb > 0 && b < hi)
    if (gb > 0) return null
  } else {
    do { b = a; gb = ga; a = Math.max(lo, b - s); ga = g(a); s *= 8 } while (ga <= 0 && a > lo)
    if (ga < 0) return null
  }
  return solve(g, a, b, ga, gb, DIST_BISECT_M)
}

/** Secant from a guess, its first step along the last known slope dg/dm (`s.slope`, updated); stops once a step is under
 *  DIST_BISECT_M. Falls back to warmRoot when a step leaves [lo, hi], the slope is not negative, or 8 steps do not converge. */
const secantRoot = (g: G, guess: number, s: { slope: number }, lo: number, hi: number): number | null => {
  let x0 = Math.min(hi, Math.max(lo, guess)), g0 = g(x0)
  if (g0 === 0) return x0
  let x1 = s.slope < 0 ? x0 - g0 / s.slope : x0 + (g0 > 0 ? 1 : -1)
  for (let i = 0; i < 8 && x1 >= lo && x1 <= hi; i++) {
    if (Math.abs(x1 - x0) < DIST_BISECT_M) return x1
    const g1 = g(x1)
    if (g1 === 0) return x1
    const m = (g1 - g0) / (x1 - x0)
    if (!(m < 0)) break
    s.slope = m; x0 = x1; g0 = g1; x1 = x1 - g1 / m
  }
  return warmRoot(g, guess, lo, hi)
}

/** Previous instant's solution, to start the next one from; `P` undefined means start cold from the target. */
export interface Seed { P?: Geodetic | undefined; backAz: number; az: number; dist: number; slope: number; lt: number; below?: number | undefined }   // below: altitude when last null for being under −1°

/** Solve P for one instant; null when the body is below −1° or no standing point lies within maxDistance. Updates `seed` in place. */
export const standingPoint = (src: BlockSource, inp: AlignmentInput, utcMs: number, seed: Seed = { backAz: 0, az: 0, dist: 0, slope: 0, lt: 0 }): AlignmentPoint | null => {
  const t = instant(utcMs, inp.dut1 ?? 0), T = inp.temperature ?? 10, Pr = inp.pressure ?? 1010, ep = epochAt(src, t)
  let lt = seed.lt   // light time changes by ~1e-9 d per minute: the previous instant's is a close start
  const look = (g: Geodetic) => {
    const f = frameAt(src, t, g, ep), a = apparent(src, f, inp.body, lt), tp = topocentric(f, a.v)
    lt = a.lt
    return { az: tp.azimuth, alt: tp.altitude, app: refract(tp.altitude, T, Pr), radius: angularRadius(inp.body, a.distanceKm), v: mxv(ep.eo.C, a.v), r: itrsOf(g) }
  }
  // The body seen from a point Q near b's observer: shift the origin of b's apparent ITRS vector to Q. This carries the tilt of
  // the vertical (≈ s/R, comparable to the altitude itself at grazing angles) and parallax into the solve; only aberration is left over.
  type Look = ReturnType<typeof look>
  const seen = (b: Look, r: Vec3) => sub(b.v, sub(r, b.r))
  const warm = seed.P !== undefined
  let P: Geodetic = seed.P ?? { lat: inp.target.lat, lon: inp.target.lon, height: inp.observerHeight }
  let backAz = 0, it = 0, b = look(P), dist = seed.dist
  seed.P = undefined
  const Tx = itrsOf(inp.target), lo = 1, hi = inp.maxDistanceKm * 1000
  let az = b.az, app = b.app
  for (it = 1; it <= MAX_ITER; it++) {
    if (it > 1) b = look(P)
    if (b.alt < -1) { seed.below = b.alt; return null }
    if (it === 1) backAz = warm ? (seed.backAz + b.az - seed.az + 720) % 360 : (b.az + 180) % 360   // warm: carry the meridian convergence over
    // Solve (1) and (2) against b's body direction carried to each candidate point: no ephemeris inside this loop.
    let Pn = P
    for (let k = 0; k < MAX_ITER; k++) {
      // (2): distance along the current back-azimuth where the target's apparent elevation equals the body's apparent altitude.
      const line = directLine(inp.target.lat, inp.target.lon, backAz)
      const place = (dm: number): Geodetic => { const d = line(dm); return { lat: d.lat, lon: d.lon, height: inp.observerHeight } }
      const bv = b
      const g = (dm: number) => {                     // place(dm) is dm from T along the geodesic
        const Q = place(dm), r = itrsOf(Q), { up } = enuOf(Q), e = sub(Tx, r), w = seen(bv, r)
        return Math.asin(dot(e, up) / norm(e)) / DEG + (K_TERRESTRIAL * (dm / R_MEAN_M) / 2) / DEG - refract(Math.asin(dot(w, up) / norm(w)) / DEG, T, Pr)
      }
      const d = it === 1 && k === 0 && !warm ? fullRoot(g, lo, hi) : secantRoot(g, dist, seed, lo, hi)
      if (d === null) return null                    // no root in range
      dist = d; Pn = place(d)
      // (1): the forward azimuth Pn → T must equal the body azimuth seen from Pn; correct the back-azimuth by the residual.
      const fwd = inverse(Pn.lat, Pn.lon, inp.target.lat, inp.target.lon).azimuth
      const r = itrsOf(Pn), w = seen(b, r), { up, north, east } = enuOf(Pn)
      az = wrap360(Math.atan2(dot(w, east), dot(w, north)) / DEG); app = refract(Math.asin(dot(w, up) / norm(w)) / DEG, T, Pr)
      const dAz = ((az - fwd + 540) % 360) - 180
      // Within ~100 m of the target Vincenty's azimuth is only good to a few 1e-9°, so also accept a sub-1e-8 m lateral residual.
      if (Math.abs(dAz) < AZ_TOL_DEG || Math.abs(dAz) * DEG * d < LAT_TOL_M) break
      backAz = (backAz + dAz + 360) % 360
    }
    const moved = norm(sub(itrsOf(Pn), itrsOf(P))) * 1000   // chord = geodesic to far below POS_TOL_M at these steps
    P = Pn
    Object.assign(seed, { backAz, az, dist, lt })
    // Carrying b's vector to Pn is exact for geometry (parallax, vertical); it leaves out the change of diurnal aberration,
    // ≤ ω·moved/c (doubled for light time). Done once that bound is inside both tolerances; otherwise look again from Pn.
    const eps = 2 * EARTH_RAD_S * moved / C_M_S / DEG
    if (moved < POS_TOL_M || (eps < AZ_TOL_DEG && eps / Math.abs(seed.slope) < POS_TOL_M)) break
  }
  const e = targetElevation(P, inp.target)
  seed.P = P
  return { time: isoMs(utcMs), lat: P.lat, lon: P.lon, distanceKm: e.distanceM / 1000, azimuth: az, apparentAltitude: app, angularRadius: b.radius, iterations: it }
}

export interface Pass { readonly time: string; readonly altitudeOffset: number; readonly angularRadius: number; readonly apparentAltitude: number }
export interface FromObserver { readonly azimuthToTarget: number; readonly distanceKm: number; readonly targetElevation: number; readonly passes: ReadonlyArray<Pass> }

/** Converse: from a fixed spot, the instants in the window when the body's azimuth equals the target's azimuth. */
export const fromObserver = (src: BlockSource, inp: AlignmentInput, obs: { lat: number; lon: number }): FromObserver => {
  const P: Geodetic = { lat: obs.lat, lon: obs.lon, height: inp.observerHeight }
  const e = targetElevation(P, inp.target), T = inp.temperature ?? 10, Pr = inp.pressure ?? 1010
  const look = (ms: number) => {
    const f = frameAt(src, instant(ms, inp.dut1 ?? 0), P), a = apparent(src, f, inp.body), tp = topocentric(f, a.v)
    return { az: tp.azimuth, app: refract(tp.altitude, T, Pr), radius: angularRadius(inp.body, a.distanceKm) }
  }
  const dAz = (ms: number) => ((look(ms).az - e.azimuth + 540) % 360) - 180
  const passes = crossings(dAz, inp.startMs, inp.endMs, 120_000)
    .filter(c => Math.abs(dAz(c.ms)) < 1)              // discard the ±180° wrap crossings
    .map(c => { const l = look(c.ms); return { time: isoMs(c.ms), altitudeOffset: l.app - e.elevation, angularRadius: l.radius, apparentAltitude: l.app } })
  return { azimuthToTarget: e.azimuth, distanceKm: e.distanceM / 1000, targetElevation: e.elevation, passes }
}

export const alignment = (src: BlockSource, inp: AlignmentInput) => {
  const track: AlignmentPoint[] = [], seed: Seed = { backAz: 0, az: 0, dist: 0, slope: 0, lt: 0 }
  // While the body is well below the horizon, skip instants it provably cannot reach −1° by: its altitude changes by < 16°/h
  // (Earth rotation 15.04°/h, own motion and diurnal parallax < 1°/h), and the look was from ≤ maxDistance off the target.
  const climb = 16 / 3600 * inp.stepSeconds, offset = inp.maxDistanceKm / (R_MEAN_M / 1000) / DEG + 0.05
  let bound = Infinity
  for (let ms = inp.startMs; ms <= inp.endMs + 1e-6; ms += inp.stepSeconds * 1000) {
    if (bound + climb < -1) { bound += climb; continue }
    seed.below = undefined
    const p = standingPoint(src, inp, ms, seed); if (p) track.push(p)
    bound = seed.below === undefined ? Infinity : seed.below + offset
  }
  return { body: inp.body, track, ...(inp.observer ? { fromObserver: fromObserver(src, inp, inp.observer) } : {}) }
}
