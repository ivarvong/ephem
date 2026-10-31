// The sky chart as geometry: all 360° of azimuth by the whole altitude range, zenith to nadir. Pure (no canvas), so
// test/chart.test.ts runs it over every sky state; src/og.ts (the link-preview card) is a port of it, tested against it.
import { wrap180, wrap360 } from "./angles.ts"
import type { LabelItem, Rect, Seg, Bounds } from "./labels.ts"

/** Altitude to chart units, smooth everywhere: linear above the horizon (y = alt), and below it a tanh compression with the
 *  same slope at 0° (s·tanh(alt/s): C2 at the horizon, no kink anywhere), so a track keeps its true sinusoid-like shape.
 *  s = 36: -18° maps to -16.6, -90° to -35.5 (the ground holds the whole depth). The chart draws TRUE (geometric) altitude,
 *  for tracks and markers alike: refraction is at most 0.57° (about 1.5 px here); every number on the page is the API's. */
export const DEPTH_S = 36
export const altU = (alt: number): number => {
  const a = Math.max(-90, Math.min(90, alt))
  return a >= 0 ? a : DEPTH_S * Math.tanh(a / DEPTH_S)
}
export const U_TOP = 90
export const U_BOT = altU(-90)

/** A continuous azimuth sequence (no 360° jumps), so a track crosses the chart's seam as one line. */
export const unwrapAz = (azs: ReadonlyArray<number>): number[] => {
  const out: number[] = []
  let prev: number | null = null
  for (const az of azs) {
    const a: number = prev == null ? az : prev + wrap180(az - prev)
    out.push(a)
    prev = a
  }
  return out
}
/** The default frame shows all 360°, centred between the two bodies (the middle of the shorter arc from one to the other, to
 *  the degree), so both sit well inside the frame and the seam (centre ± 180°) falls where neither is. */
export const chartCenter = (lat: number, azs: ReadonlyArray<number>): number => {
  if (azs.length < 2) return wrap360(Math.round(azs[0] == null ? (lat >= 0 ? 180 : 0) : azs[0]))
  return wrap360(Math.round(azs[0]! + wrap180(azs[1]! - azs[0]!) / 2))
}

export interface TrackSample {
  readonly t: number
  readonly alt: number
  readonly az: number
}
export interface TrackEvent {
  readonly kind: "rise" | "set" | "transit" | "antitransit"
  readonly t: number
  readonly az: number
  readonly alt: number
}
/** Horizon crossings and culminations from track samples (true altitude): h0 is the centre's true altitude at rise/set.
 *  Crossings interpolate linearly between samples; transit and anti-transit take the vertex of a parabola through three
 *  samples. Times are within a minute or so; the page prefers /v1/day's exact time when it has one. */
export const trackEvents = (s: ReadonlyArray<TrackSample>, h0: number): TrackEvent[] => {
  const out: TrackEvent[] = [],
    az = unwrapAz(s.map((p) => p.az))
  for (let i = 1; i < s.length; i++) {
    const p0 = s[i - 1]!,
      p1 = s[i]!,
      a = p0.alt - h0,
      b = p1.alt - h0
    if (a < 0 !== b < 0) {
      const f = a / (a - b)
      out.push({
        kind: b > a ? "rise" : "set",
        t: p0.t + f * (p1.t - p0.t),
        az: wrap360(az[i - 1]! + f * (az[i]! - az[i - 1]!)),
        alt: h0,
      })
    }
    if (i < s.length - 1) {
      const y0 = p0.alt,
        y1 = p1.alt,
        y2 = s[i + 1]!.alt
      if ((y1 > y0 && y1 >= y2) || (y1 < y0 && y1 <= y2)) {
        const den = y0 - 2 * y1 + y2,
          v = den ? Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / den)) : 0
        const azv = v >= 0 ? az[i]! + v * (az[i + 1]! - az[i]!) : az[i]! + v * (az[i]! - az[i - 1]!)
        out.push({
          kind: y1 > y0 ? "transit" : "antitransit",
          t: p1.t + v * (p1.t - p0.t),
          az: wrap360(azv),
          alt: y1 - 0.25 * (y0 - y2) * v,
        })
      }
    }
  }
  return out.sort((x, y) => x.t - y.t)
}

export const CH_TOP = 14,
  CH_AXIS = 20
export interface Geom {
  readonly W: number
  readonly H: number
  readonly kx: number
  readonly ky: number
  readonly top: number
  readonly hy: number
  readonly bot: number
  readonly x0: number
  readonly x1: number
}
export const chartGeom = (W: number, H: number, insetL = 0, insetR = 0): Geom => {
  const ky = (H - CH_TOP - CH_AXIS) / (U_TOP - U_BOT)
  return {
    W,
    H,
    kx: W / 360,
    ky,
    top: CH_TOP,
    hy: Math.round(CH_TOP + U_TOP * ky) + 0.5,
    bot: H - CH_AXIS,
    x0: 4 + insetL,
    x1: W - 4 - insetR,
  }
}
export const chX = (az: number, g: Geom, c: number): number => g.W / 2 + wrap180(az - c) * g.kx
export const chY = (alt: number, g: Geom): number => g.top + (U_TOP - altU(alt)) * g.ky
/** Every x where azimuth az is on screen (the frame wraps). */
export const chXs = (az: number, g: Geom, c: number): number[] => {
  const x = chX(az, g, c),
    r = [x],
    s = 360 * g.kx
  if (x - s >= -40) r.push(x - s)
  if (x + s <= g.W + 40) r.push(x + s)
  return r
}

/** A smooth curve through the samples: centripetal Catmull-Rom (alpha 0.5: no cusps, no overshoot loops), as the cubic
 *  Bezier control points of the piece from sample i to i + 1 (the ends reuse their neighbours). */
export const crBezier = (
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>,
  i: number,
): [number, number, number, number] => {
  const n = xs.length,
    i0 = Math.max(0, i - 1),
    i3 = Math.min(n - 1, i + 2)
  const p0 = [xs[i0]!, ys[i0]!],
    p1 = [xs[i]!, ys[i]!],
    p2 = [xs[i + 1]!, ys[i + 1]!],
    p3 = [xs[i3]!, ys[i3]!]
  const dist = (a: number[], b: number[]) => Math.pow(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!), 0.5)
  const d1 = dist(p0, p1),
    d2 = dist(p1, p2),
    d3 = dist(p2, p3),
    b1 = p1.slice(),
    b2 = p2.slice()
  if (d1 > 1e-6 && d2 > 1e-6)
    for (let k = 0; k < 2; k++)
      b1[k] =
        (d1 * d1 * p2[k]! - d2 * d2 * p0[k]! + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1[k]!) / (3 * d1 * (d1 + d2))
  if (d3 > 1e-6 && d2 > 1e-6)
    for (let k = 0; k < 2; k++)
      b2[k] =
        (d3 * d3 * p1[k]! - d2 * d2 * p3[k]! + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2[k]!) / (3 * d3 * (d3 + d2))
  return [b1[0]!, b1[1]!, b2[0]!, b2[1]!]
}

export interface SpanPoint {
  readonly t: number
  readonly rel: number
  readonly alt: number
  readonly edge?: true
}
/**
 * One revolution of a body's track around now, ending on the frame's seam (centre ± 180°), so both ends sit at the frame's
 * edges and never mid-sky. pts: samples in time order with now at nowIdx; period: the body's day (ms). The azimuth is
 * unwrapped outward from now, relative to the centre; walking back and forward, the first sample past ±180° is cut there
 * (interpolated onto the edge). A body whose azimuth does not go all the way round (|dec| > |lat|, same side) gets one period
 * centred on now instead, cut at its lowest points. Returns one polyline, now included, rel in [-180, 180].
 */
export const trackSpan = (
  pts: ReadonlyArray<TrackSample>,
  nowIdx: number,
  center: number,
  period: number,
): SpanPoint[] => {
  const n = pts.length,
    rel: number[] = Array.from({ length: n }, () => 0),
    t0 = pts[nowIdx]!.t
  rel[nowIdx] = wrap180(pts[nowIdx]!.az - center)
  for (let i = nowIdx + 1; i < n; i++) rel[i] = rel[i - 1]! + wrap180(pts[i]!.az - pts[i - 1]!.az)
  for (let i = nowIdx - 1; i >= 0; i--) rel[i] = rel[i + 1]! + wrap180(pts[i]!.az - pts[i + 1]!.az)
  const walk = (dir: 1 | -1, limit: number): SpanPoint[] => {
    const res: SpanPoint[] = []
    for (let j = nowIdx + dir; j >= 0 && j < n; j += dir) {
      const pj = j - dir,
        r = rel[j]!
      if (Math.abs(r) >= 180) {
        const e = r > 0 ? 180 : -180,
          f = (e - rel[pj]!) / (r - rel[pj]!)
        res.push({
          t: pts[pj]!.t + f * (pts[j]!.t - pts[pj]!.t),
          rel: e,
          alt: pts[pj]!.alt + f * (pts[j]!.alt - pts[pj]!.alt),
          edge: true,
        })
        return res
      }
      if (Math.abs(pts[j]!.t - t0) > limit) return res
      res.push({ t: pts[j]!.t, rel: r, alt: pts[j]!.alt })
    }
    return res
  }
  const back = walk(-1, period * 1.05),
    fwd = walk(1, period * 1.05)
  const round = back.length && back[back.length - 1]!.edge && fwd.length && fwd[fwd.length - 1]!.edge
  if (round) return back.reverse().concat([{ t: t0, rel: rel[nowIdx]!, alt: pts[nowIdx]!.alt }], fwd)
  // Not all the way round: the loop closes on itself. Cut it at its lowest point (lower culmination, deep in the compressed
  // ground), from the last one before now to the next, so the day's declination drift shows only there.
  let lo = -1,
    hi = -1
  for (let j = 0; j < n; j++) {
    const dt = pts[j]!.t - t0
    if (dt <= 0 && dt > -period && (lo < 0 || pts[j]!.alt < pts[lo]!.alt)) lo = j
    if (dt >= 0 && dt < period && (hi < 0 || pts[j]!.alt < pts[hi]!.alt)) hi = j
  }
  const out: SpanPoint[] = []
  for (let j = Math.max(0, lo); j <= (hi < 0 ? n - 1 : hi); j++)
    out.push({ t: pts[j]!.t, rel: rel[j]!, alt: pts[j]!.alt })
  return out
}

/** A pass within ~10° of the zenith swings the azimuth through ~180° in minutes: in an azimuth × altitude chart the track
 *  climbs a vertical side, runs flat along the top and drops down the other. Above 80° that stretch is drawn as a
 *  half-ellipse from where the track crosses 80° on the way up to where it does on the way down, its top at the pass's
 *  highest altitude. The vertices are rewritten in place; returns the point for now if now falls inside the arc. */
export const zenithArc = (
  sp: ReadonlyArray<SpanPoint>,
  xs: number[],
  ys: number[],
  g: Geom,
  now: number,
): [number, number] | null => {
  let hit: [number, number] | null = null
  for (let i = 0; i < sp.length; i++) {
    if (sp[i]!.alt <= 80) continue
    const a = i
    let z = i
    while (z + 1 < sp.length && sp[z + 1]!.alt > 80) z++
    i = z
    if (a === 0 || z === sp.length - 1 || Math.abs(sp[z]!.rel - sp[a]!.rel) < 30) continue // not a swing (or cut by the frame)
    const p = a - 1,
      q = z + 1,
      top = Math.max(...sp.slice(a, z + 1).map((s) => s.alt))
    const x0 = xs[p]!,
      x1 = xs[q]!,
      yb = (ys[p]! + ys[q]!) / 2,
      yt = chY(top, g),
      t0 = sp[p]!.t,
      t1 = sp[q]!.t
    const at = (t: number): [number, number] => {
      const u = (t - t0) / (t1 - t0),
        th = Math.PI * u
      return [(x0 + x1) / 2 - ((x1 - x0) / 2) * Math.cos(th), yb - (yb - yt) * Math.sin(th)]
    }
    for (let j = a; j <= z; j++) {
      const pt = at(sp[j]!.t)
      xs[j] = pt[0]
      ys[j] = pt[1]
    }
    if (now >= t0 && now <= t1) hit = at(now)
  }
  return hit
}

export type BodyKey = "sun" | "moon"
export interface ChartBody {
  readonly key: BodyKey
  readonly name: string
  readonly az: number
  readonly alt: number
  readonly r: number
  readonly pts: ReadonlyArray<TrackSample>
  readonly nowIdx: number
  readonly period: number
}
export interface ChartInput {
  readonly W: number
  readonly H: number
  readonly insetL: number
  readonly insetR: number
  readonly center: number
  readonly now: number
  readonly ctl: Rect | null
  readonly pose: { readonly az: number; readonly alt: number } | null
  readonly meas: (text: string) => number
  readonly lh: number
  readonly bodies: ReadonlyArray<ChartBody>
}
export interface Line {
  readonly xs: number[]
  readonly ys: number[]
  readonly split: number
}
/** A body's marker. `xs`: every x it is drawn at: the frame is all 360°, so a body within its glow of an edge also shows at the
 *  opposite edge (the wrapped copy; before 2026-10-31 a Moon at the seam was drawn half clipped at one edge only). */
export interface Disc {
  readonly key: BodyKey
  readonly x: number
  readonly xs: ReadonlyArray<number>
  readonly y: number
  readonly r: number
  readonly below: boolean
}
/** How far a body's drawing reaches from its centre, in radii: the disc's glow (the Sun's is 4, the Moon's 3.2). */
export const GLOW = { sun: 4, moon: 3.2 } as const
/** Every x a marker at x with this reach (px) is visible at in a frame W px wide spanning 360°: x, and its copy one frame
 *  away when the marker reaches past an edge. */
export const wrapXs = (x: number, reach: number, W: number): number[] => {
  const out = [x]
  if (x + reach > W) out.push(x - W)
  if (x - reach < 0) out.push(x + W)
  return out
}
export interface ChartModel {
  readonly g: Geom
  readonly lines: Partial<Record<BodyKey, Line>>
  readonly discs: Disc[]
  readonly hard: Rect[]
  readonly segs: Seg[]
  readonly items: LabelItem[]
  readonly bounds: Bounds
  readonly pose?: { readonly x: number; readonly y: number }
}
/** The chart as geometry: tracks (screen polylines split at now), discs, and one label per body (its name), laid out clear of
 *  every track, disc and button by layoutLabels. */
export const skyModel = (st: ChartInput): ChartModel => {
  const g = chartGeom(st.W, st.H, st.insetL, st.insetR),
    c = st.center
  const lines: Partial<Record<BodyKey, Line>> = {},
    discs: Disc[] = [],
    hard: Rect[] = [],
    segs: Seg[] = [],
    items: LabelItem[] = []
  let pose: { x: number; y: number } | undefined
  if (st.ctl) hard.push(st.ctl)
  if (st.pose) {
    const px = chX(st.pose.az, g, c),
      py = chY(st.pose.alt, g)
    pose = { x: px, y: py }
    hard.push({ id: "pose", x: px - 16, y: py - 16, w: 32, h: 32 })
  }
  hard.push({ id: "horizon", x: -1e4, y: g.hy - 1, w: 2e4, h: 2 })
  for (const b of st.bodies) {
    let arc: [number, number] | null = null
    if (b.pts.length > 1) {
      const sp = trackSpan(b.pts, b.nowIdx, c, b.period),
        xs: number[] = [],
        ys: number[] = []
      let split = 0
      sp.forEach((q, i) => {
        xs.push(g.W / 2 + q.rel * g.kx)
        ys.push(chY(q.alt, g))
        if (q.t <= st.now) split = i
      })
      arc = zenithArc(sp, xs, ys, g, st.now)
      lines[b.key] = { xs, ys, split }
      for (let i = 1; i < xs.length; i++) segs.push([xs[i - 1]!, ys[i - 1]!, xs[i]!, ys[i]!])
    }
    const bx = arc ? arc[0] : chX(b.az, g, c),
      by = arc ? arc[1] : chY(b.alt, g),
      rr = b.r + 4
    const xs = wrapXs(bx, b.r * GLOW[b.key], 360 * g.kx)
    discs.push({ key: b.key, x: bx, xs, y: by, r: b.r, below: b.alt < 0 })
    xs.forEach((x, i) =>
      hard.push({ id: b.key + "-disc" + (i ? "-wrap" : ""), x: x - rr, y: by - rr, w: 2 * rr, h: 2 * rr }),
    )
    items.push({ id: b.name, t: b.name, w: st.meas(b.name), h: st.lh, x: bx, y: by, r: rr - 2, prio: 0, body: true })
  }
  return {
    g,
    lines,
    discs,
    hard,
    segs,
    items,
    bounds: { x0: g.x0, y0: 2, x1: g.x1, y1: g.bot - 1 },
    ...(pose ? { pose } : {}),
  }
}
