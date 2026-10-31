// The homepage's derived models, pure functions of its state: no DOM, no timers, no fetch. The server runs them to render the
// first frame (src/client/home/frame.ts); the browser runs the same ones afterwards, so the two agree by construction.
import { chartCenter, chX, chY, chartGeom, skyModel, type ChartBody, type ChartModel } from "../../lib/chart.ts"
import { layoutLabels, overlaps, isPlaced, type Laid, type Rect } from "../../lib/labels.ts"
import { DIN_ADV } from "../../lib/din-metrics.ts"
import { halfPx, timelineLayout, tlX, type TlEvent } from "../../lib/timeline.ts"
import { evName } from "../../lib/words.ts"
import { hm, localDate } from "../../lib/time.ts"
import { wrap360 } from "../../lib/angles.ts"
import type { Day, DayEvent, Position, Track } from "../../lib/types.ts"
import { DAYS, day, loc, pose, tomorrow, track, type Strip, type TrackRow } from "./state.ts"

/** /v1/track's columns as rows. */
export const trackRows = (r: Track): TrackRow[] => {
  const out: TrackRow[] = [],
    step = r.stepSeconds * 1000,
    s0 = Date.parse(r.start)
  const b = (x: Track["sun"], i: number) => ({
    azimuth: x.azimuth[i]!,
    altitude: x.altitude[i]!,
    apparentAltitude: x.apparentAltitude[i] ?? null,
  })
  for (let i = 0; i < r.count; i++) out.push({ t: s0 + i * step, sun: b(r.sun, i), moon: b(r.moon, i) })
  return out
}
/** The default frame: centred between the bodies (or where the phone points). */
export const defaultCenter = (p: Position): number => {
  const ps = pose.peek()
  return ps ? ps.az : chartCenter(loc.peek().lat, [p.sun.azimuth, p.moon.azimuth])
}

const MAIN = (e: DayEvent) =>
  e.kind === "rise" || e.kind === "set" || e.kind === "transit" || /Dawn|Dusk|HourStart/.test(e.kind)
/** Today's and tomorrow's main events after t. */
export const upcoming = (t: number): DayEvent[] =>
  [...(day.peek()?.events ?? []), ...(tomorrow.peek()?.events ?? [])].filter(MAIN).filter((e) => Date.parse(e.time) > t)
export const nextEvent = (t: number) => {
  const up = upcoming(t)
  return up.length ? { body: up[0]!.body, kind: up[0]!.kind, t: Date.parse(up[0]!.time) } : null
}

// ---------- the timeline ----------
// The window: now − 3 h … now + 21 h (now at an eighth: what is next, and a little of what just happened; re-anchored every
// minute), from every local day it touches.
const TL_BACK = 3 * 3600e3,
  TL_SPAN = 24 * 3600e3
/** The timeline laid out at width w (px) around `anchor` (the live instant), with the scrubbed instant `t`. `dayFor` supplies a
 *  local day the page has not got yet (the browser's compute), or undefined. */
export const computeStrip = (
  w0: number,
  anchor: number,
  t: number,
  dayFor: (date: string) => Day | undefined,
): Strip | null => {
  const d = day.peek()
  if (!d || d.loading) return null
  const w = Math.max(300, Math.round(w0 || 1000)),
    s0 = Math.floor((anchor - TL_BACK) / 60e3) * 60e3,
    span = TL_SPAN,
    tz = loc.peek().tz
  const evs: TlEvent[] = [],
    seen = new Set<string>()
  for (let u = s0; u <= s0 + span + 12 * 3600e3; u += 12 * 3600e3) {
    const date = localDate(Math.min(u, s0 + span), tz)
    if (seen.has(date)) continue
    seen.add(date)
    const r = DAYS.get(date) ?? dayFor(date)
    if (r) {
      DAYS.set(date, r)
      for (const e of r.events) {
        const te = Date.parse(e.time)
        if (te >= s0 && te <= s0 + span) evs.push({ body: e.body, kind: e.kind, t: te })
      }
    }
  }
  const sun = track
    .peek()
    .filter((x) => x.t >= s0 - 20 * 60e3 && x.t <= s0 + span + 20 * 60e3)
    .map((x) => ({ t: x.t, alt: x.sun.altitude }))
  const k = w >= 700 ? 1.25 : 1
  const L = timelineLayout(
    evs,
    sun,
    s0,
    span,
    w,
    t,
    nextEvent(t),
    (e) => evName(e).toUpperCase(),
    (x) => hm(x, tz),
    (s, kind) => Math.ceil(s.length * (kind === "name" ? 6.4 : 6.6) * k) + 4,
    k,
  )
  return { L, w, anchor, s0, span, k }
}
/** The NOW marker's x (null: off the window) and the scrub cursor's (null: live). */
export const stripMarks = (s: Strip, anchor: number, t: number, scrubbed: boolean) => ({
  now: anchor >= s.s0 && anchor <= s.s0 + s.span ? halfPx(tlX(s.s0, s.span, s.w, anchor)) : null,
  scrub: scrubbed ? halfPx(tlX(s.s0, s.span, s.w, t)) : null,
})

// ---------- the chart ----------
const PERIOD = { sun: 864e5, moon: 89428e3 } as const // a solar day; a mean lunar day, 24 h 50 min 28 s
/** Desktop: the chart's type a size up (labels 12.5 px, compass 12 px). */
export const wide = (W: number) => W >= 900
/** A text's width (px) in Ephem DIN bold at `size` px with `spacing` px letter-spacing after each character, from the font's
 *  own advances: the server and the browser lay out the same, before and after the font has loaded. */
export const textWidth = (t: string, size: number, spacing: number): number =>
  [...t].reduce((w, c) => w + ((DIN_ADV.b[c] ?? 600) / 1000) * size + spacing, 0)
const labelW = (t: string, W: number) => Math.ceil(textWidth(t.toUpperCase(), wide(W) ? 12.5 : 10.5, 1.6)) + 2 + 10

/** The live position: the answer moved on by its own rates (deg/min) to t (none when the page clock is frozen). */
export const livePos = (p: Position, t: number, frozen: boolean) => {
  const dt = frozen || !p.time ? 0 : (t - Date.parse(p.time.utc)) / 60e3
  const mv = (b: Position["sun"]) => ({
    az: wrap360(b.azimuth + (b.azimuthRate || 0) * dt),
    alt: Math.max(-90, Math.min(90, b.altitude + (b.altitudeRate || 0) * dt)),
  })
  return { sun: mv(p.sun), moon: mv(p.moon) }
}
export interface ChartFrame {
  readonly m: ChartModel
  readonly placed: Laid[]
  readonly c: number
  readonly sunAlt: number
  readonly p: Position | null
  readonly bodies: ReadonlyArray<ChartBody>
}
/** The chart as drawn at instant t: geometry (lib/chart.ts skyModel), the labels' layout, the frame centre. */
export const chartFrame = (o: {
  readonly W: number
  readonly H: number
  readonly insetL: number
  readonly insetR: number
  readonly center: number | null
  readonly t: number
  readonly frozen: boolean
  readonly ctl: Rect | null
  readonly p: Position | null
  readonly rows: ReadonlyArray<TrackRow>
}): ChartFrame => {
  const live = o.p ? livePos(o.p, o.t, o.frozen) : null,
    c = o.center ?? (loc.peek().lat >= 0 ? 180 : 0)
  const bodies: ChartBody[] = live
    ? (["sun", "moon"] as const).map((key) => {
        const L = live[key],
          pts = o.rows.map((x) => ({ t: x.t, az: x[key].azimuth, alt: x[key].altitude }))
        let at = pts.findIndex((x) => x.t > o.t)
        if (at < 0) at = pts.length
        pts.splice(at, 0, { t: o.t, az: L.az, alt: L.alt })
        return {
          key,
          name: key === "sun" ? "Sun" : "Moon",
          az: L.az,
          alt: L.alt,
          r: key === "moon" ? 6 : 5,
          pts: o.rows.length ? pts : [],
          nowIdx: at,
          period: PERIOD[key],
        }
      })
    : []
  const m = skyModel({
    W: o.W,
    H: o.H,
    insetL: o.insetL,
    insetR: o.insetR,
    center: c,
    now: o.t,
    ctl: o.ctl,
    pose: pose.peek(),
    lh: wide(o.W) ? 20 : 17,
    bodies,
    meas: (t) => labelW(t, o.W),
  })
  return {
    m,
    placed: layoutLabels(m.items, m.hard, m.segs, m.bounds, 3),
    c,
    sunAlt: live ? live.sun.alt : -30,
    p: o.p,
    bodies,
  }
}
/** The harnesses' view of a frame (window.__sky: scripts/obs/home-states.ts). */
export const skyDebug = (f: ChartFrame, W: number, H: number, draws: number) => ({
  labels: f.placed,
  hard: f.m.hard,
  lines: f.m.lines,
  W,
  H,
  draws,
  overlaps: overlaps(
    f.placed
      .filter(isPlaced)
      .map((x) => ({ text: true, ...x }))
      .concat(f.m.hard.filter((h) => /disc|pose|ctl/.test(h.id ?? "")) as never[]),
  ),
})
/** Where each live marker sits (px), to tell whether a tick moved one visibly. */
export const markerPx = (f: ChartFrame, W: number, H: number) => {
  const g = chartGeom(W, H, 0, 0)
  return f.bodies.map((b) => [chX(b.az, g, f.c), chY(b.alt, g)] as const)
}

/** The first frame's chart size for a phone or a desktop (the server cannot know the viewport; the browser measures and
 *  corrects after it hydrates, and on the nominal sizes there is nothing to correct): the .sky box is the full width by
 *  clamp(250px, 40svh, 540px) (phones) or min(56vh, 45vw) (≥ 900 px). Phone: 390 × 844; desktop: 1440 × 900. */
export const nominalFrame = (mobile: boolean) =>
  mobile
    ? { W: 390, H: 337.6, strip: 358, mobile } // clamp(250, 0.4 × 844, 540); 390 − 2 × 16 gutter
    : { W: 1440, H: 504, strip: 1080, mobile } // min(0.56 × 900, 0.45 × 1440); the 1 080 px column
/** The corner buttons' rect when only the point button shows (a phone's first frame). */
export const pointRect = (W: number): Rect => ({ id: "ctl", x: W - 44, y: 0, w: 44, h: 44 })
