// /track: the Sun's and Moon's azimuth, true and apparent altitude at every point of a UTC grid, as a pure function of
// (blocks, request). Each sample is exactly /position's sun/moon azimuth, altitude and apparentAltitude at that instant
// (same frame, light-time, aberration and refraction calls), without the rates, ecliptic coordinates and phase that /position
// adds, so a sample costs ~1/3 of a position. Columnar output: sample i is at startMs + i·stepMs.
import type { BlockSource, BodyName } from "./ephemeris.ts"
import { type Geodetic, apparent, frameAt, topocentric } from "./observe.ts"
import { apparentAltitudeOf } from "./horizon.ts"
import { instant } from "./time.ts"

/** Bounds (CPU and blocks): at most this many samples, over at most this span. 1 441 = 24 h at 60 s or 20 days at 20 min. */
export const TRACK_MAX_POINTS = 1441
export const TRACK_MAX_SPAN_MS = 8 * 86_400_000
export const TRACK_MIN_STEP_S = 60
export const TRACK_MAX_STEP_S = 3600
export const TRACK_DEFAULT_STEP_S = 1200

export interface TrackInput {
  readonly startMs: number; readonly endMs: number; readonly stepMs: number; readonly geo: Geodetic
  readonly temperature: number; readonly pressure: number; readonly horizon: number; readonly dut1?: number | undefined
}
export interface BodyTrack { readonly azimuth: number[]; readonly altitude: number[]; readonly apparentAltitude: Array<number | null> }

/** Why a window is not a valid track window, or undefined. Start and end must lie on the UTC grid of the step (multiples of
 *  stepMs since 1970-01-01T00:00Z), so equal questions are equal cache keys. */
export const trackWindowError = (startMs: number, endMs: number, stepS: number): string | undefined => {
  const stepMs = stepS * 1000
  if (!Number.isInteger(stepS) || stepS < TRACK_MIN_STEP_S || stepS > TRACK_MAX_STEP_S) return `stepSeconds must be an integer from ${TRACK_MIN_STEP_S} to ${TRACK_MAX_STEP_S}`
  if (endMs < startMs) return "end must not be before start"
  if (startMs % stepMs !== 0 || endMs % stepMs !== 0) {
    const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z")
    return `start and end must lie on the UTC ${stepS} s grid (e.g. start=${iso(Math.floor(startMs / stepMs) * stepMs)}, end=${iso(Math.ceil(endMs / stepMs) * stepMs)})`
  }
  if (endMs - startMs > TRACK_MAX_SPAN_MS) return `start…end spans ${((endMs - startMs) / 86_400_000).toFixed(2)} days; at most ${TRACK_MAX_SPAN_MS / 86_400_000} days per request`
  if ((endMs - startMs) / stepMs + 1 > TRACK_MAX_POINTS) return `${(endMs - startMs) / stepMs + 1} samples; at most ${TRACK_MAX_POINTS} per request (span / stepSeconds + 1): raise stepSeconds or shorten start…end`
  return undefined
}

export const track = (src: BlockSource, q: TrackInput): { count: number; sun: BodyTrack; moon: BodyTrack } => {
  const count = Math.round((q.endMs - q.startMs) / q.stepMs) + 1
  const out = { sun: { azimuth: [], altitude: [], apparentAltitude: [] } as BodyTrack, moon: { azimuth: [], altitude: [], apparentAltitude: [] } as BodyTrack }
  for (let i = 0; i < count; i++) {
    const f = frameAt(src, instant(q.startMs + i * q.stepMs, q.dut1 ?? 0), q.geo)
    for (const body of ["sun", "moon"] as const satisfies ReadonlyArray<BodyName>) {
      const tp = topocentric(f, apparent(src, f, body).v), b = out[body]
      b.azimuth.push(tp.azimuth); b.altitude.push(tp.altitude); b.apparentAltitude.push(apparentAltitudeOf(tp.altitude, q.temperature, q.pressure, q.horizon))
    }
  }
  return { count, ...out }
}
