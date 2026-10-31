// /v1/alignment/search: every pass during which the alignment standing point (alignment.ts) lies inside a standing region.
//
// 1. Band. P inside the region ⇒ the body's apparent altitude at P = the target's apparent elevation from P, which lies in
//    [eMin, eMax] over the region (exact WGS-84 elevations at the region's farthest and nearest points from the target: with
//    the target above the eye, elevation falls with distance); and the body's azimuth at P = the forward azimuth P →
//    target, which lies in [azMin, azMax] (vertices). Seen from one reference point R (the region's centre) the body differs
//    from what P sees by at most the tilt of the vertical between them (s/R), meridian convergence and parallax: the margins.
//    No representative observer elevation is guessed: the band is the whole range the region allows.
// 2. Scan, provably complete. Seen from R (geodetic latitude φ) a fixed direction's altitude changes at ω·cos φ·sin A
//    (ω = 15.0411°/h, Earth rotation) and its azimuth at ω·(sin φ − cos φ·cos A·tan h); the body's own motion, diurnal
//    parallax included, adds < 1°/h of arc (÷ cos h in azimuth). So |dh/dt| ≤ ω·cos φ + 1°/h and, while |h| ≤ H,
//    |dA/dt| ≤ ω·(|sin φ| + cos φ·tan H) + 1°/h ÷ cos H. With d(t) the altitude's (or azimuth's) distance from the band, no
//    in-band instant lies within d(t)/L of t, so the scan jumps that far (an azimuth jump only as far as |h| provably stays
//    ≤ H); near the band it steps 60 s and keeps every interval [t₀, t₁] with d(t₀) + d(t₁) ≤ L·(t₁ − t₀) for both altitude
//    and azimuth (otherwise the body cannot reach the band inside it). Each kept span's ends are then pulled in by the same
//    jumps, from both sides, until a jump is under 1 s. Every instant with P inside the region lies inside a kept span, and
//    span ends are out of the band, so outside the region.
// 3. Clip, exactly. Along each span the ground track P(t) is sampled with chords ≤ 50 m (finer where it curves); every chord
//    that crosses a region edge is refined on the true track: the signed distance of P(t) from the edge's line is solved to
//    1 mm with Illinois' method (each evaluation is a full standing-point solve). Between consecutive crossings the track is
//    inside or outside the region (even-odd, holes included); inside runs are the segments.
// 4. Passes. Segments less than an hour apart form one pass; a pass belongs to the window holding its first entry, so windows
//    on a fixed grid can be computed (and cached) independently and concatenated.
import type { BlockSource, BodyName } from "./ephemeris.ts"
import { type AlignmentInput, type Seed, eyeHeight, standingPoint, targetElevation } from "./alignment.ts"
import { inverse } from "./geodesic.ts"
import { type Geodetic, apparent, frameAt, topocentric } from "./observe.ts"
import { type HeightRef, REFRACTION_FLOOR, apparentAltitudeOf, refraction, refractTrue } from "./horizon.ts"
import { moonPhase } from "./position.ts"
import type { Aim } from "./aim.ts"
import { DEG } from "./linalg.ts"
import { instant, isoMs } from "./time.ts"
import { type PlanarRegion, type Region, insidePlanar, planarFrame, planarRegion, regionBbox } from "./region.ts"

export const SEARCH = {
  windowDays: 30,                // the cacheable unit: windows on a grid of 30 days since 1970-01-01T00:00Z
  maxSpanDays: 400,
  passGapS: 3600,                // segments closer than this form one pass
  lookbackS: 6 * 3600,           // a window scans this far back so a pass that began earlier is recognised as not its own
  lookaheadS: 2 * 3600,          // and this far past its end so its last pass is complete
  scanStepS: 60,
  earthRateDegPerH: 15.0411,     // ω: Earth rotation (sidereal)
  ownRateDegPerH: 1,             // the body's own motion seen from R, diurnal parallax included: Moon < 0.64 + 0.27°/h
  azJumpCapDeg: 15,              // azimuth jumps only while |h| ≤ band + this (the azimuth bound grows with tan h)
  trimMinS: 1,                   // span ends are pulled in until a jump is shorter than this
  chordM: 50, sagittaM: 0.01, crossingTolM: 1e-3, crossingTolS: 1e-4,
  maxPassesPerWindow: 200,
  maxElevationDeg: 60,
  minDistanceM: 10,
  maxDistanceKm: 100,
} as const

const R_MIN_M = 6_335_439          // smallest WGS-84 radius of curvature (meridian at the equator): bounds the tilt of the vertical
const MOON_MIN_KM = 356_400        // closest Moon: bounds parallax between two points of the region
const wrap180 = (d: number) => ((d % 360) + 540) % 360 - 180

export interface SearchInput {
  readonly body: BodyName
  readonly target: Geodetic                 // ellipsoidal height
  readonly observerHeight: number           // eye height: above the ellipsoid, or above the EGM96 geoid with observerHeightRef msl
  readonly observerHeightRef?: HeightRef | undefined   // msl: the eye is observerHeight + N at every standing point (alignment.ts eyeHeight)
  readonly region: Region
  readonly startMs: number; readonly endMs: number   // passes whose first entry is in [start, end)
  readonly aim?: Aim | undefined                     // which point of the disc sits on the target (alignment.ts); default center
  readonly temperature?: number | undefined; readonly pressure?: number | undefined; readonly dut1?: number | undefined
}

export interface SearchGeometry {
  readonly reference: { readonly lat: number; readonly lon: number }
  readonly distanceM: { readonly min: number; readonly max: number }
  readonly elevation: { readonly min: number; readonly max: number }        // apparent elevation of the target over the region
  readonly azimuth: { readonly min: number; readonly max: number }          // forward azimuth to the target over the region
  readonly band: { readonly trueAltitudeMin: number; readonly trueAltitudeMax: number; readonly azimuthMin: number; readonly azimuthMax: number }   // body at the reference point, margins included
  readonly margins: { readonly altitude: number; readonly azimuth: number }
  readonly maxDistanceKm: number                                             // solver range
  readonly referenceSpreadM: number                                         // farthest vertex from the reference point
}

/** The band the body must be in, seen from the reference point, for the standing point to be inside the region. */
export const searchGeometry = (inp: Pick<SearchInput, "target" | "observerHeight" | "observerHeightRef" | "region" | "temperature" | "pressure" | "aim">): SearchGeometry | { error: string } => {
  const T = inp.temperature ?? 10, Pr = inp.pressure ?? 1010, tg = inp.target, eye = eyeHeight(inp)
  const b = regionBbox(inp.region), rlat = (b.south + b.north) / 2, rlon = (b.west + b.east) / 2, ref: Geodetic = { lat: rlat, lon: rlon, height: eye(rlat, rlon) }
  // the target in a planar frame around itself, for each edge's nearest point (then measured exactly)
  const tf = planarFrame([[[[tg.lon, tg.lat], [tg.lon + 1e-6, tg.lat], [tg.lon, tg.lat + 1e-6]]]])
  const pr = planarRegion(inp.region)
  if (insidePlanar(pr, ...pr.frame.toXY(tg.lon, tg.lat))) return { error: "the target is inside the region" }
  let dMin = Infinity, dMax = 0, near: Geodetic = ref, far: Geodetic = ref, sMax = 0
  const az0 = inverse(ref.lat, ref.lon, tg.lat, tg.lon).azimuth
  let azLo = Infinity, azHi = -Infinity
  for (const p of inp.region) for (const r of p) for (let i = 0; i < r.length; i++) {
    const [alon, alat] = r[i]!, [blon, blat] = r[(i + 1) % r.length]!
    const iv = inverse(alat, alon, tg.lat, tg.lon)
    if (iv.distanceM > dMax) { dMax = iv.distanceM; far = { lat: alat, lon: alon, height: eye(alat, alon) } }
    if (iv.distanceM < dMin) { dMin = iv.distanceM; near = { lat: alat, lon: alon, height: eye(alat, alon) } }
    const da = wrap180(iv.azimuth - az0); azLo = Math.min(azLo, da); azHi = Math.max(azHi, da)
    sMax = Math.max(sMax, inverse(ref.lat, ref.lon, alat, alon).distanceM)
    // nearest point of the straight (lon, lat) edge: projection in the target's frame, then the exact distance there
    const [ax, ay] = tf.toXY(alon, alat), [bx, by] = tf.toXY(blon, blat), ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey
    const u = L2 > 0 ? -(ax * ex + ay * ey) / L2 : 0
    if (u > 0 && u < 1) {
      const lat = alat + u * (blat - alat), lon = alon + u * (blon - alon), d = inverse(lat, lon, tg.lat, tg.lon).distanceM
      if (d < dMin) { dMin = d; near = { lat, lon, height: eye(lat, lon) } }
    }
  }
  if (dMin < SEARCH.minDistanceM) return { error: `the region comes within ${dMin.toFixed(1)} m of the target; at least ${SEARCH.minDistanceM} m` }
  if (dMax > SEARCH.maxDistanceKm * 1000) return { error: `the region reaches ${(dMax / 1000).toFixed(1)} km from the target; at most ${SEARCH.maxDistanceKm} km` }
  if (azHi - azLo >= 180) return { error: "the region surrounds the target (it spans 180° or more of bearing)" }
  // The alignment solver brackets P assuming the target is above the eye (a lower target sits near −90° from 1 m away), so
  // /v1/alignment has no standing point below it; then e(d) also falls monotonically with distance: the band is [e(far), e(near)].
  if (tg.height <= Math.max(near.height, far.height, ref.height)) return { error: "the target must be above the eye height (alignment has no standing point for a target below the eye)" }
  const eMin = targetElevation(far, tg).elevation, eMax = targetElevation(near, tg).elevation
  if (eMax > SEARCH.maxElevationDeg) return { error: `the target stands ${eMax.toFixed(1)}° above parts of the region; at most ${SEARCH.maxElevationDeg}°` }
  // Margins: the body seen from P vs from the reference point (tilt of the vertical, parallax, meridian convergence), plus 1e-3°.
  const tilt = sMax / R_MIN_M / DEG, par = sMax / (MOON_MIN_KM * 1000) / DEG
  // An aim point other than the centre is at most one disc radius off it (Moon ≤ 0.2793°, Sun ≤ 0.2717°): widen by 0.3°.
  const aimOff = (inp.aim ?? "center") === "center" ? 0 : 0.3
  const mAlt = tilt + par + aimOff + 1e-3
  const hLo = eMin - refraction(Math.max(eMin, REFRACTION_FLOOR), T, Pr) - mAlt, hHi = eMax - refraction(Math.max(eMax, REFRACTION_FLOOR), T, Pr) + mAlt
  const cosCap = Math.cos(Math.min(hHi + 1, 85) * DEG)
  const mAz = (tilt * (1 + Math.abs(Math.tan(ref.lat * DEG))) + par + aimOff) / cosCap + 1e-3
  return {
    reference: { lat: ref.lat, lon: ref.lon },
    distanceM: { min: dMin, max: dMax }, elevation: { min: eMin, max: eMax },
    azimuth: { min: (az0 + azLo + 360) % 360, max: (az0 + azHi + 360) % 360 },
    band: { trueAltitudeMin: hLo, trueAltitudeMax: hHi, azimuthMin: (az0 + azLo - mAz + 360) % 360, azimuthMax: (az0 + azHi + mAz + 360) % 360 },
    margins: { altitude: mAlt, azimuth: mAz },
    maxDistanceKm: dMax / 1000 + 1,
    referenceSpreadM: sMax,
  }
}

export interface Crossing { readonly time: string; readonly lat: number; readonly lon: number }
export interface Segment { readonly enter: Crossing; readonly exit: Crossing }
export interface SearchPass {
  readonly time: string                          // midpoint of first entry and last exit: the context below is at this instant
  readonly segments: ReadonlyArray<Segment>
  readonly standingPoint: { readonly lat: number; readonly lon: number; readonly distanceKm: number; readonly azimuth: number; readonly apparentAltitude: number; readonly angularRadius: number }
  readonly moon: { readonly az: number; readonly alt: number | null; readonly illuminated: number; readonly angularRadius: number }
  readonly sunAlt: number
  readonly sun: { readonly azimuth: number; readonly altitude: number; readonly apparentAltitude: number | null }
  readonly phase: ReturnType<typeof moonPhase>
}
export interface SearchCounters {
  scanEvaluations: number; spans: number; spanSeconds: number; trackEvaluations: number; crossings: number; refineEvaluations: number
  segments: number; anomalies: number; maxSagittaM: number
}

interface Sample { readonly t: number; readonly x: number; readonly y: number; readonly lat: number; readonly lon: number; readonly seed: Seed }
interface Seg { enter: number; exit: number; enterAt: Crossing | undefined; exitAt: Crossing | undefined; truncated: boolean }

// The search's inner loops, each in its own small function: one big function with many loops ran mostly unoptimised in V8
// (its OSR'd inner loops deopt on exit, ~250 times per 12-month scan), boxing every double (~150 MB per scan).
interface LookCtx {
  readonly src: BlockSource; readonly ref: Geodetic; readonly body: BodyName; readonly dut1: number
  readonly hLo: number; readonly hHi: number; readonly az0: number; readonly azW: number
  readonly lAlt: number; readonly lAzJ: number; readonly hJump: number
  lt: number; readonly c: SearchCounters
}
interface Look { readonly da: number; readonly dz: number; readonly jump: number }
/** The body seen from R at ms: its altitude's and azimuth's distance from the band, and the longest interval on either side
 *  of ms that provably holds no in-band instant. */
const lookAt = (k: LookCtx, ms: number): Look => {
  k.c.scanEvaluations++
  const f = frameAt(k.src, instant(ms, k.dut1), k.ref), a = apparent(k.src, f, k.body, k.lt), tp = topocentric(f, a.v)
  k.lt = a.lt
  const h = tp.altitude, da = h < k.hLo ? k.hLo - h : h > k.hHi ? h - k.hHi : 0
  const rel = (tp.azimuth - k.az0 + 360) % 360, dz = rel <= k.azW ? 0 : Math.min(rel - k.azW, 360 - rel)
  const ah = Math.abs(h), ja = da / k.lAlt, jz = ah < k.hJump ? Math.min(dz / k.lAzJ, (k.hJump - ah) / k.lAlt) : 0
  return { da, dz, jump: ja > jz ? ja : jz }
}
/** Jump where the band is provably out of reach, step `step` near it; keep the steps whose ends could both reach it. */
const scanSpans = (k: LookCtx, from: number, to: number, step: number, lAz: number): Array<[number, number]> => {
  const spans: Array<[number, number]> = []
  let open: [number, number] | undefined, has = false, pt = 0, pda = 0, pdz = 0
  for (let t = from; t <= to || open;) {
    const l = lookAt(k, t)
    if (has) {
      const dt = t - pt
      if (pda + l.da <= k.lAlt * dt && pdz + l.dz <= lAz * dt) { if (open) open[1] = t; else open = [pt, t] }
      else if (open) { spans.push(open); open = undefined }
    }
    has = true; pt = t; pda = l.da; pdz = l.dz
    t += l.jump > step ? l.jump : step
  }
  return spans
}
/** Pull each span's ends in: from an out-of-band end, [end, end ± jump) holds no in-band instant. Ends stay evaluated
 *  out-of-band instants. */
const trimSpans = (k: LookCtx, spans: Array<[number, number]>, minMs: number): void => {
  for (const sp of spans) for (let dir = 1; dir >= -1; dir -= 2) {
    let t = dir > 0 ? sp[0] : sp[1], end = t
    for (;;) {
      const j = lookAt(k, t).jump
      if (j > 0) end = t
      if (j < minMs || (dir > 0 ? t + j >= sp[1] : t - j <= sp[0])) break
      t += dir * j
    }
    if (dir > 0) sp[0] = end; else sp[1] = end
  }
}

type Gap = { readonly t: number; readonly gap: true }
type Pt = Sample | Gap
type Solve = (t: number, seed: Seed) => { x: number; y: number; lat: number; lon: number } | null
/** Samples of the track over [a, b]: chords ≤ chordM from the measured speed, then midpoints wherever it bends more than
 *  sagittaM. */
const sampleSpan = (a: number, b: number, sampleAt: (t: number, seed: Seed) => Sample | null, c: SearchCounters): Pt[] => {
  const seed: Seed = { backAz: 0, az: 0, dist: 0, slope: 0, lt: 0 }
  const xs: Pt[] = []
  let dtMs = 5000, last: Sample | null = null
  for (let t = a; ; t = Math.min(b, t + dtMs)) {
    const s = sampleAt(t, seed)
    if (s) {
      if (last) { const v = Math.hypot(s.x - last.x, s.y - last.y) / (s.t - last.t); dtMs = Math.min(30_000, Math.max(100, SEARCH.chordM / Math.max(v, 1e-9))) }
      last = s; xs.push(s)
    } else { xs.push({ t, gap: true }); Object.assign(seed, { P: undefined }) ; last = null }
    if (t >= b) break
  }
  for (let pass = 0; pass < 8; pass++) if (!bisectPass(xs, sampleAt, c)) break
  return xs
}
const bisectPass = (xs: Pt[], sampleAt: (t: number, seed: Seed) => Sample | null, c: SearchCounters): boolean => {
  let inserted = false
  for (let i = 1; i + 1 < xs.length; i++) {
    const p0 = xs[i - 1]!, p1 = xs[i]!, p2 = xs[i + 1]!
    if ("gap" in p0 || "gap" in p1 || "gap" in p2) continue
    const lx = p2.x - p0.x, ly = p2.y - p0.y, dev = Math.abs(lx * (p1.y - p0.y) - ly * (p1.x - p0.x)) / (Math.hypot(lx, ly) || 1)   // off the chord, not along it
    c.maxSagittaM = Math.max(c.maxSagittaM, dev)
    if (dev > 4 * SEARCH.sagittaM && p1.t - p0.t > 20) {
      const m0 = sampleAt((p0.t + p1.t) / 2, { ...p0.seed }), m1 = sampleAt((p1.t + p2.t) / 2, { ...p1.seed })
      xs.splice(i + 1, 0, m1 ?? { t: (p1.t + p2.t) / 2, gap: true }); xs.splice(i, 0, m0 ?? { t: (p0.t + p1.t) / 2, gap: true })
      i += 2; inserted = true
    }
  }
  return inserted
}

/** Edges bucketed by y in horizontal strips (CSR), so a chord tests only the edges of the strips it spans. */
interface EdgeIndex { readonly y0: number; readonly h: number; readonly n: number; readonly start: Int32Array; readonly items: Int32Array; readonly seen: Int32Array; gen: number; readonly cand: Int32Array }
const STRIP_EPS_M = 1e-6   // a chord's y-range is widened by this, far above the cross products' rounding, so no edge the exact test could flag is skipped
const edgeIndex = (E: Float64Array, minY: number, maxY: number): EdgeIndex => {
  const nE = E.length / 4, n = Math.max(1, Math.min(256, Math.ceil(nE / 4))), h = (maxY - minY) / n || 1
  const strip = (y: number) => Math.min(n - 1, Math.max(0, Math.floor((y - minY) / h)))
  const count = new Int32Array(n + 1)
  for (let e = 0; e < nE; e++) { const ay = E[4 * e + 1]!, by = E[4 * e + 3]!; for (let s = strip(Math.min(ay, by)), z = strip(Math.max(ay, by)); s <= z; s++) count[s + 1]!++ }
  for (let s = 0; s < n; s++) count[s + 1]! += count[s]!
  const items = new Int32Array(count[n]!), fill = count.slice(0, n)
  for (let e = 0; e < nE; e++) { const ay = E[4 * e + 1]!, by = E[4 * e + 3]!; for (let s = strip(Math.min(ay, by)), z = strip(Math.max(ay, by)); s <= z; s++) items[fill[s]!++] = e }
  return { y0: minY, h, n, start: count, items, seen: new Int32Array(nE), gen: 0, cand: new Int32Array(nE) }
}
/** The edges whose strips a chord with y in [ya, yb] touches, ascending (the order a full loop over the edges visits them). */
const candidates = (ix: EdgeIndex, ya: number, yb: number): number => {
  const g = ++ix.gen, lo = Math.min(ix.n - 1, Math.max(0, Math.floor((ya - STRIP_EPS_M - ix.y0) / ix.h))), hi = Math.min(ix.n - 1, Math.max(0, Math.floor((yb + STRIP_EPS_M - ix.y0) / ix.h)))
  let m = 0
  for (let s = lo; s <= hi; s++) for (let q = ix.start[s]!, z = ix.start[s + 1]!; q < z; q++) { const e = ix.items[q]!; if (ix.seen[e] !== g) { ix.seen[e] = g; ix.cand[m++] = e } }
  ix.cand.subarray(0, m).sort()
  return m
}
/** Crossings of the sampled track with every edge, each refined on the true track (Illinois to crossingTolM). */
const spanCuts = (xs: ReadonlyArray<Pt>, pr: PlanarRegion, bb: { minX: number; maxX: number; minY: number; maxY: number }, ix: EdgeIndex, solve: Solve, c: SearchCounters): Array<{ t: number; at: Crossing }> => {
  const E = pr.edges, cuts: Array<{ t: number; at: Crossing }> = []
  for (let i = 0; i + 1 < xs.length; i++) {
    const s0 = xs[i]!, s1 = xs[i + 1]!
    if ("gap" in s0 || "gap" in s1) {
      const s = "gap" in s0 ? s1 : s0
      if (!("gap" in s) && insidePlanar(pr, s.x, s.y)) c.anomalies++   // a gap next to an inside point would hide a boundary
      continue
    }
    if (Math.max(s0.x, s1.x) < bb.minX || Math.min(s0.x, s1.x) > bb.maxX || Math.max(s0.y, s1.y) < bb.minY || Math.min(s0.y, s1.y) > bb.maxY) continue
    const m = candidates(ix, Math.min(s0.y, s1.y), Math.max(s0.y, s1.y))
    for (let q = 0; q < m; q++) {
      const e = ix.cand[q]!, ax = E[4 * e]!, ay = E[4 * e + 1]!, ex = E[4 * e + 2]! - ax, ey = E[4 * e + 3]! - ay
      const c0 = ex * (s0.y - ay) - ey * (s0.x - ax), c1 = ex * (s1.y - ay) - ey * (s1.x - ax)
      if ((c0 > 0 && c1 > 0) || (c0 < 0 && c1 < 0)) continue
      const cx = s1.x - s0.x, cy = s1.y - s0.y
      const d0 = cx * (ay - s0.y) - cy * (ax - s0.x), d1 = cx * (ay + ey - s0.y) - cy * (ax + ex - s0.x)
      if ((d0 > 0 && d1 > 0) || (d0 < 0 && d1 < 0)) continue
      c.crossings++
      cuts.push(refineCut(s0, s1, ax, ay, ex, ey, c0, c1, solve, c))
    }
  }
  cuts.sort((p, q) => p.t - q.t)
  return cuts
}
/** Illinois on [s0.t, s1.t] for the signed distance of P(t) from the edge's line. */
const refineCut = (s0: Sample, s1: Sample, ax: number, ay: number, ex: number, ey: number, c0: number, c1: number, solve: Solve, c: SearchCounters): { t: number; at: Crossing } => {
  const len = Math.hypot(ex, ey), sd = { ...s0.seed }
  let best = { t: s0.t, lat: s0.lat, lon: s0.lon }
  const g = (t: number) => {
    c.refineEvaluations++
    const s = solve(t, sd)
    if (!s) return NaN
    best = { t, lat: s.lat, lon: s.lon }
    return (ex * (s.y - ay) - ey * (s.x - ax)) / len
  }
  let ta = s0.t, fa = c0 / len, tb = s1.t, fb = c1 / len
  if (fa === 0) best = { t: s0.t, lat: s0.lat, lon: s0.lon }
  else if (fb === 0) best = { t: s1.t, lat: s1.lat, lon: s1.lon }
  else {
    for (let it = 0; it < 60; it++) {
      const tc = tb - fb * (tb - ta) / (fb - fa), fc = g(tc)
      if (!Number.isFinite(fc)) { c.anomalies++; break }
      if (Math.abs(fc) < SEARCH.crossingTolM) break
      if (fc * fb < 0) { ta = tb; fa = fb } else fa /= 2
      tb = tc; fb = fc
      if (Math.abs(tb - ta) < SEARCH.crossingTolS * 1000) { g((ta + tb) / 2); break }
    }
  }
  return { t: best.t, at: { time: isoMs(best.t), lat: best.lat, lon: best.lon } }
}
/** Inside / outside between consecutive cuts, from the chords (linear between samples): the span's in-region segments. */
const spanSegments = (a: number, b: number, xs: ReadonlyArray<Pt>, cuts: ReadonlyArray<{ t: number; at: Crossing }>, pr: PlanarRegion, segs: Seg[], c: SearchCounters): void => {
  const stateAt = (t: number): boolean => {
    for (let i = 0; i + 1 < xs.length; i++) {
      const s0 = xs[i]!, s1 = xs[i + 1]!
      if (t < s0.t || t > s1.t) continue
      if ("gap" in s0 || "gap" in s1) return false
      const f = (t - s0.t) / (s1.t - s0.t)
      return insidePlanar(pr, s0.x + f * (s1.x - s0.x), s0.y + f * (s1.y - s0.y))
    }
    return false
  }
  const bounds = [a, ...cuts.map(k => k.t), b]
  let cur: Seg | undefined
  for (let i = 0; i + 1 < bounds.length; i++) {
    const t0 = bounds[i]!, t1 = bounds[i + 1]!
    if (t1 - t0 < 1e-6) continue
    const inside = stateAt((t0 + t1) / 2)
    if (inside && !cur) cur = { enter: t0, exit: t1, enterAt: i === 0 ? undefined : cuts[i - 1]!.at, exitAt: undefined, truncated: i === 0 }
    else if (inside && cur) cur.exit = t1
    else if (!inside && cur) { cur.exitAt = cuts[i - 1]!.at; segs.push(cur); cur = undefined }
  }
  if (cur) { c.anomalies++; cur.truncated = true; segs.push(cur) }   // span ends are outside by construction
}

/** Passes whose first entry lies in [startMs, endMs). Pure; reads only the blocks for [start − lookback, end + lookahead]. */
export const searchWindow = (src: BlockSource, inp: SearchInput): { geometry: SearchGeometry; passes: SearchPass[]; counters: SearchCounters } | { error: string } => {
  const geo = searchGeometry(inp)
  if ("error" in geo) return geo
  const T = inp.temperature ?? 10, Pr = inp.pressure ?? 1010, dut1 = inp.dut1 ?? 0
  const c: SearchCounters = { scanEvaluations: 0, spans: 0, spanSeconds: 0, trackEvaluations: 0, crossings: 0, refineEvaluations: 0, segments: 0, anomalies: 0, maxSagittaM: 0 }
  const ref: Geodetic = { lat: geo.reference.lat, lon: geo.reference.lon, height: eyeHeight(inp)(geo.reference.lat, geo.reference.lon) }
  const { trueAltitudeMin: hLo, trueAltitudeMax: hHi } = geo.band
  const az0 = geo.band.azimuthMin, azW = (geo.band.azimuthMax - geo.band.azimuthMin + 360) % 360
  // Rate bounds at R (°/ms): altitude; azimuth while |h| ≤ H (keep test: H = band + 1°; jumps: band + azJumpCapDeg).
  const W = SEARCH.earthRateDegPerH, own = SEARCH.ownRateDegPerH, sinP = Math.abs(Math.sin(ref.lat * DEG)), cosP = Math.cos(ref.lat * DEG)
  const azRate = (H: number) => (W * (sinP + cosP * Math.tan(H * DEG)) + own / Math.cos(H * DEG)) / 3.6e6
  const hBand = Math.max(Math.abs(hLo), Math.abs(hHi))
  const lAlt = (W * cosP + own) / 3.6e6, hKeep = Math.min(hBand + 1, 85), lAz = azRate(hKeep), hJump = Math.min(hBand + SEARCH.azJumpCapDeg, 85), lAzJ = azRate(hJump)
  const k: LookCtx = { src, ref, body: inp.body, dut1, hLo, hHi, az0, azW, lAlt, lAzJ, hJump, lt: 0, c }

  // 2. scan → spans, ends pulled in
  const scanFrom = inp.startMs - SEARCH.lookbackS * 1000, scanTo = inp.endMs + SEARCH.lookaheadS * 1000
  const spans = scanSpans(k, scanFrom, scanTo, SEARCH.scanStepS * 1000, lAz)
  trimSpans(k, spans, SEARCH.trimMinS * 1000)

  // 3. track and clip each span
  const pr: PlanarRegion = planarRegion(inp.region)
  const bb = pr.polygons.reduce((m, p) => ({ minX: Math.min(m.minX, p.minX), maxX: Math.max(m.maxX, p.maxX), minY: Math.min(m.minY, p.minY), maxY: Math.max(m.maxY, p.maxY) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  const idx = edgeIndex(pr.edges, bb.minY, bb.maxY)
  const ainp: AlignmentInput = { body: inp.body, target: inp.target, observerHeight: inp.observerHeight, observerHeightRef: inp.observerHeightRef, startMs: 0, endMs: 0, stepSeconds: 1, maxDistanceKm: geo.maxDistanceKm, temperature: T, pressure: Pr, dut1, aim: inp.aim }
  const solve: Solve = (t, seed) => { const p = standingPoint(src, ainp, t, seed); if (!p) return null; const [x, y] = pr.frame.toXY(p.lon, p.lat); return { x, y, lat: p.lat, lon: p.lon } }
  const sampleAt = (t: number, seed: Seed): Sample | null => { c.trackEvaluations++; const s = solve(t, seed); return s ? { t, x: s.x, y: s.y, lat: s.lat, lon: s.lon, seed: { ...seed } } : null }

  const segs: Seg[] = []
  for (const [a, b] of spans) {
    c.spans++; c.spanSeconds += (b - a) / 1000
    const xs = sampleSpan(a, b, sampleAt, c)
    const cuts = spanCuts(xs, pr, bb, idx, solve, c)
    spanSegments(a, b, xs, cuts, pr, segs, c)
  }

  // merge touching segments (a vertex hit splits nothing), drop empty ones
  segs.sort((p, q) => p.enter - q.enter)
  const merged: Seg[] = []
  for (const s of segs) {
    const m = merged[merged.length - 1]
    if (m && s.enter - m.exit < 1) { m.exit = s.exit; m.exitAt = s.exitAt; m.truncated ||= s.truncated }
    else if (s.exit - s.enter >= 1 || s.truncated) merged.push({ ...s })
  }
  c.segments = merged.length

  // 4. passes
  const groups: Seg[][] = []
  for (const s of merged) {
    const g = groups[groups.length - 1]
    if (g && s.enter - g[g.length - 1]!.exit < SEARCH.passGapS * 1000) g.push(s); else groups.push([s])
  }
  const passes: SearchPass[] = []
  for (const g of groups) {
    const first = g[0]!, lastSeg = g[g.length - 1]!
    if (first.enter < inp.startMs || first.enter >= inp.endMs) continue
    if (first.truncated || first.enter - scanFrom < SEARCH.passGapS * 1000 || scanTo - lastSeg.exit < SEARCH.passGapS * 1000 || g.some(s => s.truncated || !s.enterAt || !s.exitAt)) { c.anomalies++; continue }
    const tm = (first.enter + lastSeg.exit) / 2
    const sp = standingPoint(src, ainp, tm)
    if (!sp) { c.anomalies++; continue }
    const t = instant(tm, dut1), P: Geodetic = { lat: sp.lat, lon: sp.lon, height: sp.heightEllipsoid }, f = frameAt(src, t, P)
    const sun = topocentric(f, apparent(src, f, "sun").v), ma = apparent(src, f, "moon"), moon = topocentric(f, ma.v), phase = moonPhase(src, t)
    passes.push({
      time: isoMs(tm),
      segments: g.map(s => ({ enter: s.enterAt!, exit: s.exitAt! })),
      standingPoint: { lat: sp.lat, lon: sp.lon, distanceKm: sp.distanceKm, azimuth: sp.azimuth, apparentAltitude: sp.apparentAltitude, angularRadius: sp.angularRadius },
      moon: { az: moon.azimuth, alt: moon.altitude < REFRACTION_FLOOR - 1 ? null : refractTrue(moon.altitude, T, Pr), illuminated: phase.illuminatedFraction, angularRadius: Math.asin(1737.4 / ma.distanceKm) / DEG },
      sunAlt: sun.altitude,
      sun: { azimuth: sun.azimuth, altitude: sun.altitude, apparentAltitude: apparentAltitudeOf(sun.altitude, T, Pr, REFRACTION_FLOOR) },
      phase,
    })
    if (passes.length > SEARCH.maxPassesPerWindow) return { error: `more than ${SEARCH.maxPassesPerWindow} passes in one ${SEARCH.windowDays}-day window: use a smaller region` }
  }
  return { geometry: geo, passes, counters: c }
}

/** The window grid: [k·30 d, (k + 1)·30 d) since 1970-01-01T00:00Z. */
export const WINDOW_MS = SEARCH.windowDays * 86_400_000
export const windowsFor = (startMs: number, endMs: number): number[] => {
  const out: number[] = []
  for (let k = Math.floor(startMs / WINDOW_MS); k * WINDOW_MS < endMs; k++) out.push(k * WINDOW_MS)
  return out
}
/** DE440 time range a window reads: the window plus its lookback and lookahead. */
export const windowReadRange = (windowStartMs: number) => ({ fromMs: windowStartMs - SEARCH.lookbackS * 1000, toMs: windowStartMs + WINDOW_MS + SEARCH.lookaheadS * 1000 + 86_400_000 })
