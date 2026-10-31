// Browser vs server, field by field, before the browser takes over the sky: the largest difference in degrees (angles, rates
// in deg/min, RA in degrees), km and ms, plus every structural mismatch. Pure; test/parity.test.ts.
import { wrap180 } from "./angles.ts"
import type { Day, Position, Track } from "./types.ts"

export interface PosDiff { deg: number; km: number; n: number; readonly bad: string[] }
export interface TrackDiff { deg: number; n: number; readonly bad: string[] }
export interface DayDiff { ms: number; n: number; readonly bad: string[] }

const FIELDS = ["azimuth", "altitude", "apparentAltitude", "altitudeRate", "azimuthRate", "rightAscension", "declination", "distanceKm", "angularRadius", "eclipticLongitude", "eclipticLatitude"] as const
const PHASE = ["phaseAngle", "illuminatedFraction", "elongation", "brightLimbAngle"] as const

export const diffPos = (a: Position, b: Position): PosDiff => {
  const m: PosDiff = { deg: 0, km: 0, n: 0, bad: [] }
  const d = (x: number | null | undefined, y: number | null | undefined, k: string) => {
    if (x == null || y == null) { if (x !== y) m.bad.push(k); return }
    m.n++
    const ra = k.includes("rightAscension") ? 15 : 1
    const v = Math.abs(k.includes("azimuth") || /ongitude|Angle|elongation|rightAscension/.test(k) ? wrap180((x - y) * ra) : (x - y) * ra)
    if (/distanceKm/.test(k)) m.km = Math.max(m.km, v); else m.deg = Math.max(m.deg, v)
  }
  for (const k of ["sun", "moon"] as const) for (const f of FIELDS) d(a[k][f], b[k][f], k + "." + f)
  for (const f of PHASE) d(a.moon.phase[f], b.moon.phase[f], "moon.phase." + f)
  if (a.moon.phase.name !== b.moon.phase.name) m.bad.push("moon.phase.name")
  d(a.moon.brightLimbAngleFromVertical, b.moon.brightLimbAngleFromVertical, "moon.brightLimbAngleFromVertical")
  return m
}
/** The API's samples sit at index (api.start − mine.start) / step of ours. */
export const diffTrack = (api: Track, mine: Track): TrackDiff => {
  const off = Math.round((Date.parse(api.start) - Date.parse(mine.start)) / (mine.stepSeconds * 1000)), m: TrackDiff = { deg: 0, n: 0, bad: [] }
  for (let i = 0; i < api.count; i++) for (const k of ["sun", "moon"] as const) for (const f of ["azimuth", "altitude", "apparentAltitude"] as const) {
    const x = api[k][f][i], y = mine[k][f][i + off]
    if (x == null || y == null) { if (x !== y) m.bad.push(k + "." + f + "[" + i + "]"); continue }
    m.n++
    m.deg = Math.max(m.deg, Math.abs(f === "azimuth" ? wrap180(x - y) : x - y))
  }
  return m
}
export const diffDay = (api: Day, mine: Day): DayDiff => {
  const m: DayDiff = { ms: 0, n: 0, bad: [] }
  if (api.events.length !== mine.events.length) m.bad.push("events " + api.events.length + " vs " + mine.events.length)
  else api.events.forEach((e, i) => {
    const f = mine.events[i]!
    if (e.body !== f.body || e.kind !== f.kind) m.bad.push(e.body + "." + e.kind)
    else { m.n++; m.ms = Math.max(m.ms, Math.abs(Date.parse(e.time) - Date.parse(f.time))) }
  })
  return m
}
/** The takeover's bars: far inside the accuracy bars (V8 and JavaScriptCore may differ in Math's last bit). */
export const PARITY_TOL = { deg: 1e-9, km: 1e-6, ms: 1 } as const
export const parityOk = (p: { readonly pos: PosDiff; readonly track?: TrackDiff | undefined; readonly day?: DayDiff | undefined }): boolean =>
  !p.pos.bad.length && !(p.track?.bad.length) && !(p.day?.bad.length) && p.pos.deg < PARITY_TOL.deg && p.pos.km < PARITY_TOL.km &&
  (!p.track || p.track.deg < PARITY_TOL.deg) && (!p.day || p.day.ms <= PARITY_TOL.ms)
